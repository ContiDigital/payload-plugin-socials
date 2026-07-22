import type { PayloadRequest } from 'payload'

import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { PluginError, RateLimitedError, ValidationError } from '../errors.js'
import {
  errorResponse,
  getRouteParam,
  jsonResponse,
  noContentResponse,
  parseRequestBody,
  toResponse,
} from '../http.js'

const fakeReq = (overrides: Record<string, unknown> = {}): PayloadRequest =>
  overrides as unknown as PayloadRequest

describe('jsonResponse', () => {
  it('serializes the body and sets JSON content type + status', async () => {
    const res = jsonResponse({ ok: true }, 201)
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('emits an empty body when given undefined', async () => {
    const res = jsonResponse(undefined)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('merges custom headers', () => {
    const res = jsonResponse({}, 200, { 'x-custom': 'yes' })
    expect(res.headers.get('x-custom')).toBe('yes')
  })
})

describe('noContentResponse / toResponse', () => {
  it('noContentResponse is 204 with no body', async () => {
    const res = noContentResponse()
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('toResponse passes a Response through unchanged', () => {
    const original = jsonResponse({ a: 1 })
    expect(toResponse(original)).toBe(original)
  })

  it('toResponse returns 204 for undefined', () => {
    expect(toResponse(undefined).status).toBe(204)
  })

  it('toResponse wraps a plain value as JSON', async () => {
    const res = toResponse({ b: 2 }, 202)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ b: 2 })
  })
})

describe('errorResponse', () => {
  it('exposes the message verbatim for 4xx errors and does not log', async () => {
    const error = vi.fn()
    const req = fakeReq({ payload: { logger: { error } } })
    const res = errorResponse(req, new ValidationError('missing field'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('missing field')
    expect(error).not.toHaveBeenCalled()
  })

  it('masks 5xx messages and logs server-side', async () => {
    const error = vi.fn()
    const req = fakeReq({ payload: { logger: { error } } })
    const res = errorResponse(req, new PluginError('db exploded', 500))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Internal server error')
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('returns the original safe response when logging through real Pino', async () => {
    const lines: string[] = []
    const logger = pino(
      { level: 'error', timestamp: false },
      { write: (line: string) => lines.push(line) },
    )
    const req = fakeReq({ payload: { logger } })

    const res = errorResponse(req, new PluginError('failure', 500))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(lines).toHaveLength(1)
  })

  it('does not let a host logger failure mask the original error response', async () => {
    const req = fakeReq({
      payload: {
        logger: {
          error: () => {
            throw new Error('logging backend unavailable')
          },
        },
      },
    })

    const res = errorResponse(req, new PluginError('provider failed', 502))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('includes retryAfterSeconds when the error carries it', async () => {
    const req = fakeReq({ payload: { logger: { error: vi.fn() } } })
    const res = errorResponse(req, new RateLimitedError('rate limited', 12))
    expect(res.status).toBe(429)
    expect((await res.json()).retryAfterSeconds).toBe(12)
  })

  it('falls back to 500 + generic message for non-Error throws', async () => {
    const req = fakeReq({ payload: { logger: { error: vi.fn() } } })
    const res = errorResponse(req, 'just a string')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Internal server error')
  })
})

describe('parseRequestBody', () => {
  it('returns req.data when it is a plain object', async () => {
    const body = await parseRequestBody(fakeReq({ data: { a: 1 } }))
    expect(body).toEqual({ a: 1 })
  })

  it('parses req.json() when no data is present', async () => {
    const body = await parseRequestBody(fakeReq({ json: () => Promise.resolve({ b: 2 }) }))
    expect(body).toEqual({ b: 2 })
  })

  it('throws ValidationError when the JSON body is not an object', async () => {
    await expect(
      parseRequestBody(fakeReq({ json: () => Promise.resolve([1, 2]) })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError when JSON parsing fails', async () => {
    await expect(
      parseRequestBody(fakeReq({ json: () => Promise.reject(new Error('bad json')) })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('preserves an inner PluginError thrown during validation', async () => {
    await expect(
      parseRequestBody(fakeReq({ json: () => Promise.resolve('not an object') })),
    ).rejects.toBeInstanceOf(PluginError)
  })

  it('returns an empty object when there is no body source', async () => {
    expect(await parseRequestBody(fakeReq({}))).toEqual({})
  })
})

describe('getRouteParam', () => {
  it('reads a string route param', () => {
    expect(getRouteParam(fakeReq({ routeParams: { id: 'abc' } }), 'id')).toBe('abc')
  })

  it('does not read query params (route params only)', () => {
    expect(
      getRouteParam(
        fakeReq({ searchParams: new URLSearchParams('platform=pinterest') }),
        'platform',
      ),
    ).toBeUndefined()
  })

  it('returns undefined when absent or non-string', () => {
    expect(getRouteParam(fakeReq({}), 'missing')).toBeUndefined()
    expect(getRouteParam(fakeReq({ routeParams: { id: 42 } }), 'id')).toBeUndefined()
  })
})
