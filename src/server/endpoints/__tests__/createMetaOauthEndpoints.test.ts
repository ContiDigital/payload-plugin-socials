import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))
vi.mock('../../services/connectionService.js', () => ({ disconnectPlatform: vi.fn() }))

import { STATE_COOKIE_NAMES } from '../../platforms/_meta/oauth.js'
import { getPlatformAdapter } from '../../platforms/registry.js'
import { disconnectPlatform } from '../../services/connectionService.js'
import { assertAccess } from '../../utilities/access.js'
import { PlatformApiError } from '../../utilities/errors.js'
import {
  createMetaOauthEndpoints,
  createMetaOauthEndpointsForPlatform,
} from '../createMetaOauthEndpoints.js'

const buildOptions = (over: Record<string, unknown> = {}): NormalizedPluginOptions =>
  ({
    admin: { route: '/admin' },
    api: { basePath: '/socials' },
    platforms: {
      facebook: { appId: 'fa', appSecret: 'fs', enabled: true, redirectUri: 'https://h/fb' },
      instagram: { appId: 'ia', appSecret: 'is', enabled: true, redirectUri: 'https://h/ig' },
      ...over,
    },
  }) as unknown as NormalizedPluginOptions

const mkReq = (over: { cookie?: string; search?: Record<string, string> } = {}): PayloadRequest =>
  ({
    headers: new Headers(over.cookie ? { cookie: over.cookie } : {}),
    payload: { logger: undefined },
    searchParams: new URLSearchParams(over.search ?? {}),
  }) as unknown as PayloadRequest

const adapter = {
  buildAuthorizeUrl: vi.fn().mockResolvedValue('https://www.facebook.com/v25.0/dialog/oauth'),
  exchangeCallback: vi.fn().mockResolvedValue({}),
  isConnected: vi.fn().mockResolvedValue({ connected: true }),
  revokeAuthorization: vi.fn().mockResolvedValue({ affectedPlatforms: ['instagram'] }),
}

const ig = (over: Record<string, unknown> = {}) =>
  createMetaOauthEndpointsForPlatform(buildOptions(over), 'instagram')
const find = (eps: Endpoint[], suffix: string): Endpoint => {
  const e = eps.find((x) => x.path === `/socials${suffix}`)
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

describe('meta oauth start', () => {
  it('returns the authorize URL with a per-platform state cookie', async () => {
    const res = await find(ig(), '/instagram/oauth/start').handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      platform: 'instagram',
      url: 'https://www.facebook.com/v25.0/dialog/oauth',
    })
    expect(body.state).toBeUndefined()
    expect(res.headers.get('set-cookie')).toMatch(
      new RegExp(`${STATE_COOKIE_NAMES.instagram}=[a-f0-9]{48}`),
    )
  })

  it('propagates an admin access rejection', async () => {
    vi.mocked(assertAccess).mockRejectedValueOnce(
      Object.assign(new Error('no'), { statusCode: 403 }),
    )
    const res = await find(ig(), '/instagram/oauth/start').handler(mkReq())
    expect(res.status).toBe(403)
  })
})

describe('meta oauth callback', () => {
  it('exchanges and redirects on a state match', async () => {
    const res = await find(ig(), '/instagram/oauth/callback').handler(
      mkReq({ cookie: `${STATE_COOKIE_NAMES.instagram}=s1`, search: { code: 'c', state: 's1' } }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin?connected=instagram')
    expect(adapter.exchangeCallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'c' }))
  })

  it('403s on a state mismatch', async () => {
    const res = await find(ig(), '/instagram/oauth/callback').handler(
      mkReq({
        cookie: `${STATE_COOKIE_NAMES.instagram}=other`,
        search: { code: 'c', state: 's1' },
      }),
    )
    expect(res.status).toBe(403)
    expect(adapter.exchangeCallback).not.toHaveBeenCalled()
  })

  it('returns the provider error and clears the cookie', async () => {
    const res = await find(ig(), '/instagram/oauth/callback').handler(
      mkReq({ search: { error: 'access_denied' } }),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('meta disconnect', () => {
  it('clears the stored credentials for the platform', async () => {
    const res = await find(ig(), '/instagram/disconnect').handler(mkReq())
    expect(res.status).toBe(200)
    expect(disconnectPlatform).toHaveBeenCalledWith(expect.anything(), 'instagram')
  })

  it('returns upstreamRevoked true when revoke succeeds', async () => {
    adapter.revokeAuthorization.mockResolvedValueOnce({ affectedPlatforms: ['instagram'] })
    const res = await find(ig(), '/instagram/disconnect').handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, upstreamRevoked: true })
    expect(disconnectPlatform).toHaveBeenCalledWith(expect.anything(), 'instagram')
  })

  it('returns HTTP 200 with upstreamRevoked false when revoke throws, still disconnects locally', async () => {
    adapter.revokeAuthorization.mockRejectedValueOnce(
      new PlatformApiError({
        message: 'Meta authorization revocation failed: HTTP 503',
        platform: 'instagram',
        raw: 'upstream down',
        retryable: true,
        statusCode: 502,
        upstreamCode: 503,
      }),
    )
    const res = await find(ig(), '/instagram/disconnect').handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, upstreamRevoked: false })
    // Local disconnect MUST still be called even though revoke failed
    expect(disconnectPlatform).toHaveBeenCalledWith(expect.anything(), 'instagram')
  })
})

describe('factory gating', () => {
  it('mounts disconnect plus start and callback for a full OAuth config', () => {
    const eps = ig()
    expect(eps.map((e) => e.path).sort()).toEqual([
      '/socials/instagram/disconnect',
      '/socials/instagram/oauth/callback',
      '/socials/instagram/oauth/start',
    ])
  })

  it('mounts only disconnect for a system-user deployment without OAuth creds', () => {
    const eps = ig({
      instagram: {
        appId: '',
        appSecret: '',
        enabled: true,
        redirectUri: '',
        systemUserAccessToken: 'sys',
      },
    })
    expect(eps).toHaveLength(1)
    expect(eps[0]?.path).toBe('/socials/instagram/disconnect')
  })

  it('returns nothing for a disabled platform', () => {
    expect(
      createMetaOauthEndpointsForPlatform(
        buildOptions({ instagram: { enabled: false } }),
        'instagram',
      ),
    ).toEqual([])
  })

  it('combines both Meta platforms', () => {
    expect(createMetaOauthEndpoints(buildOptions())).toHaveLength(6)
  })
})
