// D1a: read-only Gmail measurement using the production MIME, scan and KYC judgement. No email is written to disk.
// Run with the deployment's environment/secrets:
// node --env-file=.env.local --experimental-strip-types scripts/measure-inline-images.ts <gmail mailbox id> [1..500]
import { loadConfig } from '../src/config/load.ts'
import { Keyring } from '../src/store/crypto.ts'
import { pool } from '../src/store/db.ts'
import { expandFileVariables } from '../src/ops/env-files.ts'
import { MailHttp } from '../src/adapters/mailbox/http.ts'
import { GmailTokens } from '../src/adapters/mailbox/gmail.ts'
import { storedRefreshToken } from '../src/adapters/mailbox/gmail-auth.ts'
import { Clamd } from '../src/adapters/scan/clamd.ts'
import { decodeMime } from '../src/ingest/mime.ts'
import { imageHeader } from '../src/lib/image-header.ts'
import { inlineSignature, kycReason } from '../src/lib/kyc.ts'

async function main(): Promise<void> {
  expandFileVariables(process.env)
  const env = (key: string) => { const v = process.env[key]; if (!v) throw new Error('missing_environment'); return v }
  const config = loadConfig(process.env.CONFIG_DIR ?? 'config/default')
  const mailbox = config.mailboxes.find((m) => m.id === process.argv[2] && m.kind === 'gmail')
  const limit = Number(process.argv[3] ?? 500)
  if (!mailbox?.gmail || !config.gmail || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('usage_gmail_mailbox_and_limit_1_to_500')
  const db = pool(env('APP_DATABASE_URL'))
  try {
    const k = Keyring.fromEnv()
    const http = new MailHttp()
    const tokens = new GmailTokens(http, { address: mailbox.gmail.address, clientId: env(config.gmail.client_id_env), clientSecret: env(config.gmail.client_secret_env), refreshToken: () => storedRefreshToken(db, k, mailbox.id) })
    const scanner = new Clamd(process.env.CLAMD_HOST ?? 'clamav', Number(process.env.CLAMD_PORT ?? 3310))
    const get = async <T>(path: string): Promise<T> => {
      const r = await http.json<T>('GET', `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${await tokens.get()}` } })
      if (r.status !== 200 || !r.body) throw new Error('gmail_read_failed')
      return r.body
    }
    // q=in:inbox: the owner's approved D1a scope; sent/draft/trash/spam never enter this measurement.
    let page = '', messages = 0, images = 0, signatures = 0
    do {
      const q = new URLSearchParams({ q: 'in:inbox', maxResults: String(Math.min(100, limit - messages)), ...(page ? { pageToken: page } : {}) })
      const listing = await get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`messages?${q}`)
      for (const entry of listing.messages ?? []) {
        if (messages >= limit) break
        const mail = await get<{ raw?: string }>(`messages/${encodeURIComponent(entry.id)}?format=raw`)
        if (typeof mail.raw !== 'string') throw new Error('gmail_raw_missing')
        const m = decodeMime(Buffer.from(mail.raw, 'base64url'), { maxAttachmentBytes: config.attachments.max_attachment_bytes, maxTotalBytes: config.attachments.max_total_bytes })
        messages++
        for (const a of m.attachments.filter((x) => x.kind === 'image')) {
          const f = imageHeader(a.content ?? Buffer.alloc(0))
          const scan = a.overLimit || !a.content ? null : await scanner.scan(a.content)
          const input = { filename: a.filename, kind: a.kind, parseStatus: a.overLimit ? 'over_limit' : scan?.clean ? 'not_parsed' : 'blocked', scanStatus: scan?.clean ? 'clean' : 'infected', text: '', facts: null,
            inline: a.inline, imageFacts: f, inlineLimits: config.kyc.inline_image }
          const signature = inlineSignature(input)
          images++; if (signature) signatures++
          // No message id, sender, subject, filename, CID or content appears in the output.
          console.log(JSON.stringify({ image: images, format: f.format, width: f.width, height: f.height, bytes: a.size, referenced: a.inline.htmlReferenced, structure: f.code, judgement: signature ? 'inline_signature' : kycReason(input) }))
        }
      }
      page = listing.nextPageToken ?? ''
    } while (page && messages < limit)
    console.log(JSON.stringify({ messages, images, signatures }))
  } finally { await db.end() }
}

await main().catch(() => { console.error('measurement_failed; check the local configuration, credentials and scanner'); process.exitCode = 1 })
