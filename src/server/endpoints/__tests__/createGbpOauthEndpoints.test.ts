import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))
vi.mock('../../services/connectionService.js', () => ({ disconnectPlatform: vi.fn() }))

import { STATE_COOKIE_NAME } from '../../platforms/gbp/oauth.js'
import { getPlatformAdapter } from '../../platforms/registry.js'
import { disconnectPlatform } from '../../services/connectionService.js'
import { assertAccess } from '../../utilities/access.js'
import { createGbpOauthEndpoints } from '../createGbpOauthEndpoints.js'

const buildOptions = (over: Record<string, unknown> = {}): NormalizedPluginOptions =>
  ({
    admin: { route: '/admin' },
    api: { basePath: '/socials' },
    platforms: {
      gbp: {
        clientId: 'cid',
        clientSecret: 'sec',
        enabled: true,
        redirectUri: 'https://h/gbp',
        ...over,
      },
    },
  }) as unknown as NormalizedPluginOptions

const mkReq = (over: { cookie?: string; search?: Record<string, string> } = {}): PayloadRequest =>
  ({
    headers: new Headers(over.cookie ? { cookie: over.cookie } : {}),
    payload: { logger: undefined },
    searchParams: new URLSearchParams(over.search ?? {}),
  }) as unknown as PayloadRequest

const adapter = {
  buildAuthorizeUrl: vi.fn().mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth'),
  exchangeCallback: vi.fn().mockResolvedValue({}),
  isConnected: vi.fn().mockResolvedValue({ connected: true }),
  revokeAuthorization: vi.fn().mockResolvedValue({ affectedPlatforms: ['gbp'] }),
}

const find = (over: Record<string, unknown>, suffix: string): Endpoint => {
  const e = createGbpOauthEndpoints(buildOptions(over)).find((x) => x.path === `/socials${suffix}`)
  if (!e) {
    throw new Error(`no endpoint ${suffix}`)
  }
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
  vi.mocked(getPlatformAdapter).mockReturnValue(adapter as never)
})

describe('gbp oauth start', () => {
  it('returns the authorize URL and sets the state cookie', async () => {
    const res = await find({}, '/gbp/oauth/start').handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(body.state).toBeUndefined()
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${STATE_COOKIE_NAME}=[a-f0-9]{48}`))
  })
})

describe('gbp oauth callback', () => {
  it('exchanges and redirects on a state match', async () => {
    const res = await find({}, '/gbp/oauth/callback').handler(
      mkReq({ cookie: `${STATE_COOKIE_NAME}=s1`, search: { code: 'c', state: 's1' } }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin?connected=gbp')
    expect(adapter.exchangeCallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'c' }))
  })

  it('403s on a state mismatch', async () => {
    const res = await find({}, '/gbp/oauth/callback').handler(
      mkReq({ cookie: `${STATE_COOKIE_NAME}=other`, search: { code: 'c', state: 's1' } }),
    )
    expect(res.status).toBe(403)
    expect(adapter.exchangeCallback).not.toHaveBeenCalled()
  })
})

describe('gbp disconnect', () => {
  it('clears the stored credentials', async () => {
    const res = await find({}, '/gbp/disconnect').handler(mkReq())
    expect(res.status).toBe(200)
    expect(disconnectPlatform).toHaveBeenCalledWith(expect.anything(), 'gbp')
  })
})

describe('factory gating', () => {
  it('mounts disconnect plus start and callback for an OAuth config', () => {
    expect(
      createGbpOauthEndpoints(buildOptions())
        .map((e) => e.path)
        .sort(),
    ).toEqual([
      '/socials/gbp/disconnect',
      '/socials/gbp/oauth/callback',
      '/socials/gbp/oauth/start',
    ])
  })

  it('mounts only disconnect for a service-account-only deployment', () => {
    const eps = createGbpOauthEndpoints(
      buildOptions({
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        serviceAccount: { clientEmail: 'svc' },
      }),
    )
    expect(eps).toHaveLength(1)
    expect(eps[0]?.path).toBe('/socials/gbp/disconnect')
  })

  it('returns nothing when GBP is disabled', () => {
    expect(createGbpOauthEndpoints(buildOptions({ enabled: false }))).toEqual([])
  })
})
