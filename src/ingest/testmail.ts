// Builds raw .eml test messages (fictional data only).
export interface Part {
  type: string
  filename?: string
  content: Buffer | string
  encoding?: 'base64' | '7bit' | 'quoted-printable'
}

const b64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n')

export function eml(o: {
  from?: string
  to?: string
  subject?: string
  messageId?: string | null
  date?: string
  headers?: Array<[string, string]>
  text?: string
  html?: string
  attachments?: Part[]
}): Buffer {
  const h: string[] = []
  for (const [k, v] of o.headers ?? []) h.push(`${k}: ${v}`)
  h.push(`From: ${o.from ?? 'Amelia Hart <amelia@hartfamily.example>'}`)
  h.push(`To: ${o.to ?? 'ops@capital.example'}`)
  h.push(`Subject: ${o.subject ?? 'Payment'}`)
  if (o.messageId !== null) h.push(`Message-ID: ${o.messageId ?? `<${Math.random().toString(36).slice(2)}@hartfamily.example>`}`)
  h.push(`Date: ${o.date ?? 'Thu, 29 Oct 2026 10:00:00 +0000'}`)
  h.push('MIME-Version: 1.0')
  const parts: string[] = []
  if (o.text !== undefined) parts.push(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(o.text))}`)
  if (o.html !== undefined) parts.push(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(o.html))}`)
  for (const a of o.attachments ?? []) {
    const buf = typeof a.content === 'string' ? Buffer.from(a.content) : a.content
    const enc = a.encoding ?? 'base64'
    const body = enc === 'base64' ? b64(buf) : buf.toString('utf8')
    parts.push(`Content-Type: ${a.type}${a.filename ? `; name="${a.filename}"` : ''}\r\nContent-Disposition: attachment${a.filename ? `; filename="${a.filename}"` : ''}\r\nContent-Transfer-Encoding: ${enc}\r\n\r\n${body}`)
  }
  const boundary = `b-doi-${Math.random().toString(36).slice(2)}`
  const body = `--${boundary}\r\n${parts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`
  h.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  return Buffer.from(`${h.join('\r\n')}\r\n\r\n${body}`)
}
