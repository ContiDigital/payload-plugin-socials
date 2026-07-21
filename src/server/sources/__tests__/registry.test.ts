import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { NotFoundError, PluginError } from '../../utilities/errors.js'
import {
  getRegisteredSourceKinds,
  hasSourceResolver,
  resolveSourceContext,
  validateSourceResolvers,
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

describe('source resolver registry', () => {
  it('reports kinds from an isolated resolver registry', () => {
    const sources = {
      blogPost: () => Promise.resolve(sampleContext()),
      product: () => Promise.resolve(sampleContext()),
    }
    validateSourceResolvers(sources)
    expect([...getRegisteredSourceKinds(sources)].sort()).toEqual(['blogPost', 'product'])
    expect(hasSourceResolver(sources, 'product')).toBe(true)
    expect(hasSourceResolver(sources, 'unknown')).toBe(false)
  })

  it('throws when a resolver is not a function', () => {
    expect(() => validateSourceResolvers({ product: 'not-a-fn' as unknown as never })).toThrow(
      PluginError,
    )
  })

  it('keeps independent registries isolated', () => {
    const products = { product: () => Promise.resolve(sampleContext()) }
    const projects = { project: () => Promise.resolve(sampleContext()) }
    expect(getRegisteredSourceKinds(products)).toEqual(['product'])
    expect(getRegisteredSourceKinds(projects)).toEqual(['project'])
  })

  it('dispatches to the registered resolver with id, payload, and req', async () => {
    const resolver = vi.fn(() => Promise.resolve(sampleContext()))
    const sources = { product: resolver }
    const ctx = await resolveSourceContext({ id: 42, kind: 'product', payload, sources })
    expect(ctx.sourceKind).toBe('product')
    expect(resolver).toHaveBeenCalledWith({ id: 42, payload, req: undefined })
  })

  it('throws NotFoundError for an unregistered kind', async () => {
    await expect(
      resolveSourceContext({ id: 1, kind: 'missing', payload, sources: {} }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects a resolver that returns no context', async () => {
    const sources = { product: () => Promise.resolve(null as never) }
    await expect(
      resolveSourceContext({ id: 1, kind: 'product', payload, sources }),
    ).rejects.toThrow(/returned no context/)
  })

  it('rejects a mismatched source kind', async () => {
    const sources = {
      product: () => Promise.resolve({ ...sampleContext(), sourceKind: 'project' }),
    }
    await expect(
      resolveSourceContext({ id: 1, kind: 'product', payload, sources }),
    ).rejects.toThrow(/returned sourceKind "project"/)
  })

  it('rejects an incomplete source context', async () => {
    const sources = {
      product: () => Promise.resolve({ ...sampleContext(), baseTitle: '' }),
    }
    await expect(
      resolveSourceContext({ id: 1, kind: 'product', payload, sources }),
    ).rejects.toThrow(/incomplete context/)
  })
})
