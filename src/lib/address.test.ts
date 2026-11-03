import { describe, expect, it } from 'vitest'
import { parseAddressList, parseSender } from './address.ts'

const ok = (raw: string) => {
  const r = parseSender(raw)
  return r.ok ? r.mailbox : r.reason
}

describe('sender parsing (C-SIG-1, C-SIG-3, C-LNK-1)', () => {
  it('ordinary forms', () => {
    expect(ok('Amelia Hart <amelia@hartfamily.example>')).toEqual({ name: 'Amelia Hart', address: 'amelia@hartfamily.example' })
    expect(ok('"Hart, Amelia" <amelia@hartfamily.example>')).toEqual({ name: 'Hart, Amelia', address: 'amelia@hartfamily.example' })
    expect(ok('"Jane \\"JS\\" Smith" <jane@acme-1.example>')).toEqual({ name: 'Jane "JS" Smith', address: 'jane@acme-1.example' })
    expect(ok('amelia@hartfamily.example')).toEqual({ name: '', address: 'amelia@hartfamily.example' })
    expect(ok('amelia@hartfamily.example (Amelia Hart)')).toEqual({ name: '', address: 'amelia@hartfamily.example' })
    expect(ok('=?utf-8?q?Zo=C3=AB_=C3=9Cnal?= <zoe@x.example>')).toEqual({ name: 'Zoë Ünal', address: 'zoe@x.example' })
    expect(ok('"amelia@hartfamily.example" <amelia@hartfamily.example>')).toEqual({ name: 'amelia@hartfamily.example', address: 'amelia@hartfamily.example' })
  })
  it('a display name can never supply the address (self-test RK-F1 / CF-F1)', () => {
    // quoted: the real sender is the angle address; a different address inside the name is a disguise
    expect(ok('"Alice Smith <cfo@fund.example>" <attacker@evil.example>')).toBe('name_holds_other_address')
    // encoded word: decoded only after the address is found
    expect(ok('=?utf-8?q?Alice_Smith_=3Ccfo=40fund=2Eexample=3E?= <attacker@evil.example>')).toBe('name_holds_other_address')
    expect(ok('=?utf-8?q?Jane_Smith_=3Cjane@acme.example=3E?= <attacker@evil.example>')).toBe('name_holds_other_address')
    // a comment holding an address is ignored
    expect(ok('(cfo@fund.example) <attacker@evil.example>')).toEqual({ name: '', address: 'attacker@evil.example' })
  })
  it('several mailboxes, groups and broken values are not guessed', () => {
    expect(ok('a@x.example, b@y.example')).toBe('several')
    expect(ok('Team: a@x.example;')).toBe('unparseable')
    expect(ok('<a@x.example> <b@y.example>')).toBe('unparseable')
    expect(ok('Alice <a@x.example')).toBe('unparseable')
    expect(ok('"unterminated <a@x.example>')).toBe('unparseable')
    expect(ok('just a name')).toBe('unparseable')
    expect(ok('')).toBe('missing')
    expect(ok('Alice <a@x.example> trailing')).toBe('unparseable')
  })
  it('Reply-To lists', () => {
    expect(parseAddressList('"Hart, Amelia" <a@x.example>, b@y.example')).toEqual(['a@x.example', 'b@y.example'])
    expect(parseAddressList(undefined)).toEqual([])
    expect(parseAddressList('a@x.example, <broken')).toBeNull()
  })
})
