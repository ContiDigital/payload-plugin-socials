import type { Payload, PayloadRequest } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../../services/connectionService.js', () => ({
  recordConnectionError: vi.fn(),
  saveCredentials: vi.fn(),
}))

import { recordConnectionError, saveCredentials } from '../../../services/connectionService.js'
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  STATE_COOKIE_NAME,
  STATE_COOKIE_TTL_SECONDS,
} from '../oauth.js'
import {
  parsePinterestTokenResponseScopes,
  serializePinterestAuthorizationScopes,
} from '../scopes.js'

const options = {
  platforms: {
    pinterest: {
      clientId: 'cid',
      clientSecret: 'sec',
      environment: 'production',
      redirectUri: 'https://host/cb',
      scopes: ['pins:read', 'pins:write', 'user_accounts:read'],
    },
  },
} as unknown as NormalizedPluginOptions

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

describe('pinterest oauth — buildAuthorizeUrl', () => {
  it('builds the authorize URL with continuous refresh and the configured scopes', () => {
    const url = new URL(buildAuthorizeUrl(options, { state: 'st8' }))
    expect(url.origin + url.pathname).toBe('https://www.pinterest.com/oauth/')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://host/cb')
    expect(url.searchParams.get('refresh_on')).toBe('true')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('pins:read,pins:write,user_accounts:read')
    expect(url.searchParams.get('state')).toBe('st8')
  })

  it('exposes the state cookie constants', () => {
    expect(STATE_COOKIE_NAME).toBe('socials_pinterest_oauth_state')
    expect(STATE_COOKIE_TTL_SECONDS).toBe(600)
  })
})

describe('pinterest oauth — exchangeCodeForTokens', () => {
  it('exchanges the code, fetches the account, and persists credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          access_token: 'pina_AT',
          expires_in: 2_592_000,
          refresh_token: 'pinr_RT',
          refresh_token_expires_in: 5_184_000,
          scope: 'pins:read pins:write user_accounts:read',
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(
        okJson({ id: 'acc1', business_name: 'Example Gallery', username: 'examplegallery' }),
      )

    const result = await exchangeCodeForTokens({ code: 'c0de', options, payload, req })

    expect(result.scopes).toEqual(['pins:read', 'pins:write', 'user_accounts:read'])
    expect(result.accountId).toBe('acc1')
    expect(result.accountLabel).toBe('Example Gallery')
    expect(result.accessTokenExpiresAt).toBeTypeOf('string')

    // Token endpoint hit with HTTP Basic client auth.
    const tokenUrl = fetchMock.mock.calls[0]?.[0]
    expect(tokenUrl).toBe('https://api.pinterest.com/v5/oauth/token')
    const tokenInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((tokenInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /)

    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'pinterest',
      expect.objectContaining({
        accessToken: 'pina_AT',
        accountId: 'acc1',
        refreshToken: 'pinr_RT',
      }),
    )
  })

  it('throws and records a connection error when the token endpoint fails', async () => {
    fetchMock.mockResolvedValueOnce(errRes(401, 'bad creds'))
    await expect(exchangeCodeForTokens({ code: 'c', options, payload, req })).rejects.toThrow(
      /token exchange failed: 401/,
    )
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'pinterest', expect.anything())
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('hard-fails when a required scope was genuinely not granted', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ access_token: 'AT', expires_in: 100, scope: 'pins:read', token_type: 'bearer' }),
    )
    await expect(exchangeCodeForTokens({ code: 'c', options, payload, req })).rejects.toThrow(
      /missing required entries/,
    )
    expect(recordConnectionError).toHaveBeenCalled()
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('accepts SPACE-delimited granted scopes (real Pinterest token response)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          access_token: 'AT',
          expires_in: 100,
          refresh_token: 'RT',
          // OAuth 2.0 delimits the token-response scope with spaces, not commas.
          scope: 'pins:read pins:write user_accounts:read',
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(okJson({ id: 'acct', username: 'finesgallery' }))
    await exchangeCodeForTokens({ code: 'c', options, payload, req })
    expect(recordConnectionError).not.toHaveBeenCalled()
    expect(saveCredentials).toHaveBeenCalled()
  })

  it('does not block the connection when Pinterest omits the scope field', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({ access_token: 'AT', expires_in: 100, refresh_token: 'RT', token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(okJson({ id: 'acct', username: 'finesgallery' }))
    await exchangeCodeForTokens({ code: 'c', options, payload, req })
    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'pinterest',
      expect.objectContaining({ scopes: undefined }),
    )
  })

  it('keeps outbound serialization distinct from inbound token-response parsing', () => {
    expect(serializePinterestAuthorizationScopes(['a:read', 'b:write'])).toBe('a:read,b:write')
    expect(parsePinterestTokenResponseScopes('a:read b:write')).toEqual(['a:read', 'b:write'])
    expect(parsePinterestTokenResponseScopes('a:read,b:write')).toEqual(['a:read', 'b:write'])
    expect(parsePinterestTokenResponseScopes('a:read, b:write   c:read')).toEqual([
      'a:read',
      'b:write',
      'c:read',
    ])
    expect(parsePinterestTokenResponseScopes('')).toEqual([])
    expect(parsePinterestTokenResponseScopes(undefined)).toEqual([])
  })

  it('still succeeds when the best-effort account fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          access_token: 'AT',
          expires_in: 100,
          refresh_token: 'RT',
          scope: 'pins:read pins:write user_accounts:read',
          token_type: 'bearer',
        }),
      )
      .mockRejectedValueOnce(new Error('network down'))

    const result = await exchangeCodeForTokens({ code: 'c', options, payload, req })
    expect(result.accountLabel).toBe('')
    expect(saveCredentials).toHaveBeenCalled()
  })
})
