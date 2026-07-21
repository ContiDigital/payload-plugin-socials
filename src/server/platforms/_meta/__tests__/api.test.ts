import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

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
import { getMetaAccessToken, makeMetaRequest, metaJson } from '../api.js'

const rateLimit = { baseRetryDelayMs: 0, jitterFactor: 0, maxRetries: 2, maxRetryDelayMs: 0 }

const buildOptions = (over: Record<string, unknown> = {}): NormalizedPluginOptions =>
  ({
    platforms: {
      facebook: {
        apiVersion: 'v25.0',
        appId: 'aid',
        appSecret: 'asec',
        systemUserAccessToken: 'SYS',
        ...over,
      },
      instagram: {
        apiVersion: 'v25.0',
        appId: 'aid',
        appSecret: 'asec',
        systemUserAccessToken: 'SYS',
        ...over,
      },
    },
    rateLimit,
  }) as unknown as NormalizedPluginOptions

const res = (status: number, body: unknown, headerInit?: Record<string, string>): Response => {
  const r = {
    clone() {
      return r
    },
    headers: new Headers(headerInit ?? {}),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  } as unknown as Response
  return r
}

const fetchMock = vi.fn<typeof fetch>()
let payload: Payload
let queue: Response[]

beforeEach(() => {
  vi.clearAllMocks()
  payload = {} as Payload
  queue = []
  fetchMock.mockImplementation(() => Promise.resolve(queue.shift() ?? res(200, {})))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getMetaAccessToken', () => {
  it('returns the configured system-user token without touching credentials', async () => {
    const token = await getMetaAccessToken(payload, buildOptions(), 'instagram')
    expect(token).toBe('SYS')
    expect(getCredentials).not.toHaveBeenCalled()
  })

  it('prefers a stored user token that is still valid', async () => {
    vi.mocked(getCredentials).mockResolvedValue({
      accessToken: 'USER_AT',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never)
    const token = await getMetaAccessToken(
      payload,
      buildOptions({ systemUserAccessToken: '' }),
      'facebook',
    )
    expect(token).toBe('USER_AT')
  })

  it('re-exchanges an expired user token for a fresh long-lived token', async () => {
    const options = buildOptions({ systemUserAccessToken: '' })
    vi.mocked(getCredentials).mockResolvedValue({
      accessToken: 'OLD',
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    } as never)
    queue = [res(200, { access_token: 'NEW_LL', expires_in: 5_184_000, token_type: 'bearer' })]
    const token = await getMetaAccessToken(payload, options, 'instagram')
    expect(token).toBe('NEW_LL')
    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'instagram',
      expect.objectContaining({ accessToken: 'NEW_LL', updateAccount: false }),
    )
  })

  it('throws when no credentials are available', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    await expect(
      getMetaAccessToken(payload, buildOptions({ systemUserAccessToken: '' }), 'instagram'),
    ).rejects.toThrow(/No Meta access token available/)
  })

  it('records and throws when the long-lived exchange fails', async () => {
    vi.mocked(getCredentials).mockResolvedValue({ accessToken: 'OLD' } as never)
    queue = [res(401, 'denied')]
    await expect(
      getMetaAccessToken(payload, buildOptions({ systemUserAccessToken: '' }), 'facebook'),
    ).rejects.toThrow(/long-lived token exchange failed: 401/)
    expect(recordConnectionError).toHaveBeenCalled()
  })
})

describe('makeMetaRequest', () => {
  it('hits the versioned Graph host and attaches appsecret_proof', async () => {
    queue = [res(200, { id: '1' })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/me')
    expect(r.ok).toBe(true)
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain('https://graph.facebook.com/v25.0/me')
    expect(url).toContain('appsecret_proof=')
  })

  it('omits appsecret_proof when asked to', async () => {
    queue = [res(200, {})]
    await makeMetaRequest(payload, buildOptions(), 'facebook', '/x', { skipAppsecretProof: true })
    expect(fetchMock.mock.calls[0]?.[0] as string).not.toContain('appsecret_proof')
  })

  it('uses an explicit Page token for Authorization and appsecret_proof', async () => {
    queue = [res(200, {})]
    await makeMetaRequest(payload, buildOptions(), 'facebook', '/page/feed', {
      accessToken: 'PAGE_TOKEN',
    })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(typeof url === 'string' ? url : '').toContain('appsecret_proof=')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer PAGE_TOKEN')
  })

  it('invalidates the token and retries once on an expired-token (code 190) error', async () => {
    queue = [res(400, { error: { code: 190 } }), res(200, { ok: 1 })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/x')
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off and retries a retryable 500', async () => {
    queue = [res(500, { error: { code: 2 } }), res(200, { ok: 1 })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/x')
    expect(r.ok).toBe(true)
  })

  it('does not replay a POST after a 5xx response', async () => {
    queue = [res(500, { error: { code: 2 } }), res(200, { ok: 1 })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/x', {
      init: { method: 'POST' },
    })
    expect(r.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a non-retryable error response with a readable body', async () => {
    queue = [res(400, { error: { code: 100, message: 'bad param' } })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/x')
    expect(r.status).toBe(400)
    expect(await r.text()).toContain('bad param')
  })

  it('tolerates a quota usage header without failing', async () => {
    queue = [res(200, {}, { 'x-app-usage': JSON.stringify({ call_count: 90 }) })]
    const r = await makeMetaRequest(payload, buildOptions(), 'instagram', '/x')
    expect(r.ok).toBe(true)
  })
})

describe('metaJson', () => {
  it('parses a successful JSON response', async () => {
    queue = [res(200, { value: 1 })]
    expect(await metaJson(payload, buildOptions(), 'instagram', '/x')).toEqual({ value: 1 })
  })

  it('throws a structured error carrying the upstream code and message', async () => {
    queue = [res(400, { error: { code: 100, message: 'Invalid parameter' } })]
    const err = await metaJson(payload, buildOptions(), 'instagram', '/x').catch((e: unknown) => e)
    expect((err as { statusCode: number }).statusCode).toBe(400)
    expect((err as { upstreamCode: number }).upstreamCode).toBe(100)
    expect((err as Error).message).toContain('Invalid parameter')
  })

  it('classifies a POST 5xx response as an unknown outcome', async () => {
    queue = [res(500, { error: { code: 2, message: 'failed' } })]
    await expect(
      metaJson(payload, buildOptions(), 'instagram', '/x', { method: 'POST' }),
    ).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
  })

  it('rejects a 2xx response containing an embedded Graph error', async () => {
    queue = [res(200, { error: { code: 100, message: 'partial failure' } })]
    await expect(metaJson(payload, buildOptions(), 'instagram', '/x')).rejects.toMatchObject({
      statusCode: 502,
      upstreamCode: 100,
    })
  })
})
