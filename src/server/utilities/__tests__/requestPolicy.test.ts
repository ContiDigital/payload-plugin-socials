import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedRateLimitConfig } from '../../../types/index.js'

import { isRetryableNetworkError, policyFetch } from '../requestPolicy.js'

const config = (over: Partial<NormalizedRateLimitConfig> = {}): NormalizedRateLimitConfig => ({
  baseRetryDelayMs: 1,
  enabled: true,
  jitterFactor: 0,
  maxConcurrency: 1,
  maxRequestsPerMinute: 60,
  maxRetries: 1,
  maxRetryDelayMs: 10,
  requestTimeoutMs: 1000,
  ...over,
})

const payload = {} as Payload

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('policyFetch', () => {
  it('bounds concurrency per Payload instance and scope', async () => {
    let releaseFirst: ((value: Response) => void) | undefined
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValueOnce(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    const first = policyFetch({
      config: config(),
      input: 'https://example.com/1',
      payload,
      scope: 'x',
    })
    const second = policyFetch({
      config: config(),
      input: 'https://example.com/2',
      payload,
      scope: 'x',
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFirst?.(new Response('{}'))
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honors request timeouts', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                reject(
                  init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'),
                )
              },
              { once: true },
            )
          }),
      ),
    )
    const pending = policyFetch({
      config: config({ requestTimeoutMs: 25 }),
      input: 'https://example.com/slow',
      payload: {} as Payload,
      scope: 'timeout',
    })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('can disable limiter enforcement without disabling the timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await policyFetch({
      config: config({ enabled: false }),
      input: 'https://example.com',
      payload,
      scope: 'disabled',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('acquires and releases a host-provided distributed request lease', async () => {
    const release = vi.fn()
    const acquireRequestLease = vi.fn().mockResolvedValue({ release })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')))
    await policyFetch({
      config: config({ acquireRequestLease }),
      input: 'https://example.com',
      payload,
      scope: 'meta:facebook',
    })
    expect(acquireRequestLease).toHaveBeenCalledWith({
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      scope: 'meta:facebook',
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the distributed lease when the outbound request fails', async () => {
    const release = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')))
    await expect(
      policyFetch({
        config: config({ acquireRequestLease: vi.fn().mockResolvedValue({ release }) }),
        input: 'https://example.com',
        payload,
        scope: 'meta:facebook',
      }),
    ).rejects.toThrow('network down')
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('isRetryableNetworkError', () => {
  it('classifies timeout and nested socket codes', () => {
    expect(isRetryableNetworkError(new DOMException('slow', 'TimeoutError'))).toBe(true)
    expect(isRetryableNetworkError({ cause: { code: 'ECONNRESET' } })).toBe(true)
    expect(isRetryableNetworkError(new Error('validation failed'))).toBe(false)
  })
})
