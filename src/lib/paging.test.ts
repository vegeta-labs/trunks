import { describe, expect, it } from 'vitest'
import { pageOf } from './paging.ts'

describe('TC-REV-14 the page a request asks for', () => {
  it('TC-REV-14 caps the limit, keeps a valid page and treats nonsense as absent', () => {
    expect(pageOf(undefined, undefined)).toEqual({ limit: 50, offset: 0 })
    expect(pageOf(10, 20)).toEqual({ limit: 10, offset: 20 })
    expect(pageOf(1, 0)).toEqual({ limit: 1, offset: 0 })
    expect(pageOf(200, 0).limit).toBe(200)
    expect(pageOf(201, 0).limit).toBe(200)
    for (const bad of [NaN, -1, 0, 1.5, 1e30, Infinity]) expect(pageOf(bad, 0).limit, String(bad)).toBe(50)
    for (const bad of [NaN, -1, 1.5, 1e30, Infinity]) expect(pageOf(10, bad).offset, String(bad)).toBe(0)
  })
})
