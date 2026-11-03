// A minimal OpenID provider for tests (TC-REV-06): discovery, authorize (auto-approves), token with PKCE, JWKS.
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export interface MockIdp {
  issuer: string
  claims: Record<string, unknown> // claims for the next login
  close(): Promise<void>
}

export async function startMockIdp(): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, { nonce: string; challenge: string; clientId: string; redirect: string }>()
  const idp: MockIdp = { issuer: '', claims: { sub: 'user-1', email: 'reviewer@ops.example', roles: ['ops-reviewers'] }, close: async () => {} }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, idp.issuer)
    const json = (o: unknown, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      })
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] })
    if (url.pathname === '/authorize') {
      const code = randomBytes(16).toString('hex')
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, clientId: url.searchParams.get('client_id')!, redirect: url.searchParams.get('redirect_uri')! })
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state')!)
      back.searchParams.set('iss', idp.issuer)
      res.writeHead(302, { location: back.href })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const p = new URLSearchParams(body)
      const c = codes.get(p.get('code') ?? '')
      codes.delete(p.get('code') ?? '')
      const verifier = p.get('code_verifier') ?? ''
      if (!c || createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400)
      const now = Math.floor(Date.now() / 1000)
      const idToken = await new SignJWT({ ...idp.claims, nonce: c.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idp.issuer).setAudience(c.clientId).setIssuedAt(now).setExpirationTime(now + 300)
        .sign(privateKey)
      return json({ access_token: randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  idp.issuer = `http://127.0.0.1:${addr.port}`
  idp.close = () => new Promise((r) => server.close(() => r()))
  return idp
}
