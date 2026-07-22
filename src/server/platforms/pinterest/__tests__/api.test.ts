import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

import { PlatformApiError } from '../../../utilities/errors.js'
import { getAccessToken, getPinterestApiBase, makePinterestRequest, pinterestJson } from '../api.js'

vi.mock('../../../services/connectionService.js', () => ({
  getCredentials: vi.fn(),
  recordConnectionError: vi.fn(),
  saveCredentials: vi.fn(),
}))

import {
  getCredentials,
  recordConnectionError,
  saveCredentials,
} from '../../../services/connectionService.js'

const mockedGetCredentials = vi.mocked(getCredentials)
const mockedSaveCredentials = vi.mocked(saveCredentials)
const mockedRecordError = vi.mocked(recordConnectionError)

const options = {
  platforms: {
    pinterest: {
      clientId: 'cid',
      clientSecret: 'csecret',
      enabled: true,
      environment: 'production',
    },
  },
} as unknown as NormalizedPluginOptions

const res = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })

const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: 'AT',
  expires_in: 3600,
  scope: 'pins:read pins:write',
  token_type: 'bearer',
  ...over,
})

/** Serve a fresh token for the oauth endpoint and replay a queue for the API. */
const stubFetch = (apiQueue: Response[], tokenOver: Record<string, unknown> = {}) => {
  let i = 0
  const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) => {
    if (String(url).includes('/v5/oauth/token')) {
      return Promise.resolve(res(tokenBody(tokenOver)))
    }
    const r = apiQueue[Math.min(i, apiQueue.length - 1)]
    i += 1
    return Promise.resolve(r)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

let payload: Payload

beforeEach(() => {
  vi.clearAllMocks()
  // Fresh payload object so the per-instance token cache never leaks between tests.
  payload = {} as Payload
  mockedGetCredentials.mockResolvedValue({ refreshToken: 'pinr_refresh' } as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('getPinterestApiBase', () => {
  it('switches host on environment', () => {
    expect(getPinterestApiBase('sandbox')).toBe('https://api-sandbox.pinterest.com')
    expect(getPinterestApiBase('production')).toBe('https://api.pinterest.com')
  })
})

describe('getAccessToken (refresh + cache)', () => {
  it('runs rotating-token refresh inside the host distributed lock', async () => {
    const withLock = vi.fn(async ({ run }: { run: () => Promise<string> }) => run())
    const coordinated = {
      ...options,
      coordination: { withLock },
    } as NormalizedPluginOptions
    stubFetch([res({ ok: true })], { refresh_token: 'pinr_rotated' })
    await expect(getAccessToken(payload, coordinated)).resolves.toBe('AT')
    expect(withLock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'payload-plugin-socials:pinterest:production:cid:token-refresh',
        ttlMs: 120_000,
      }),
    )
  })

  it('refreshes, persists rotated credentials, and caches the token', async () => {
    stubFetch([res({ ok: true })], { refresh_token: 'pinr_rotated' })
    const token = await getAccessToken(payload, options)
    expect(token).toBe('AT')
    expect(mockedSaveCredentials).toHaveBeenCalledTimes(1)
    const saved = mockedSaveCredentials.mock.calls[0][3] as Record<string, unknown>
    expect(saved.accessToken).toBe('AT')
    expect(saved.refreshToken).toBe('pinr_rotated')
    expect(saved.scopes).toEqual(['pins:read', 'pins:write'])
  })

  it('does not overwrite scope metadata when the refresh response omits scope', async () => {
    stubFetch([res({ ok: true })], { scope: undefined })

    await getAccessToken(payload, options)

    const saved = mockedSaveCredentials.mock.calls[0][3] as Record<string, unknown>
    expect(saved.scopes).toBeUndefined()
  })

  it('returns the cached token on a second call without re-hitting the token endpoint', async () => {
    const fetchMock = stubFetch([res({ ok: true })])
    await getAccessToken(payload, options)
    await getAccessToken(payload, options)
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/oauth/token'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('coalesces concurrent refreshes so rotating refresh tokens are used once', async () => {
    const fetchMock = stubFetch([res({ ok: true })], { refresh_token: 'pinr_rotated' })
    await expect(
      Promise.all([
        getAccessToken(payload, options),
        getAccessToken(payload, options),
        getAccessToken(payload, options),
      ]),
    ).resolves.toEqual(['AT', 'AT', 'AT'])
    const tokenCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/oauth/token'),
    )
    expect(tokenCalls).toHaveLength(1)
    expect(mockedSaveCredentials).toHaveBeenCalledTimes(1)
  })

  it('throws a 401 PlatformApiError when no refresh token is stored', async () => {
    mockedGetCredentials.mockResolvedValue(null as never)
    stubFetch([res({ ok: true })])
    await expect(getAccessToken(payload, options)).rejects.toMatchObject({
      platform: 'pinterest',
      statusCode: 401,
    })
  })

  it('records a connection error and throws when the refresh request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(res({ error: 'invalid_grant' }, 500))),
    )
    await expect(getAccessToken(payload, options)).rejects.toBeInstanceOf(PlatformApiError)
    expect(mockedRecordError).toHaveBeenCalledTimes(1)
  })
})

describe('makePinterestRequest', () => {
  it('attaches the bearer token and returns a 2xx response', async () => {
    const fetchMock = stubFetch([res({ id: 'pin_1' })])
    const response = await makePinterestRequest(payload, options, '/v5/pins', {
      init: { method: 'POST' },
    })
    expect(response.ok).toBe(true)
    const apiCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v5/pins'))
    const headers = (apiCall?.[1] ?? {}).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer AT')
  })

  it('refreshes once and retries on a 401', async () => {
    const fetchMock = stubFetch([res({ error: 'expired' }, 401), res({ id: 'pin_1' })])
    const response = await makePinterestRequest(payload, options, '/v5/pins')
    expect(response.ok).toBe(true)
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/oauth/token'))
    expect(tokenCalls).toHaveLength(2)
  })

  it('honours Retry-After on a 429 and then succeeds', async () => {
    vi.useFakeTimers()
    stubFetch([res({ code: 7 }, 429, { 'retry-after': '2' }), res({ id: 'pin_1' })])
    const pending = makePinterestRequest(payload, options, '/v5/pins')
    await vi.advanceTimersByTimeAsync(2000)
    const response = await pending
    expect(response.ok).toBe(true)
  })

  it('returns the response unchanged for a non-retryable 4xx', async () => {
    stubFetch([res({ code: 1 }, 400)])
    const response = await makePinterestRequest(payload, options, '/v5/pins')
    expect(response.status).toBe(400)
  })

  it('does not replay a POST after an ambiguous network failure', async () => {
    let apiCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        if (String(url).includes('/v5/oauth/token')) {
          return Promise.resolve(res(tokenBody()))
        }
        apiCalls += 1
        return Promise.reject(new Error('socket closed'))
      }),
    )
    await expect(
      makePinterestRequest(payload, options, '/v5/pins', { init: { method: 'POST' } }),
    ).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(apiCalls).toBe(1)
  })
})

describe('pinterestJson', () => {
  it('parses the JSON body on success', async () => {
    stubFetch([res({ id: 'pin_1', title: 'Marble' })])
    const data = await pinterestJson<{ id: string; title: string }>(payload, options, '/v5/pins')
    expect(data).toEqual({ id: 'pin_1', title: 'Marble' })
  })

  it('throws a PlatformApiError carrying the upstream code and message', async () => {
    stubFetch([res({ code: 1, message: 'Invalid parameters' }, 400)])
    await expect(pinterestJson(payload, options, '/v5/pins')).rejects.toMatchObject({
      platform: 'pinterest',
      statusCode: 400,
      upstreamCode: 1,
      upstreamMessage: 'Invalid parameters',
    })
  })

  it('classifies a POST 5xx response as an unknown outcome', async () => {
    stubFetch([res({ message: 'upstream failed' }, 500)])
    await expect(
      pinterestJson(payload, options, '/v5/pins', { method: 'POST' }),
    ).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
  })
})
