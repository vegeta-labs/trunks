// Envelope encryption (tech design §5): one AES-256-GCM data key per object, wrapped by a master key with an id.
// HMAC-SHA256 with a separate deployment key for lookup columns and content hashes.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export interface MasterKey {
  id: string
  key: Buffer // 32 bytes
}

export class Keyring {
  readonly active: MasterKey
  private readonly keys: Map<string, MasterKey>
  private readonly hmacKey: Buffer

  constructor(keys: MasterKey[], activeId: string, hmacKey: Buffer) {
    if (hmacKey.length < 32) throw new Error('HMAC key must be at least 32 bytes')
    for (const k of keys) if (k.key.length !== 32) throw new Error(`master key ${k.id} must be 32 bytes`)
    this.keys = new Map(keys.map((k) => [k.id, k]))
    const a = this.keys.get(activeId)
    if (!a) throw new Error(`active master key ${activeId} not found`)
    this.active = a
    this.hmacKey = hmacKey
  }

  /** `TRUNKS_MASTER_KEYS="k1:<base64>,k2:<base64>"`, `TRUNKS_ACTIVE_KEY=k2`, `TRUNKS_HMAC_KEY=<base64>`. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
    const raw = env.TRUNKS_MASTER_KEYS
    const hmac = env.TRUNKS_HMAC_KEY
    if (!raw || !hmac) throw new Error('TRUNKS_MASTER_KEYS and TRUNKS_HMAC_KEY are required')
    const keys = raw.split(',').map((s) => {
      const i = s.indexOf(':')
      return { id: s.slice(0, i).trim(), key: Buffer.from(s.slice(i + 1).trim(), 'base64') }
    })
    // an empty TRUNKS_ACTIVE_KEY (compose's `${TRUNKS_ACTIVE_KEY:-}`) counts as not set
    return new Keyring(keys, env.TRUNKS_ACTIVE_KEY || keys.at(-1)!.id, Buffer.from(hmac, 'base64'))
  }

  hmac(s: string | Buffer): string {
    return createHmac('sha256', this.hmacKey).update(s).digest('hex')
  }

  private static seal(key: Buffer, plain: Buffer): Buffer {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(plain), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), body])
  }

  private static open(key: Buffer, sealed: Buffer): Buffer {
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
    d.setAuthTag(sealed.subarray(12, 28))
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()])
  }

  encrypt(plain: Buffer): { keyId: string; wrappedDek: Buffer; ciphertext: Buffer } {
    const dek = randomBytes(32)
    return { keyId: this.active.id, wrappedDek: Keyring.seal(this.active.key, dek), ciphertext: Keyring.seal(dek, plain) }
  }

  /** A new master key added and made the write key (key rotation, tech design §5). */
  withKey(extra: MasterKey, activeId = extra.id): Keyring {
    return new Keyring([...this.keys.values(), extra], activeId, this.hmacKey)
  }

  /** The same keyring with one master key only (rotation's check that the new key alone decrypts). */
  restrictTo(id: string): Keyring {
    const k = this.keys.get(id)
    if (!k) throw new Error(`master key ${id} not available`)
    return new Keyring([k], id, this.hmacKey)
  }

  ids(): string[] {
    return [...this.keys.keys()]
  }

  /** Key rotation (tech design §5): the same data key, wrapped by the active master key; the ciphertext is untouched. */
  rewrap(keyId: string, wrappedDek: Buffer): { keyId: string; wrappedDek: Buffer } {
    const k = this.keys.get(keyId)
    if (!k) throw new Error(`master key ${keyId} not available`)
    return { keyId: this.active.id, wrappedDek: Keyring.seal(this.active.key, Keyring.open(k.key, wrappedDek)) }
  }

  decrypt(keyId: string, wrappedDek: Buffer, ciphertext: Buffer): Buffer {
    const k = this.keys.get(keyId)
    if (!k) throw new Error(`master key ${keyId} not available`)
    return Keyring.open(Keyring.open(k.key, wrappedDek), ciphertext)
  }
}
