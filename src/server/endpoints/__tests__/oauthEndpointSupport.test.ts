import type { PayloadRequest } from 'payload'

import { describe, expect, it } from 'vitest'

import {
  buildStateCookie,
  clearStateCookie,
  getSearchParam,
  readRequestCookie,
} from '../oauthEndpointSupport.js'

const reqWith = (over: Record<string, unknown>): PayloadRequest => over as unknown as PayloadRequest

describe('readRequestCookie', () => {
  it('reads and URL-decodes a cookie from a Headers instance', () => {
    const req = reqWith({ headers: new Headers({ cookie: 'a=1; state=hello%20world; b=2' }) })
    expect(readRequestCookie(req, 'state')).toBe('hello world')
  })

  it('reads a cookie from a plain record-style headers object', () => {
    const req = reqWith({ headers: { cookie: 'state=abc' } })
    expect(readRequestCookie(req, 'state')).toBe('abc')
  })

  it('returns undefined when the header or cookie is absent', () => {
    expect(readRequestCookie(reqWith({}), 'state')).toBeUndefined()
    expect(readRequestCookie(reqWith({ headers: new Headers() }), 'state')).toBeUndefined()
    expect(
      readRequestCookie(reqWith({ headers: new Headers({ cookie: 'other=1' }) }), 'state'),
    ).toBeUndefined()
  })
})

describe('getSearchParam', () => {
  it('reads from a pre-parsed searchParams', () => {
    const req = reqWith({ searchParams: new URLSearchParams({ code: 'xyz' }) })
    expect(getSearchParam(req, 'code')).toBe('xyz')
    expect(getSearchParam(req, 'missing')).toBeUndefined()
  })

  it('falls back to parsing req.url', () => {
    const req = reqWith({ url: 'https://host/cb?code=fromurl&state=s' })
    expect(getSearchParam(req, 'code')).toBe('fromurl')
    expect(getSearchParam(req, 'state')).toBe('s')
  })

  it('returns undefined for a malformed or missing url', () => {
    expect(getSearchParam(reqWith({ url: '::::' }), 'code')).toBeUndefined()
    expect(getSearchParam(reqWith({}), 'code')).toBeUndefined()
  })
})

describe('buildStateCookie / clearStateCookie', () => {
  it('builds a hardened state cookie', () => {
    const cookie = buildStateCookie('socials_state', 'tok123', 600)
    expect(cookie).toBe('socials_state=tok123; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure')
  })

  it('builds a clearing cookie with Max-Age 0', () => {
    const cookie = clearStateCookie('socials_state')
    expect(cookie).toContain('socials_state=;')
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
  })
})
