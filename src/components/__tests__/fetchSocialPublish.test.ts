import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SOCIAL_PUBLISH_ASYNC_HEADER,
  SOCIAL_PUBLISH_STATUS_HEADER,
  SOCIAL_PUBLISH_STATUS_PENDING,
} from '../../constants.js'
import { fetchSocialPublish } from '../fetchSocialPublish.js'

const endpointBase = '/api/socials'
const url = 'https://app.example/api/socials/compose/publish'
const pending = (location = '/api/socials/requests/42') =>
  Response.json(
    { pending: true },
    {
      headers: {
        Location: location,
        'Retry-After': '1',
        [SOCIAL_PUBLISH_STATUS_HEADER]: SOCIAL_PUBLISH_STATUS_PENDING,
      },
      status: 202,
    },
  )

const fetchMock = vi.fn()
const posts = () => fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { location: { href: 'https://app.example/admin/socials' } })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('fetchSocialPublish', () => {
  it('returns a synchronous response untouched and only announces polling support', async () => {
    const published = Response.json({ publishedRef: { externalId: 'post-1' } })
    fetchMock.mockResolvedValueOnce(published)

    const response = await fetchSocialPublish(url, { body: '{}', method: 'POST' }, { endpointBase })

    expect(response).toBe(published)
    expect(fetchMock).toHaveBeenCalledOnce()
    const headers = fetchMock.mock.calls[0][1].headers as Headers
    expect(headers.get(SOCIAL_PUBLISH_ASYNC_HEADER)).toBe('1')
    expect(headers.get('Content-Type')).toBeNull()
  })

  it('keeps caller headers while adding the polling header', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await fetchSocialPublish(
      url,
      { headers: { 'Content-Type': 'application/json' }, method: 'POST' },
      { endpointBase },
    )

    const headers = fetchMock.mock.calls[0][1].headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get(SOCIAL_PUBLISH_ASYNC_HEADER)).toBe('1')
  })

  it('polls a pending publish past the old request timeout and submits once', async () => {
    const started = Date.now()
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        init.method === 'POST' || Date.now() - started < 35_000
          ? pending()
          : Response.json({ publishedRef: { externalId: 'draft' } }),
      ),
    )

    const result = fetchSocialPublish(url, { body: '{}', method: 'POST' }, { endpointBase })
    await vi.advanceTimersByTimeAsync(36_000)

    expect(await (await result).json()).toEqual({ publishedRef: { externalId: 'draft' } })
    expect(posts()).toHaveLength(1)
    expect(fetchMock.mock.calls[1][0]).toBe('https://app.example/api/socials/requests/42')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'GET',
    })
  })

  it('returns the real provider failure once the deferred request finishes', async () => {
    fetchMock
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(Response.json({ error: 'Invalid photo' }, { status: 400 }))

    const result = fetchSocialPublish(url, { method: 'POST' }, { endpointBase })
    await vi.advanceTimersByTimeAsync(1000)

    const response = await result
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid photo' })
  })

  it('clamps Retry-After into the one to five second band', async () => {
    const slow = pending()
    slow.headers.set('Retry-After', '60')
    fetchMock.mockResolvedValueOnce(slow).mockResolvedValueOnce(Response.json({ ok: true }))

    const result = fetchSocialPublish(url, { method: 'POST' }, { endpointBase })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://attacker.example/api/socials/requests/42',
    '/api/users/42',
    '/api/socials/requests/42?secret=yes',
    '/api/socials/requests/42#fragment',
    '/api/socials/requests/not-a-number',
    '/api/socials/requests/',
  ])('rejects an untrusted status URL %s without polling it', async (location) => {
    fetchMock.mockResolvedValueOnce(pending(location))

    await expect(fetchSocialPublish(url, { method: 'POST' }, { endpointBase })).rejects.toThrow(
      'Invalid publishing status URL',
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects a pending response that carries no status URL', async () => {
    const response = pending()
    response.headers.delete('Location')
    fetchMock.mockResolvedValueOnce(response)

    await expect(fetchSocialPublish(url, { method: 'POST' }, { endpointBase })).rejects.toThrow(
      'Invalid publishing status URL',
    )
  })

  it('does not mistake an unrelated 202 for a deferred publish', async () => {
    const accepted = Response.json({ scheduled: true }, { status: 202 })
    fetchMock.mockResolvedValueOnce(accepted)

    expect(await fetchSocialPublish(url, { method: 'POST' }, { endpointBase })).toBe(accepted)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('supports cancellation without submitting another post', async () => {
    fetchMock.mockResolvedValueOnce(pending())
    const controller = new AbortController()

    const result = fetchSocialPublish(
      url,
      { method: 'POST', signal: controller.signal },
      { endpointBase },
    )
    const assertion = expect(result).rejects.toThrow('abort')
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()

    await assertion
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('tells the operator to check history when polling loses connectivity', async () => {
    fetchMock.mockResolvedValueOnce(pending()).mockRejectedValueOnce(new Error('Network failed'))

    const result = fetchSocialPublish(url, { method: 'POST' }, { endpointBase })
    const assertion = expect(result).rejects.toThrow('Check the post history before retrying')
    await vi.advanceTimersByTimeAsync(1000)

    await assertion
    expect(posts()).toHaveLength(1)
  })

  it('bounds polling to the deadline without retrying publication', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(pending()))

    const result = fetchSocialPublish(url, { method: 'POST' }, { endpointBase })
    const assertion = expect(result).rejects.toThrow('Check the post history before retrying')
    await vi.advanceTimersByTimeAsync(601_000)

    await assertion
    expect(posts()).toHaveLength(1)
  })

  it('accepts a status URL under a custom API base path', async () => {
    fetchMock
      .mockResolvedValueOnce(pending('/cms-api/social/requests/7'))
      .mockResolvedValueOnce(Response.json({ ok: true }))

    const result = fetchSocialPublish(
      'https://app.example/cms-api/social/facebook/product/1/publish',
      { method: 'POST' },
      { endpointBase: '/cms-api/social' },
    )
    await vi.advanceTimersByTimeAsync(1000)

    expect((await result).ok).toBe(true)
    expect(fetchMock.mock.calls[1][0]).toBe('https://app.example/cms-api/social/requests/7')
  })
})
