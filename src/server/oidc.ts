// OIDC login with the deployer's identity provider (PRD R-REV-06): authorisation code + PKCE, state and nonce.
// The role comes from a configured claim; a user is created on first login and keeps the role the claim gives.
import * as oc from 'openid-client'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Keyring } from '../store/crypto.ts'
import type { Role } from './auth.ts'
import { ROLE_RANK } from './auth.ts'

export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  roleClaim: string
  roleMap: Record<string, Role>
  allowHttp?: boolean // tests only
}

export class Oidc {
  private cfg: oc.Configuration | null = null
  private readonly s: OidcSettings
  private readonly key: Buffer
  constructor(s: OidcSettings, k: Keyring) {
    this.s = s
    this.key = Buffer.from(k.hmac('oidc-cookie-key'), 'hex')
  }

  private async config(): Promise<oc.Configuration> {
    if (!this.cfg) {
      this.cfg = await oc.discovery(new URL(this.s.issuer), this.s.clientId, this.s.clientSecret, undefined, this.s.allowHttp ? { execute: [oc.allowInsecureRequests] } : undefined)
    }
    return this.cfg
  }

  private sign(v: string) {
    return createHmac('sha256', this.key).update(v).digest('base64url')
  }

  /** Redirect URL and the cookie that carries state, nonce and the PKCE verifier. */
  async start(): Promise<{ url: string; cookie: string }> {
    const verifier = oc.randomPKCECodeVerifier()
    const state = oc.randomState()
    const nonce = oc.randomNonce()
    const url = oc.buildAuthorizationUrl(await this.config(), {
      redirect_uri: this.s.redirectUri, scope: 'openid', code_challenge: await oc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
    })
    const payload = Buffer.from(JSON.stringify({ verifier, state, nonce, exp: Date.now() + 10 * 60_000 })).toString('base64url')
    return { url: url.href, cookie: `${payload}.${this.sign(payload)}` }
  }

  /** Exchange the code; returns the subject, a display name and the mapped role, or null when no role applies. */
  async finish(callbackUrl: URL, cookie: string | undefined): Promise<{ sub: string; name: string; role: Role } | null> {
    if (!cookie) return null
    const [payload, sig] = cookie.split('.')
    if (!payload || !sig) return null
    const want = Buffer.from(this.sign(payload))
    const got = Buffer.from(sig)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { verifier: string; state: string; nonce: string; exp: number }
    if (st.exp < Date.now()) return null
    const tokens = await oc.authorizationCodeGrant(await this.config(), callbackUrl, { pkceCodeVerifier: st.verifier, expectedState: st.state, expectedNonce: st.nonce })
    const claims = tokens.claims()
    if (!claims) return null
    const raw = claims[this.s.roleClaim]
    const values = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string')
    const roles = values.map((v) => this.s.roleMap[v]).filter((r): r is Role => !!r)
    if (roles.length === 0) return null
    const role = roles.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0]!
    const name = typeof claims.email === 'string' ? claims.email : typeof claims.preferred_username === 'string' ? claims.preferred_username : claims.sub
    return { sub: claims.sub, name, role }
  }
}
