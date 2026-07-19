import type { PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { AccessScope, NormalizedPluginOptions } from '../../../types/index.js'

import { createAccessEndpoint } from '../createAccessEndpoint.js'

const optionsWith = (authorize: NormalizedPluginOptions['authorize']): NormalizedPluginOptions =>
  ({ api: { basePath: '/socials' }, authorize }) as unknown as NormalizedPluginOptions

const reqWith = (user: unknown): PayloadRequest =>
  ({ payload: {}, user }) as unknown as PayloadRequest

describe('createAccessEndpoint', () => {
  it('registers as GET at {basePath}/access', () => {
    const endpoint = createAccessEndpoint(optionsWith(vi.fn()))
    expect(endpoint.method).toBe('get')
    expect(endpoint.path).toBe('/socials/access')
  })

  it('reports true for every scope the host authorizes', async () => {
    const authorize = vi.fn().mockResolvedValue(true)
    const response = await createAccessEndpoint(optionsWith(authorize)).handler(reqWith({ id: 1 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ admin: true, publisher: true })
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('reports publisher-only when the host grants publisher but not admin', async () => {
    const authorize = vi.fn(({ scope }: { scope: AccessScope }) => scope === 'publisher')
    const response = await createAccessEndpoint(optionsWith(authorize)).handler(reqWith({ id: 2 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ admin: false, publisher: true })
  })

  it('reports all false for an unauthenticated request without invoking authorize', async () => {
    const authorize = vi.fn().mockResolvedValue(true)
    const response = await createAccessEndpoint(optionsWith(authorize)).handler(reqWith(undefined))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ admin: false, publisher: false })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('never throws — a host authorize that throws reads as denied', async () => {
    const authorize = vi.fn().mockRejectedValue(new Error('boom'))
    const response = await createAccessEndpoint(optionsWith(authorize)).handler(reqWith({ id: 3 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ admin: false, publisher: false })
  })
})
