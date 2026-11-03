// PRD C-EXT-6: e-signature invitations, by sender domain or link domain only. Links are never visited.

export type EsignPlatforms = Record<string, readonly string[]> // platform name → domains

const host = (d: string) => d.toLowerCase().replace(/\.$/, '')
const under = (domain: string, platformDomain: string) => {
  const d = host(domain)
  const p = host(platformDomain)
  return d === p || d.endsWith(`.${p}`)
}

/** Host names of http(s) links in text and in `href` / `src` attributes of HTML. */
export function linkDomains(text: string, html: string | null): string[] {
  const out = new Set<string>()
  const scan = (s: string) => {
    for (const m of s.matchAll(/https?:\/\/([^\s/?#"'<>\\]+)/giu)) {
      // authority = [userinfo@]host[:port]
      const h = m[1]!.slice(m[1]!.lastIndexOf('@') + 1).replace(/:\d*$/, '')
      if (h) out.add(host(h))
    }
  }
  scan(text)
  if (html) scan(html.replace(/&#x?[0-9a-f]+;|&amp;/gi, (e) => (e.toLowerCase() === '&amp;' ? '&' : decodeEntity(e))))
  return [...out]
}

function decodeEntity(e: string): string {
  const hex = /^&#x/i.test(e)
  const n = Number.parseInt(e.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

export function detectEsign(fromDomain: string, links: readonly string[], platforms: EsignPlatforms): { esignInvite: boolean; platform: string | null } {
  for (const [name, domains] of Object.entries(platforms)) {
    if (domains.some((p) => under(fromDomain, p) || links.some((l) => under(l, p)))) return { esignInvite: true, platform: name }
  }
  return { esignInvite: false, platform: null }
}
