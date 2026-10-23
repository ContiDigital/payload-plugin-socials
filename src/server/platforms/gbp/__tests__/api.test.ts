import type { Payload } from 'payload'

import { generateKeyPairSync } from 'node:crypto'
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
import { gbpJson, getGbpAccessToken, makeGbpRequest } from '../api.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const rateLimit = { baseRetryDelayMs: 0, jitterFactor: 0, maxRetries: 2, maxRetryDelayMs: 0 }

const buildOptions = (gbp: Record<string, unknown>): NormalizedPluginOptions =>
  ({ platforms: { gbp }, rateLimit }) as unknown as NormalizedPluginOptions

const okJson = (data: unknown, status = 200): Response =>
  ({
    json: () => Promise.resolve(data),
    ok: true,
    status,
    text: () => Promise.resolve(''),
  }) as unknown as Response
const errResText = (status: number, text = 'err'): Response =>
  ({
    headers: { get: () => null },
    json: () => Promise.resolve({}),
    ok: false,
    status,
    text: () => Promise.resolve(text),
  }) as unknown as Response
const errResJson = (status: number, obj: unknown): Response =>
  ({
    headers: { get: () => null },
    json: () => Promise.resolve(obj),
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(obj)),
  }) as unknown as Response

const fetchMock = vi.fn<typeof fetch>()
let payload: Payload

/** Route the OAuth token endpoint to a fixed token; serve everything else from a queue. */
const routeRequests = (queue: Response[]): void => {
  fetchMock.mockImplementation((input) => {
    if (input === TOKEN_URL) {
      return Promise.resolve(okJson({ access_token: 'tok', expires_in: 3600 }))
    }
    return Promise.resolve(queue.shift() ?? okJson({}))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  payload = {} as Payload
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getGbpAccessToken — OAuth path', () => {
  it('refreshes once, caches, and reuses the cached token', async () => {
    const options = buildOptions({ clientId: 'cid', clientSecret: 'sec' })
    vi.mocked(getCredentials).mockResolvedValue({ refreshToken: 'rt' } as never)
    fetchMock.mockResolvedValue(
      okJson({ access_token: 'oauth_AT', expires_in: 3600, token_type: 'Bearer' }),
    )

    const first = await getGbpAccessToken(payload, options)
    expect(first).toBe('oauth_AT')
    expect(saveCredentials).toHaveBeenCalledWith(
      payload,
      options,
      'gbp',
      expect.objectContaining({ accessToken: 'oauth_AT', updateAccount: false }),
    )

    const callsSoFar = fetchMock.mock.calls.length
    const second = await getGbpAccessToken(payload, options)
    expect(second).toBe('oauth_AT')
    expect(fetchMock.mock.calls.length).toBe(callsSoFar) // served from cache
  })

  it('throws and records when the refresh fails', async () => {
    const options = buildOptions({ clientId: 'cid', clientSecret: 'sec' })
    vi.mocked(getCredentials).mockResolvedValue({ refreshToken: 'rt' } as never)
    fetchMock.mockResolvedValueOnce(errResText(401))
    await expect(getGbpAccessToken(payload, options)).rejects.toThrow(/OAuth refresh failed: 401/)
    expect(recordConnectionError).toHaveBeenCalled()
  })
})

describe('getGbpAccessToken — service-account path', () => {
  it('mints a JWT-bearer token and signs a valid assertion', async () => {
    const options = buildOptions({ serviceAccount: { clientEmail: 'svc@x.iam', privateKey } })
    fetchMock.mockResolvedValue(okJson({ access_token: 'sa_AT', expires_in: 3600 }))

    const token = await getGbpAccessToken(payload, options)
    expect(token).toBe('sa_AT')

    const body = new URLSearchParams(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = body.get('assertion') ?? ''
    for (const segment of assertion.split('.')) {
      expect(segment).toMatch(/^[\w-]+$/)
    }
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
    expect(claims.iss).toBe('svc@x.iam')
    expect(claims.aud).toBe(TOKEN_URL)
  })

  it('sets the sub claim when impersonating', async () => {
    const options = buildOptions({
      serviceAccount: { clientEmail: 'svc@x.iam', impersonate: 'user@dom.com', privateKey },
    })
    fetchMock.mockResolvedValue(okJson({ access_token: 'sa_AT', expires_in: 3600 }))
    await getGbpAccessToken(payload, options)
    const assertion =
      new URLSearchParams(fetchMock.mock.calls[0]?.[1]?.body as string).get('assertion') ?? ''
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString())
    expect(claims.sub).toBe('user@dom.com')
  })

  it('handles a private key with escaped newlines', async () => {
    const escaped = privateKey.replace(/\n/g, '\\n')
    const options = buildOptions({
      serviceAccount: { clientEmail: 'svc@x.iam', privateKey: escaped },
    })
    fetchMock.mockResolvedValue(okJson({ access_token: 'sa_AT', expires_in: 3600 }))
    expect(await getGbpAccessToken(payload, options)).toBe('sa_AT')
  })

  it('throws and records when the JWT exchange fails', async () => {
    const options = buildOptions({ serviceAccount: { clientEmail: 'svc@x.iam', privateKey } })
    fetchMock.mockResolvedValueOnce(errResText(401))
    await expect(getGbpAccessToken(payload, options)).rejects.toThrow(
      /service-account JWT exchange failed: 401/,
    )
    expect(recordConnectionError).toHaveBeenCalled()
  })
})

describe('getGbpAccessToken — no credentials', () => {
  it('throws a clear error when neither OAuth nor a service account is configured', async () => {
    await expect(getGbpAccessToken(payload, buildOptions({}))).rejects.toThrow(
      /No GBP access token available/,
    )
  })
})

describe('makeGbpRequest', () => {
  const saOptions = () => buildOptions({ serviceAccount: { clientEmail: 'svc@x.iam', privateKey } })

  it('returns a successful response directly', async () => {
    routeRequests([okJson({ data: 1 })])
    const res = await makeGbpRequest(payload, saOptions(), 'https://mybusiness.googleapis.com/v4/x')
    expect(res.ok).toBe(true)
  })

  it('clears the token cache and retries once on a 401', async () => {
    routeRequests([errResText(401), okJson({ ok: 1 })])
    const res = await makeGbpRequest(payload, saOptions(), 'https://host/x')
    expect(res.ok).toBe(true)
  })

  it('retries a retryable 500 then succeeds', async () => {
    routeRequests([errResText(500), okJson({ ok: 1 })])
    const res = await makeGbpRequest(payload, saOptions(), 'https://host/x')
    expect(res.ok).toBe(true)
  })

  it('does not replay a POST after a 5xx response', async () => {
    routeRequests([errResText(500), okJson({ ok: 1 })])
    const res = await makeGbpRequest(payload, saOptions(), 'https://host/x', {
      init: { method: 'POST' },
    })
    expect(res.status).toBe(500)
    const apiCalls = fetchMock.mock.calls.filter(([input]) => input !== TOKEN_URL)
    expect(apiCalls).toHaveLength(1)
  })

  it('returns a non-retryable 400 without retrying', async () => {
    routeRequests([errResText(400)])
    const res = await makeGbpRequest(payload, saOptions(), 'https://host/x')
    expect(res.status).toBe(400)
  })
})

describe('gbpJson', () => {
  const saOptions = () => buildOptions({ serviceAccount: { clientEmail: 'svc@x.iam', privateKey } })

  it('parses a JSON body', async () => {
    routeRequests([okJson({ value: 42 })])
    expect(await gbpJson(payload, saOptions(), 'https://host/x')).toEqual({ value: 42 })
  })

  it('returns undefined for a 204', async () => {
    routeRequests([okJson(undefined, 204)])
    expect(await gbpJson(payload, saOptions(), 'https://host/x')).toBeUndefined()
  })

  it('throws a structured error with the upstream status code', async () => {
    routeRequests([errResJson(400, { error: { message: 'bad arg', status: 'INVALID_ARGUMENT' } })])
    const err = await gbpJson(payload, saOptions(), 'https://host/x').catch((e: unknown) => e)
    expect((err as { statusCode: number }).statusCode).toBe(400)
    expect((err as { upstreamCode: string }).upstreamCode).toBe('INVALID_ARGUMENT')
  })

  it('falls back to raw text when the error body is not JSON', async () => {
    routeRequests([errResText(404, 'plain not found')])
    const err = await gbpJson(payload, saOptions(), 'https://host/x').catch((e: unknown) => e)
    expect((err as { statusCode: number }).statusCode).toBe(404)
    expect((err as { upstreamMessage: string }).upstreamMessage).toBe('plain not found')
  })
})
