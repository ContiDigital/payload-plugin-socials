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

const SCOPE = 'https://www.googleapis.com/auth/business.manage'

const options = {
  platforms: {
    gbp: { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://host/gbp/cb' },
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

describe('gbp oauth — buildAuthorizeUrl', () => {
  it('requests offline access with forced consent and the business.manage scope', () => {
    const url = new URL(buildAuthorizeUrl(options, { state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://host/gbp/cb')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(SCOPE)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('exposes the state cookie constants', () => {
    expect(STATE_COOKIE_NAME).toBe('socials_gbp_oauth_state')
    expect(STATE_COOKIE_TTL_SECONDS).toBe(600)
  })
})

describe('gbp oauth — exchangeCodeForTokens', () => {
  it('persists the access and refresh tokens on success', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        access_token: 'AT',
        expires_in: 3600,
        refresh_token: 'RT',
        scope: SCOPE,
        token_type: 'Bearer',
      }),
    )
    const result = await exchangeCodeForTokens({ code: 'c', options, payload, req })
    expect(result.scopes).toEqual([SCOPE])
    expect(result.accessTokenExpiresAt).toBeTypeOf('string')
    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'gbp',
      expect.objectContaining({ accessToken: 'AT', refreshToken: 'RT' }),
    )
  })

  it('throws and records when the token endpoint fails', async () => {
    fetchMock.mockResolvedValueOnce(errRes(401))
    await expect(exchangeCodeForTokens({ code: 'c', options, payload, req })).rejects.toThrow(
      /token exchange failed: 401/,
    )
    expect(recordConnectionError).toHaveBeenCalled()
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('hard-fails when the business.manage scope was not granted', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        access_token: 'AT',
        expires_in: 3600,
        refresh_token: 'RT',
        scope: 'openid',
        token_type: 'Bearer',
      }),
    )
    await expect(exchangeCodeForTokens({ code: 'c', options, payload, req })).rejects.toThrow(
      /did not grant the required/,
    )
    expect(recordConnectionError).toHaveBeenCalled()
  })

  it('fails clearly when Google returns no refresh token', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ access_token: 'AT', expires_in: 3600, scope: SCOPE, token_type: 'Bearer' }),
    )
    await expect(exchangeCodeForTokens({ code: 'c', options, payload, req })).rejects.toThrow(
      /did not return a refresh_token/,
    )
    expect(recordConnectionError).toHaveBeenCalled()
    expect(saveCredentials).not.toHaveBeenCalled()
  })
})
