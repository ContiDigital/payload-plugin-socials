import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { NotFoundError, PluginError } from '../../utilities/errors.js'
import {
  __resetSourceResolverRegistry,
  getRegisteredSourceKinds,
  hasSourceResolver,
  registerSourceResolvers,
  resolveSourceContext,
} from '../registry.js'

const payload = {} as Payload

const sampleContext = (): SocialSourceContext => ({
  baseDescription: 'body',
  baseTitle: 'title',
  images: [],
  link: 'https://example.com',
  sourceId: '1',
  sourceKind: 'product',
})

beforeEach(() => {
  __resetSourceResolverRegistry()
})

describe('source resolver registry', () => {
  it('registers resolvers and reports the registered kinds', () => {
    registerSourceResolvers({
      blogPost: () => Promise.resolve(sampleContext()),
      product: () => Promise.resolve(sampleContext()),
    })
    expect([...getRegisteredSourceKinds()].sort()).toEqual(['blogPost', 'product'])
    expect(hasSourceResolver('product')).toBe(true)
    expect(hasSourceResolver('unknown')).toBe(false)
  })

  it('throws when a resolver is not a function', () => {
    expect(() => registerSourceResolvers({ product: 'not-a-fn' as unknown as never })).toThrow(
      PluginError,
    )
  })

  it('replaces the prior registration on re-register', () => {
    registerSourceResolvers({ product: () => Promise.resolve(sampleContext()) })
    registerSourceResolvers({ project: () => Promise.resolve(sampleContext()) })
    expect(getRegisteredSourceKinds()).toEqual(['project'])
  })

  it('dispatches to the registered resolver with id, payload, and req', async () => {
    const resolver = vi.fn(() => Promise.resolve(sampleContext()))
    registerSourceResolvers({ product: resolver })
    const ctx = await resolveSourceContext({ id: 42, kind: 'product', payload })
    expect(ctx.sourceKind).toBe('product')
    expect(resolver).toHaveBeenCalledWith({ id: 42, payload, req: undefined })
  })

  it('throws NotFoundError for an unregistered kind', async () => {
    await expect(resolveSourceContext({ id: 1, kind: 'missing', payload })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('rejects a resolver that returns no context', async () => {
    registerSourceResolvers({ product: () => Promise.resolve(null as never) })
    await expect(resolveSourceContext({ id: 1, kind: 'product', payload })).rejects.toThrow(
      /returned no context/,
    )
  })

  it('rejects a mismatched source kind', async () => {
    registerSourceResolvers({
      product: () => Promise.resolve({ ...sampleContext(), sourceKind: 'project' }),
    })
    await expect(resolveSourceContext({ id: 1, kind: 'product', payload })).rejects.toThrow(
      /returned sourceKind "project"/,
    )
  })

  it('rejects an incomplete source context', async () => {
    registerSourceResolvers({
      product: () => Promise.resolve({ ...sampleContext(), baseTitle: '' }),
    })
    await expect(resolveSourceContext({ id: 1, kind: 'product', payload })).rejects.toThrow(
      /incomplete context/,
    )
  })
})
