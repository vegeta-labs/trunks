// TC-OUT-09 / tech design §3.1 / rules D12: no mailbox-write or send call anywhere in the source.
// AST scan with the TypeScript compiler; it never runs the code.
import ts from 'typescript'

export interface Finding {
  file: string
  line: number
  rule: string
}

// Gmail API write methods (users.messages.*, users.drafts.*, threads, labels)
const GMAIL_WRITES = new Set(['send', 'insert', 'import', 'modify', 'batchModify', 'batchDelete', 'delete', 'trash', 'untrash'])
// Graph paths that send or write mail
const GRAPH_PATHS = /\/(sendMail|send|reply|replyAll|forward|createReply|createReplyAll|createForward)\b/i
const GRAPH_MAIL = /\/(messages|mailFolders|drafts)\b/i
// imapflow methods that change a mailbox
const IMAP_WRITES = new Set([
  'append', 'messageFlagsAdd', 'messageFlagsRemove', 'messageFlagsSet', 'messageCopy', 'messageMove', 'messageDelete',
  'mailboxCreate', 'mailboxDelete', 'mailboxRename', 'mailboxSubscribe', 'mailboxUnsubscribe', 'setFlagColor',
])
const IMAP_COMMANDS = /^\s*(UID\s+)?(APPEND|STORE|COPY|MOVE|EXPUNGE|SELECT|CREATE|DELETE|RENAME)\b/i
export const SMTP_PACKAGES = /^(nodemailer|emailjs|smtp-.*|.*-smtp|smtp|@sendgrid\/mail|mailgun.*|postmark|@aws-sdk\/client-ses|@aws-sdk\/client-sesv2)$/

const chainNames = (e: ts.Expression): string[] => {
  const out: string[] = []
  let cur: ts.Expression = e
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      out.unshift(cur.name.text)
      cur = cur.expression
    } else if (ts.isCallExpression(cur)) cur = cur.expression
    else if (ts.isElementAccessExpression(cur)) {
      if (ts.isStringLiteralLike(cur.argumentExpression)) out.unshift(cur.argumentExpression.text)
      cur = cur.expression
    } else {
      if (ts.isIdentifier(cur)) out.unshift(cur.text)
      return out
    }
  }
}

const literalText = (n: ts.Node): string | null =>
  ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => `\${}${s.literal.text}`).join('') : null

/** First string argument of any `.api(...)` call in the receiver chain (Graph client). */
function graphPath(e: ts.Expression): string | null {
  let cur: ts.Expression = e
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === 'api' && cur.arguments[0]) {
      return literalText(cur.arguments[0]) ?? '<dynamic>'
    }
    cur = ts.isCallExpression(cur) ? cur.expression : cur.expression
  }
  return null
}

const truthyProp = (obj: ts.Node | undefined, name: string): boolean | null => {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p.initializer.kind === ts.SyntaxKind.TrueKeyword
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return null
  }
  return null
}

// Modules that reach a mailbox or the network directly: allowed only inside src/adapters/ (self-test WR-F2)
const NETWORK_MODULES = /^(node:)?(net|tls|dgram|http2)$|^(imapflow|googleapis|@googleapis\/.*|@microsoft\/.*|undici)$/
// Names that write to a mailbox in any client library; in adapter files they may not appear in any form
const WRITE_NAMES = new Set([...IMAP_WRITES, ...GMAIL_WRITES, 'drafts', 'sendMail'])

// the sandbox probe tries to open a network connection on purpose: that it fails is what TC-ING-10 checks
const NETWORK_ALLOWED = new Set(['parser/probe.ts'])
const isAdapter = (file: string) => /(^|\/)src\/adapters\//.test(file) || NETWORK_ALLOWED.has(file.replace(/^\.\//, ''))

export function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Finding[] = []
  const add = (n: ts.Node, rule: string) => out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, rule })
  const adapter = isAdapter(file)
  const moduleRule = (n: ts.Node, spec: string) => {
    if (SMTP_PACKAGES.test(spec)) add(n, `SMTP package ${spec}`)
    else if (NETWORK_MODULES.test(spec) && !adapter) add(n, `network or mail module ${spec} outside src/adapters/`)
  }
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) moduleRule(n, n.moduleSpecifier.text)
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) moduleRule(n, n.moduleReference.expression.text)
    if (ts.isCallExpression(n)) {
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require'
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isImport) {
        const arg = n.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) moduleRule(n, arg.text)
        else add(n, `${isImport ? 'import()' : 'require()'} with a computed module name`)
      }
      const callee = n.expression
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text
        const chain = chainNames(callee)
        // Gmail: users.messages.send / insert / import / modify …, users.drafts.*, users.threads.modify …
        const i = chain.findIndex((x) => x === 'messages' || x === 'threads')
        if (i >= 0 && GMAIL_WRITES.has(chain[chain.length - 1]!) && i === chain.length - 2) add(n, `Gmail ${chain.slice(i).join('.')}`)
        if (chain.includes('drafts') && chain.indexOf('drafts') < chain.length - 1) add(n, `Gmail ${chain.slice(chain.indexOf('drafts')).join('.')}`)
        // Graph: .api('/…/messages').post / patch / put / delete, any send/reply/forward path
        if (['post', 'patch', 'put', 'delete'].includes(method)) {
          const path = graphPath(callee.expression)
          if (path !== null && (GRAPH_MAIL.test(path) || GRAPH_PATHS.test(path) || path === '<dynamic>')) add(n, `Graph ${method.toUpperCase()} ${path}`)
        }
        if (IMAP_WRITES.has(method)) add(n, `IMAP ${method}`)
        if (method === 'mailboxOpen' || method === 'getMailboxLock') {
          const opts = n.arguments[1]
          const spread = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => ts.isSpreadAssignment(p))
          if (spread || truthyProp(opts, 'readOnly') !== true) add(n, `IMAP ${method} without a literal readOnly: true`)
        }
        if (method === 'exec' || method === 'run') {
          const cmd = n.arguments[0] && literalText(n.arguments[0])
          if (cmd && IMAP_COMMANDS.test(cmd)) add(n, `IMAP command ${cmd.trim().split(/\s+/).slice(0, 2).join(' ')}`)
          // a computed command string on anything but a regular expression
          const regex = ts.isRegularExpressionLiteral(callee.expression) || (ts.isIdentifier(callee.expression) && /(^|_)RE$|Re$|regex/i.test(callee.expression.text))
          if (adapter && n.arguments[0] && cmd === null && !regex) add(n, `IMAP ${method} with a computed command`)
        }
      }
    }
    // direct HTTP: a non-GET request to a mail service or a mail path, anywhere; in mailbox adapters any non-GET request (Codex F15)
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const fname = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (['fetch', 'request', 'got', 'post', 'put', 'patch'].includes(fname) && !(ts.isPropertyAccessExpression(callee) && graphPath(callee.expression) !== null)) {
        const opts = n.arguments.find((a) => ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined
        const methodProp = opts?.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method') as ts.PropertyAssignment | undefined
        const method = methodProp ? (literalText(methodProp.initializer) ?? '<computed>') : ['post', 'put', 'patch'].includes(fname) ? fname : 'GET'
        const url = n.arguments[0] ? (literalText(n.arguments[0]) ?? (ts.isBinaryExpression(n.arguments[0]) ? n.arguments[0].getText(sf) : '<computed>')) : ''
        const write = !/^(get|head)$/i.test(method)
        const mailUrl = /graph\.microsoft\.com|googleapis\.com|gmail|outlook\.office|\/messages\b|\/mailFolders\b|\/drafts\b|\/sendMail\b/i.test(url)
        // mailbox adapters may not write over HTTP at all; elsewhere (event webhooks, E3) only mail services are refused
        if (write && (mailUrl || /(^|\/)src\/adapters\/mailbox\//.test(file))) add(n, `HTTP ${method.toUpperCase()} ${url.slice(0, 60)}`)
      }
    }
    // inside adapters: a write name in any form (element access, destructuring, string) is refused
    if (adapter) {
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && WRITE_NAMES.has(n.argumentExpression.text)) add(n, `mailbox write ${n.argumentExpression.text} by element access`)
      if (ts.isBindingElement(n)) {
        const name = n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName.text : ts.isIdentifier(n.name) ? n.name.text : ''
        if (WRITE_NAMES.has(name)) add(n, `mailbox write ${name} by destructuring`)
      }
      if (ts.isPropertyAccessExpression(n) && WRITE_NAMES.has(n.name.text) && !ts.isCallExpression(n.parent)) add(n, `mailbox write ${n.name.text} taken as a value`)
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'messages' && !ts.isPropertyAccessExpression(n.parent)) add(n, 'Gmail messages collection taken as a value')
    }
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const s = literalText(n) ?? ''
      // any literal naming a Graph send/reply/forward path or an SMTP verb sequence
      if (GRAPH_PATHS.test(s)) add(n, `Graph send path ${s.slice(0, 60)}`)
      if (/^\s*(EHLO |HELO |MAIL FROM:|RCPT TO:)/i.test(s)) add(n, 'SMTP command')
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Members of `interface MailboxAdapter` (tech design §3.1). */
export function mailboxAdapterMembers(text: string): string[] | null {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  let members: string[] | null = null
  const visit = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'MailboxAdapter') {
      members = n.members.map((m) => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : '?'))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return members
}

export const ADAPTER_MEMBERS = ['id', 'name', 'capabilities', 'start', 'catchUp', 'fetchRaw', 'renew']

export function scanPackageJson(text: string): Finding[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>
  const out: Finding[] = []
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[k] ?? {})) if (SMTP_PACKAGES.test(name)) out.push({ file: 'package.json', line: 0, rule: `SMTP package ${name}` })
  }
  return out
}

// ---------- E4 (tech design v0.7.9 «原生 HTTP», review #9): the request allow-list and direct fetches ----------

/** The allow-list src/adapters/mailbox/http.ts must hold, exactly: one more entry fails CI. */
export const EXPECTED_MAIL_HTTP_ALLOW = [
  'GET gmail.googleapis.com /gmail/v1/users/*/profile',
  'GET gmail.googleapis.com /gmail/v1/users/*/labels',
  'GET gmail.googleapis.com /gmail/v1/users/*/history',
  'GET gmail.googleapis.com /gmail/v1/users/*/messages',
  'GET gmail.googleapis.com /gmail/v1/users/*/messages/*',
  'POST gmail.googleapis.com /gmail/v1/users/*/watch',
  'POST gmail.googleapis.com /gmail/v1/users/*/stop',
  'POST pubsub.googleapis.com /v1/projects/*/subscriptions/*:pull',
  'POST pubsub.googleapis.com /v1/projects/*/subscriptions/*:acknowledge',
  'POST oauth2.googleapis.com /token',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*/childFolders',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*/messages/delta',
  'GET graph.microsoft.com /v1.0/users/*/messages',
  'GET graph.microsoft.com /v1.0/users/*/messages/*',
  'GET graph.microsoft.com /v1.0/users/*/messages/*/$value',
  'GET graph.microsoft.com /v1.0/servicePrincipals',
  'GET graph.microsoft.com /v1.0/servicePrincipals/*/appRoleAssignments',
  'POST login.microsoftonline.com /*/oauth2/v2.0/token',
]

// path words that write or send mail, on any provider
const WRITE_WORDS = /(send|sendMail|draft|drafts|insert|import|modify|batchModify|batchDelete|trash|untrash|delete|reply|replyAll|forward|createReply|createReplyAll|createForward|move|copy|attachments|messageRules)\b/i

export function checkAllowList(list: readonly string[]): string[] {
  const out: string[] = []
  if (list.join('\n') !== EXPECTED_MAIL_HTTP_ALLOW.join('\n')) out.push('the mailbox HTTP allow-list differs from the expected list (tech design v0.7.9)')
  for (const e of list) {
    const [method, , path] = e.split(' ')
    if (method !== 'GET' && method !== 'POST') out.push(`allow-list entry with method ${method}: ${e}`)
    if (WRITE_WORDS.test(path ?? '')) out.push(`allow-list entry with a write path: ${e}`)
  }
  return out
}

const PROVIDER = /(googleapis\.com|graph\.microsoft\.com|login\.microsoftonline\.com|outlook\.office(365)?\.com)/

/**
 * A source file that names a Google or Microsoft API host must not call fetch (or http/https request) itself: every
 * such request goes through MailHttp. Production code must not import the test fakes.
 */
export function scanDirectRequests(file: string, text: string): Finding[] {
  const out: Finding[] = []
  const isFake = file.endsWith('.fake.ts')
  if (!isFake && /from ['"][^'"]+\.fake(\.ts)?['"]/.test(text)) out.push({ file, line: 0, rule: 'production code imports a test fake' })
  if (isFake || file.endsWith('src/adapters/mailbox/http.ts') || !PROVIDER.test(text)) return out
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      const owner = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : ''
      if (name === 'fetch' || (['http', 'https'].includes(owner) && ['request', 'get'].includes(name))) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, rule: 'a Google / Microsoft request outside MailHttp (src/adapters/mailbox/http.ts)' })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
