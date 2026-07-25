import type { Config } from 'payload'

import { describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../types/index.js'

import {
  SOCIAL_POSTS_SLUG,
  SOCIAL_TEMPLATES_SLUG,
  SOCIALS_CONNECTIONS_GLOBAL_SLUG,
} from '../constants.js'
import payloadPluginSocials, { TASK_SLUGS_OWNED_BY_PLUGIN } from '../index.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const validOptions = (
  overrides: Partial<PayloadPluginSocialsConfig> = {},
): PayloadPluginSocialsConfig => ({
  authorize: () => Promise.resolve(true),
  encryptionKey: HEX_KEY,
  platforms: { pinterest: { enabled: false } },
  sources: {
    product: () => Promise.reject(new Error('stub resolver; not invoked in wiring tests')),
  },
  ...overrides,
})

const baseConfig = (): Config =>
  ({ collections: [], endpoints: [], globals: [] }) as unknown as Config

const slugsOf = (items: readonly unknown[]): string[] =>
  items
    .map((i) =>
      i && typeof i === 'object' && 'slug' in i ? (i as { slug?: unknown }).slug : undefined,
    )
    .filter((s): s is string => typeof s === 'string')

describe('payloadPluginSocials curried factory', () => {
  it('registers the social-posts collection exactly once', () => {
    const result = payloadPluginSocials(validOptions())(baseConfig())
    const matches = (result.collections ?? []).filter((c) => c.slug === SOCIAL_POSTS_SLUG)
    expect(matches).toHaveLength(1)
  })

  it('registers the socials-connections global', () => {
    const result = payloadPluginSocials(validOptions())(baseConfig())
    expect(slugsOf(result.globals ?? [])).toContain(SOCIALS_CONNECTIONS_GLOBAL_SLUG)
  })

  it('registers all plugin-owned job tasks', () => {
    const result = payloadPluginSocials(validOptions())(baseConfig())
    const taskSlugs = slugsOf(result.jobs?.tasks ?? [])
    for (const slug of TASK_SLUGS_OWNED_BY_PLUGIN) {
      expect(taskSlugs).toContain(slug)
    }
  })

  it('registers REST endpoints including a health check', () => {
    const result = payloadPluginSocials(validOptions())(baseConfig())
    const endpoints = result.endpoints ?? []
    expect(endpoints.length).toBeGreaterThan(0)
    expect(endpoints.some((e) => e.path.includes('/health'))).toBe(true)
  })

  it('retains a hidden, deny-all schema while omitting runtime wiring when disabled', async () => {
    const config = baseConfig()
    const result = payloadPluginSocials(validOptions({ disabled: true }))(config)
    expect(result).toBe(config)
    expect(slugsOf(result.collections ?? [])).toEqual(
      expect.arrayContaining([SOCIAL_POSTS_SLUG, SOCIAL_TEMPLATES_SLUG]),
    )
    expect(slugsOf(result.globals ?? [])).toContain(SOCIALS_CONNECTIONS_GLOBAL_SLUG)
    expect(result.endpoints).toHaveLength(0)
    expect(result.jobs?.tasks ?? []).toHaveLength(0)

    const posts = result.collections?.find((entry) => entry.slug === SOCIAL_POSTS_SLUG)
    const templates = result.collections?.find((entry) => entry.slug === SOCIAL_TEMPLATES_SLUG)
    const connections = result.globals?.find(
      (entry) => entry.slug === SOCIALS_CONNECTIONS_GLOBAL_SLUG,
    )
    expect(posts?.admin?.hidden).toBe(true)
    expect(templates?.admin?.hidden).toBe(true)
    expect(templates?.hooks?.beforeChange).toBeUndefined()
    expect(connections?.admin?.hidden).toBe(true)
    expect(await posts?.access?.read?.({ req: { user: { id: 1 } } } as never)).toBe(false)
    expect(await connections?.access?.read?.({ req: { user: { id: 1 } } } as never)).toBe(false)
  })

  it('rejects a second plugin instance instead of sharing process-level registries', () => {
    const config = baseConfig()
    payloadPluginSocials(validOptions())(config)
    expect(() => payloadPluginSocials(validOptions())(config)).toThrow(/only one plugin instance/)
  })
})

describe('payloadPluginSocials validation', () => {
  it('throws when authorize is missing', () => {
    expect(() =>
      payloadPluginSocials(validOptions({ authorize: undefined }))(baseConfig()),
    ).toThrow(/authorize/)
  })

  it('throws when sources is empty', () => {
    expect(() => payloadPluginSocials(validOptions({ sources: {} }))(baseConfig())).toThrow(
      /sources/,
    )
  })

  it('throws when encryptionKey is missing', () => {
    expect(() =>
      payloadPluginSocials(validOptions({ encryptionKey: undefined }))(baseConfig()),
    ).toThrow(/encryptionKey/)
  })

  it('throws when an enabled platform is missing credentials', () => {
    expect(() =>
      payloadPluginSocials(validOptions({ platforms: { pinterest: { enabled: true } } }))(
        baseConfig(),
      ),
    ).toThrow(/pinterest/)
  })
})
