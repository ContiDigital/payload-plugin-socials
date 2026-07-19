import type { PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))
vi.mock('../../services/connectionService.js', () => ({ disconnectPlatform: vi.fn() }))

import { STATE_COOKIE_NAME } from '../../platforms/pinterest/oauth.js'
import { getPlatformAdapter } from '../../platforms/registry.js'
import { disconnectPlatform } from '../../services/connectionService.js'
import { assertAccess } from '../../utilities/access.js'
import {
  createPinterestDisconnectEndpoint,
  createPinterestOauthCallbackEndpoint,
  createPinterestOauthEndpoints,
  createPinterestOauthStartEndpoint,
} from '../createPinterestOauthEndpoints.js'

const buildOptions = (enabled = true, adminBase = '/admin'): NormalizedPluginOptions =>
  ({
    admin: { adminBase, route: '/socials' },
    api: { basePath: '/socials' },
    platforms: { pinterest: { enabled } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()

const mkReq = (over: { cookie?: string; search?: Record<string, string> } = {}): PayloadRequest =>
  ({
    headers: new Headers(over.cookie ? { cookie: over.cookie } : {}),
    payload: { logger: undefined },
    searchParams: new URLSearchParams(over.search ?? {}),
  }) as unknown as PayloadRequest

const adapter = {
  buildAuthorizeUrl: vi.fn().mockResolvedValue('https://www.pinterest.com/oauth/?x=1'),
  exchangeCallback: vi.fn().mockResolvedValue({}),
  isConnected: vi.fn().mockResolvedValue({ connected: true }),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
  vi.mocked(getPlatformAdapter).mockReturnValue(adapter as never)
})

describe('start endpoint', () => {
  const endpoint = createPinterestOauthStartEndpoint(options)

  it('returns an authorize URL and sets a hardened state cookie', async () => {
    const res = await endpoint.handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://www.pinterest.com/oauth/?x=1')
    expect(body.state).toBeUndefined()
    const cookie = res.headers.get('set-cookie') ?? ''
    const state = cookie.match(new RegExp(`${STATE_COOKIE_NAME}=([a-f0-9]{48})`))?.[1]
    expect(state).toMatch(/^[a-f0-9]{48}$/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(adapter.buildAuthorizeUrl).toHaveBeenCalledWith(expect.objectContaining({ state }))
  })

  it('400s when Pinterest is not enabled', async () => {
    const res = await createPinterestOauthStartEndpoint(buildOptions(false)).handler(mkReq())
    expect(res.status).toBe(400)
  })

  it('propagates an admin access rejection', async () => {
    vi.mocked(assertAccess).mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    )
    const res = await endpoint.handler(mkReq())
    expect(res.status).toBe(403)
  })
})

describe('callback endpoint', () => {
  const endpoint = createPinterestOauthCallbackEndpoint(options)

  it('exchanges the code and redirects when the state matches', async () => {
    const res = await endpoint.handler(
      mkReq({ cookie: `${STATE_COOKIE_NAME}=abc`, search: { code: 'c0de', state: 'abc' } }),
    )
    expect(res.status).toBe(302)
    // Fix 2: redirect must include the admin base prefix.
    expect(res.headers.get('location')).toBe('/admin/socials?connected=pinterest')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(adapter.exchangeCallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'c0de' }))
  })

  it('uses a custom admin base in the redirect', async () => {
    const customOptions = buildOptions(true, '/cms')
    const ep = createPinterestOauthCallbackEndpoint(customOptions)
    const res = await ep.handler(
      mkReq({ cookie: `${STATE_COOKIE_NAME}=abc`, search: { code: 'c0de', state: 'abc' } }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/cms/socials?connected=pinterest')
  })

  it('returns the provider error and clears the cookie', async () => {
    const res = await endpoint.handler(mkReq({ search: { error: 'access_denied' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'access_denied' })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(adapter.exchangeCallback).not.toHaveBeenCalled()
  })

  it('400s a missing code', async () => {
    const res = await endpoint.handler(mkReq({ search: { state: 'abc' } }))
    expect(res.status).toBe(400)
  })

  it('403s when the state cookie does not match the state param (CSRF guard)', async () => {
    const res = await endpoint.handler(
      mkReq({ cookie: `${STATE_COOKIE_NAME}=other`, search: { code: 'c', state: 'abc' } }),
    )
    expect(res.status).toBe(403)
    expect(adapter.exchangeCallback).not.toHaveBeenCalled()
  })
})

describe('disconnect endpoint', () => {
  const endpoint = createPinterestDisconnectEndpoint(options)

  it('clears the stored credentials', async () => {
    const res = await endpoint.handler(mkReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      affectedPlatforms: ['pinterest'],
      ok: true,
      upstreamRevoked: false,
    })
    expect(disconnectPlatform).toHaveBeenCalledWith(expect.anything(), 'pinterest')
  })

  it('propagates an admin access rejection', async () => {
    vi.mocked(assertAccess).mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    )
    const res = await endpoint.handler(mkReq())
    expect(res.status).toBe(403)
    expect(disconnectPlatform).not.toHaveBeenCalled()
  })
})

describe('factory gating', () => {
  it('returns no endpoints when Pinterest is disabled', () => {
    expect(createPinterestOauthEndpoints(buildOptions(false))).toEqual([])
  })

  it('returns the three endpoints when enabled', () => {
    const endpoints = createPinterestOauthEndpoints(options)
    expect(endpoints).toHaveLength(3)
    expect(endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'post /socials/pinterest/oauth/start',
      'get /socials/pinterest/oauth/callback',
      'post /socials/pinterest/disconnect',
    ])
  })
})
