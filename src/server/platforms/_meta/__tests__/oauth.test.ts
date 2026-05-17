import type { Payload, PayloadRequest } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../../services/connectionService.js', () => ({
  recordConnectionError: vi.fn(),
  saveCredentials: vi.fn(),
}))

import { recordConnectionError, saveCredentials } from '../../../services/connectionService.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../oauth.js'

const buildOptions = (over: Record<string, unknown> = {}): NormalizedPluginOptions =>
  ({
    platforms: {
      facebook: {
        apiVersion: 'v25.0',
        appId: 'fb_app',
        appSecret: 'fb_sec',
        redirectUri: 'https://host/fb/cb',
        scopes: ['pages_manage_posts', 'pages_show_list'],
      },
      instagram: {
        apiVersion: 'v25.0',
        appId: 'ig_app',
        appSecret: 'ig_sec',
        redirectUri: 'https://host/ig/cb',
        scopes: ['instagram_basic', 'instagram_content_publish'],
        ...over,
      },
    },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const payload = {} as Payload
const req = {} as PayloadRequest

const okJson = (data: unknown): Response =>
  ({
    json: () => Promise.resolve(data),
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
  }) as unknown as Response
const errRes = (status: number, text = 'err'): Response =>
  ({
    json: () => Promise.resolve({}),
    ok: false,
    status,
    text: () => Promise.resolve(text),
  }) as unknown as Response

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('meta oauth — buildAuthorizeUrl', () => {
  it('builds the Facebook Login dialog URL for instagram', () => {
    const url = new URL(buildAuthorizeUrl(options, { platform: 'instagram', state: 's1' }))
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth')
    expect(url.searchParams.get('client_id')).toBe('ig_app')
    expect(url.searchParams.get('redirect_uri')).toBe('https://host/ig/cb')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('instagram_basic,instagram_content_publish')
    expect(url.searchParams.get('state')).toBe('s1')
  })

  it('throws when appId or redirectUri is missing', () => {
    const bad = buildOptions({ appId: '', redirectUri: '' })
    expect(() => buildAuthorizeUrl(bad, { platform: 'instagram', state: 's' })).toThrow(
      /requires platforms\.instagram/,
    )
  })
})

describe('meta oauth — exchangeCodeForTokens', () => {
  it('runs the short then long token exchange, introspects scopes, and persists', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'short_AT', token_type: 'bearer' }))
      .mockResolvedValueOnce(
        okJson({ access_token: 'long_AT', expires_in: 5_184_000, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(
        okJson({ data: { scopes: ['instagram_basic', 'instagram_content_publish'] } }),
      )

    const result = await exchangeCodeForTokens({
      code: 'c',
      options,
      payload,
      platform: 'instagram',
      req,
    })

    expect(result.scopes).toEqual(['instagram_basic', 'instagram_content_publish'])
    expect(result.accessTokenExpiresAt).toBeTypeOf('string')
    // Long-lived token (not the short-lived one) is what gets stored.
    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'instagram',
      expect.objectContaining({ accessToken: 'long_AT' }),
    )
    // First call is the short-lived grant; second is the fb_exchange_token grant.
    expect(fetchMock.mock.calls[1]?.[0]).toContain('grant_type=fb_exchange_token')
  })

  it('records an error and throws when the short-lived exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(errRes(401))
    await expect(
      exchangeCodeForTokens({ code: 'c', options, payload, platform: 'facebook', req }),
    ).rejects.toThrow(/short-lived token exchange failed: 401/)
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'facebook', expect.anything())
  })

  it('throws when the long-lived exchange fails', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'short_AT', token_type: 'bearer' }))
      .mockResolvedValueOnce(errRes(500))
    await expect(
      exchangeCodeForTokens({ code: 'c', options, payload, platform: 'instagram', req }),
    ).rejects.toThrow(/long-lived token exchange failed: 500/)
    expect(recordConnectionError).toHaveBeenCalled()
  })

  it('throws when the short-lived response carries no access token', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ token_type: 'bearer' }))
    await expect(
      exchangeCodeForTokens({ code: 'c', options, payload, platform: 'instagram', req }),
    ).rejects.toThrow(/no access_token/)
  })

  it('still succeeds when scope introspection fails (best-effort)', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'short_AT', token_type: 'bearer' }))
      .mockResolvedValueOnce(okJson({ access_token: 'long_AT', token_type: 'bearer' }))
      .mockRejectedValueOnce(new Error('debug_token down'))

    const result = await exchangeCodeForTokens({
      code: 'c',
      options,
      payload,
      platform: 'instagram',
      req,
    })
    expect(result.scopes).toEqual([])
    expect(saveCredentials).toHaveBeenCalled()
  })
})
