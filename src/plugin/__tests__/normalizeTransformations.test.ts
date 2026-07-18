import { describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig, SocialsTransformations } from '../../types/index.js'

import { normalizePluginOptions, normalizeTransformations } from '../normalizeOptions.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const base = (): PayloadPluginSocialsConfig => ({
  authorize: () => Promise.resolve(true),
  encryptionKey: HEX_KEY,
  platforms: { pinterest: { enabled: false } },
  sources: { product: () => Promise.reject(new Error('stub')) },
})

// ---------------------------------------------------------------------------
// normalizeTransformations — unit tests
// ---------------------------------------------------------------------------

describe('normalizeTransformations', () => {
  it('returns a frozen empty object when input is undefined', () => {
    const result = normalizeTransformations(undefined)
    expect(result).toEqual({})
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('returns a frozen empty object when input is not an object', () => {
    const result = normalizeTransformations('nope' as unknown as SocialsTransformations)
    expect(result).toEqual({})
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('drops unknown field keys silently', () => {
    const result = normalizeTransformations({
      product: {
        anotherBadKey: () => 'nope',
        unknownField: 'some value',
      } as unknown as SocialsTransformations['product'],
    })
    expect(result.product).toBeUndefined()
  })

  it('drops values that are neither a non-empty string nor a function', () => {
    const result = normalizeTransformations({
      product: {
        facebookMessage: null as unknown as string, // null — dropped
        instagramCaption: 'valid template string', // kept
        pinterestDescription: 42 as unknown as string, // not string/function — dropped
        pinterestTitle: '', // empty string — dropped
      },
    })
    const kindMap = result.product
    expect(kindMap).toBeDefined()
    expect((kindMap as Record<string, unknown>)?.facebookMessage).toBeUndefined()
    expect((kindMap as Record<string, unknown>)?.instagramCaption).toBe('valid template string')
    expect((kindMap as Record<string, unknown>)?.pinterestDescription).toBeUndefined()
    expect((kindMap as Record<string, unknown>)?.pinterestTitle).toBeUndefined()
  })

  it('keeps function values', () => {
    const fn = () => 'custom'
    const result = normalizeTransformations({
      product: { pinterestTitle: fn },
    })
    expect((result.product as Record<string, unknown>)?.pinterestTitle).toBe(fn)
  })

  it('freezes the top-level map and each per-kind sub-map', () => {
    const result = normalizeTransformations({
      '*': { facebookMessage: '{{title}}' },
      product: { pinterestTitle: 'Title: {{title}}' },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result['*'])).toBe(true)
    expect(Object.isFrozen(result.product)).toBe(true)
  })

  it('normalizes the wildcard "*" key like any other kind', () => {
    const result = normalizeTransformations({
      '*': { gbpSummary: '{{title}} — {{description}}' },
    })
    expect((result['*'] as Record<string, unknown>)?.gbpSummary).toBe('{{title}} — {{description}}')
  })

  it('omits a kind entry entirely when all its fields were dropped', () => {
    const result = normalizeTransformations({
      blogPost: {
        facebookMessage: 0 as unknown as string, // not string/function dropped
        pinterestTitle: '', // empty string dropped
      },
    })
    expect(result.blogPost).toBeUndefined()
  })

  it('accepts all seven canonical keys', () => {
    const fn = () => 'x'
    const result = normalizeTransformations({
      product: {
        facebookMessage: 'M',
        gbpSummary: 'S',
        instagramCaption: 'C',
        pinterestAltText: 'A',
        pinterestDescription: 'D',
        pinterestHashtags: fn as unknown as string,
        pinterestTitle: 'T',
      },
    })
    const km = result.product as Record<string, unknown>
    expect(km?.facebookMessage).toBe('M')
    expect(km?.gbpSummary).toBe('S')
    expect(km?.instagramCaption).toBe('C')
    expect(km?.pinterestAltText).toBe('A')
    expect(km?.pinterestDescription).toBe('D')
    expect(km?.pinterestHashtags).toBe(fn)
    expect(km?.pinterestTitle).toBe('T')
  })
})

// ---------------------------------------------------------------------------
// normalizePluginOptions — transformations integration
// ---------------------------------------------------------------------------

describe('normalizePluginOptions — transformations', () => {
  it('sets transformations to a frozen {} when no transformations are supplied', () => {
    const n = normalizePluginOptions(base())
    expect(n.transformations).toEqual({})
    expect(Object.isFrozen(n.transformations)).toBe(true)
  })

  it('wires transformations through when valid entries are supplied', () => {
    const n = normalizePluginOptions({
      ...base(),
      transformations: {
        product: { pinterestTitle: '{{title}}' },
      },
    })
    const km = n.transformations.product as Record<string, unknown>
    expect(km?.pinterestTitle).toBe('{{title}}')
  })

  it('returns {} for transformations on the disabled path', () => {
    const n = normalizePluginOptions({ disabled: true } as PayloadPluginSocialsConfig)
    expect(n.transformations).toEqual({})
    expect(Object.isFrozen(n.transformations)).toBe(true)
  })
})
