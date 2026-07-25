import type { CollectionConfig, Config } from 'payload'

import { describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../../types/index.js'

import { SOCIAL_POSTS_SLUG } from '../../constants.js'
import { applyCollectionEnhancements } from '../applyCollectionEnhancements.js'
import { normalizePluginOptions } from '../normalizeOptions.js'

const baseOptions = (
  overrides: Partial<PayloadPluginSocialsConfig> = {},
): PayloadPluginSocialsConfig => ({
  authorize: () => Promise.resolve(true),
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: { pinterest: { enabled: false } },
  sources: { product: () => Promise.reject(new Error('stub')) },
  ...overrides,
})

const collection = (slug: string, auth = false): CollectionConfig => ({
  slug,
  auth,
  fields: [],
})

const publishedByField = (config: Config) =>
  config.collections
    ?.find((candidate) => candidate.slug === SOCIAL_POSTS_SLUG)
    ?.fields.find((field) => 'name' in field && field.name === 'publishedBy')

describe('applyCollectionEnhancements — auth collection resolution', () => {
  it('auto-detects a single auth collection for publication attribution', () => {
    const options = normalizePluginOptions(baseOptions())
    const config = { collections: [collection('members', true)] } as Config

    applyCollectionEnhancements(config, options)

    expect(options.authCollection).toBe('members')
    expect(publishedByField(config)).toMatchObject({ type: 'relationship', relationTo: 'members' })
  })

  it('uses an explicitly selected auth collection when several exist', () => {
    const options = normalizePluginOptions(baseOptions({ authCollection: 'admins' }))
    const config = {
      collections: [collection('members', true), collection('admins', true)],
    } as Config

    applyCollectionEnhancements(config, options)

    expect(publishedByField(config)).toMatchObject({ relationTo: 'admins' })
  })

  it('requires an explicit selection when several auth collections exist', () => {
    const options = normalizePluginOptions(baseOptions())
    const config = {
      collections: [collection('members', true), collection('admins', true)],
    } as Config

    expect(() => applyCollectionEnhancements(config, options)).toThrow(/set authCollection/)
  })

  it('rejects an explicit collection that is missing or not auth-enabled', () => {
    for (const config of [
      { collections: [collection('posts')] },
      { collections: [collection('members')] },
    ] as Config[]) {
      const options = normalizePluginOptions(baseOptions({ authCollection: 'members' }))
      expect(() => applyCollectionEnhancements(config, options)).toThrow(/not an auth-enabled/)
    }
  })

  it('omits publishedBy when the host has no auth collection', () => {
    const options = normalizePluginOptions(baseOptions())
    const config = { collections: [collection('posts')] } as Config

    applyCollectionEnhancements(config, options)

    expect(publishedByField(config)).toBeUndefined()
  })
})

describe('applyCollectionEnhancements — schemaOnly + idempotency', () => {
  const withSocialsTab = (): CollectionConfig => ({
    slug: 'products',
    fields: [{ type: 'tabs', tabs: [{ fields: [], label: 'General' }] }],
  })

  it('schemaOnly registers plugin collections but injects no host tab', () => {
    const options = normalizePluginOptions(
      baseOptions({ admin: { injectInto: [{ collection: 'products', sourceKind: 'product' }] } }),
    )
    const products = withSocialsTab()
    const config = { collections: [products] } as Config

    applyCollectionEnhancements(config, options, { schemaOnly: true })

    // Plugin collections registered...
    expect(config.collections?.some((c) => c.slug === SOCIAL_POSTS_SLUG)).toBe(true)
    // ...but no Socials tab injected into the host collection.
    const tabs = products.fields[0] as { tabs: Array<{ fields: Array<{ name?: string }> }> }
    expect(tabs.tabs.every((t) => !t.fields.some((f) => f.name === 'socials'))).toBe(true)
  })

  it('does not stack a second Socials tab when applied twice', () => {
    const options = normalizePluginOptions(
      baseOptions({ admin: { injectInto: [{ collection: 'products', sourceKind: 'product' }] } }),
    )
    const products = withSocialsTab()
    const config = { collections: [products] } as Config

    applyCollectionEnhancements(config, options)
    applyCollectionEnhancements(config, options)

    const tabs = products.fields[0] as { tabs: Array<{ fields: Array<{ name?: string }> }> }
    const socialsTabs = tabs.tabs.filter((t) => t.fields.some((f) => f.name === 'socials'))
    expect(socialsTabs).toHaveLength(1)
  })

  it('rejects a host field collision instead of mistaking it for the plugin tab', () => {
    const options = normalizePluginOptions(
      baseOptions({ admin: { injectInto: [{ collection: 'products', sourceKind: 'product' }] } }),
    )
    const products: CollectionConfig = {
      slug: 'products',
      fields: [
        {
          type: 'tabs',
          tabs: [{ fields: [{ name: 'socials', type: 'text' }], label: 'General' }],
        },
      ],
    }

    expect(() =>
      applyCollectionEnhancements({ collections: [products] } as Config, options),
    ).toThrow(/already has a top-level field named "socials"/)
  })
})
