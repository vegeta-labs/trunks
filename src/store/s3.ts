// S3-compatible file store (tech design T3): path-style requests signed with AWS Signature V4, objects encrypted by
// the application before upload (the same format as the disk store). `deleteAllVersions` removes every version of a
// key in a versioned bucket (C-PRV-1, C-PRV-2).
import { createHash, createHmac } from 'node:crypto'
import type { Keyring } from './crypto.ts'
import { openFile, sealFile, type FileStore } from './files.ts'

export interface S3Settings {
  endpoint: string // e.g. https://s3.eu-west-2.amazonaws.com or http://minio:9000
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest()
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** XML text content: the five predefined entities and numeric character references (keys and markers in listings). */
export function xmlText(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  // an «&» that does not start a valid reference: the listing is not well-formed XML (Codex E4 round 5 F1)
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) throw new Error('S3 list versions: malformed XML')
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    // only characters XML allows (round 6 F1): a surrogate, a control character or a value beyond Unicode is malformed
    const legal = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
    if (!legal) throw new Error('S3 list versions: malformed XML')
    return String.fromCodePoint(cp)
  })
}

export class S3Store implements FileStore {
  private readonly s: S3Settings
  private readonly k: Keyring
  constructor(s: S3Settings, k: Keyring) {
    this.s = s
    this.k = k
  }

  private key(key: string) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(key)) throw new Error('invalid object key')
    return `${this.s.prefix ?? ''}${key}`
  }

  /** Signed request; `query` values are already decoded. */
  async request(method: string, key: string, query: Record<string, string> = {}, body?: Buffer): Promise<Response> {
    const url = new URL(this.s.endpoint)
    const path = `/${enc(this.s.bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`
    const qs = Object.keys(query).sort().map((q) => `${enc(q)}=${enc(query[q]!)}`).join('&')
    const now = new Date()
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const day = amzDate.slice(0, 8)
    const payloadHash = sha(body ?? '')
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    const signed = Object.keys(headers).sort()
    const canonical = [method, path, qs, ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payloadHash].join('\n')
    const scope = `${day}/${this.s.region}/s3/aws4_request`
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.s.secretAccessKey}`, day), this.s.region), 's3'), 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.s.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
    const { host: _host, ...sendHeaders } = headers
    return fetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, { method, headers: sendHeaders, body: body ? new Uint8Array(body) : undefined, redirect: 'error' })
  }

  async put(key: string, data: Buffer): Promise<void> {
    const r = await this.request('PUT', this.key(key), {}, sealFile(this.k, data))
    if (!r.ok) throw new Error(`S3 PUT ${r.status}`)
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.request('GET', this.key(key))
    if (!r.ok) throw new Error(`S3 GET ${r.status}`)
    return openFile(this.k, Buffer.from(await r.arrayBuffer()))
  }
  async exists(key: string): Promise<boolean> {
    const r = await this.request('HEAD', this.key(key))
    return r.ok
  }
  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', this.key(key))
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${r.status}`)
  }
  /** Every version and delete marker of the key. */
  async versions(key: string): Promise<string[]> {
    const full = this.key(key)
    const ids: string[] = []
    let markers: Record<string, string> = {}
    // every page of the listing (Codex F10)
    for (let page = 0; page < 10_000; page++) {
      const r = await this.request('GET', '', { versions: '', prefix: full, ...markers })
      if (!r.ok) throw new Error(`S3 list versions ${r.status}`)
      const xml = await r.text()
      // a 200 that is not a complete listing is not «no versions» (Codex E4 round 3 F2)
      if (!/<ListVersionsResult[\s>]/.test(xml) || !/<\/ListVersionsResult>\s*$/.test(xml) || !/<IsTruncated>(true|false)<\/IsTruncated>/.test(xml)) throw new Error('S3 list versions: not a complete listing')
      // every record must be whole: as many complete records as opened ones, each with a key and a version (round 4 F1)
      const opened = (xml.match(/<(Version|DeleteMarker)[\s>]/g) ?? []).length
      const records = [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)]
      if (records.length !== opened) throw new Error('S3 list versions: an incomplete record')
      for (const m of records) {
        const k = xmlText(/<Key>([^<]*)<\/Key>/.exec(m[2]!)?.[1])
        const v = xmlText(/<VersionId>([^<]*)<\/VersionId>/.exec(m[2]!)?.[1])
        if (k === undefined || v === undefined) throw new Error('S3 list versions: a record without key or version')
        if (k === full) ids.push(v)
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return ids
      const km = xmlText(/<NextKeyMarker>([^<]*)<\/NextKeyMarker>/.exec(xml)?.[1])
      const vm = xmlText(/<NextVersionIdMarker>([^<]*)<\/NextVersionIdMarker>/.exec(xml)?.[1])
      if (km === undefined) throw new Error('S3 listing truncated without a continuation marker')
      markers = { 'key-marker': km, ...(vm ? { 'version-id-marker': vm } : {}) }
    }
    throw new Error('S3 listing did not end')
  }
  async sweepTemporary(): Promise<number> {
    return 0 // a PUT is atomic: S3 has no temporary objects
  }
  async getSealed(key: string): Promise<Buffer | null> {
    const r = await this.request('GET', this.key(key))
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`S3 GET ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  /** The new version, then every other version of the key removed (an old one still holds the old wrapped key). */
  async replaceSealed(key: string, sealed: Buffer): Promise<void> {
    const r = await this.request('PUT', this.key(key), {}, sealed)
    if (!r.ok) throw new Error(`S3 PUT ${r.status}`)
    // rewrite → read back and compare → only then remove the old versions (tech design v0.7.9 G1; round 5 F3)
    const back = await this.getSealed(key)
    if (!back || !back.equals(sealed)) throw new Error('S3: the rewritten object did not read back identically; old versions kept')
    await this.pruneOldVersions(key, r.headers.get('x-amz-version-id'))
  }
  async pruneOldVersions(key: string, current?: string | null): Promise<void> {
    let keep = current ?? null
    if (!keep) {
      const h = await this.request('HEAD', this.key(key))
      // an error is not «no versions»: the rotation must not complete over it (round 2 F7)
      if (!h.ok && h.status !== 404) throw new Error(`S3 HEAD ${h.status}`)
      keep = h.ok ? h.headers.get('x-amz-version-id') : null
    }
    // no current object: nothing to keep. An unversioned bucket lists only «null» (nothing else to remove); a bucket
    // with versioning suspended writes «null» but keeps its earlier numbered versions, which go (Codex E4 F9)
    if (!keep) return
    for (const v of await this.versions(key)) {
      if (v === keep) continue
      const d = await this.request('DELETE', this.key(key), { versionId: v })
      if (!d.ok && d.status !== 404) throw new Error(`S3 DELETE version ${d.status}`)
    }
  }
  async deleteAllVersions(key: string): Promise<void> {
    // deleting by version id leaves no delete marker behind; an unversioned bucket lists its object as version "null"
    for (const v of await this.versions(key)) {
      const r = await this.request('DELETE', this.key(key), { versionId: v })
      if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE version ${r.status}`)
    }
  }
}
