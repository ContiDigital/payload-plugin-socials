import type { SanitizedConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../types/index.js'

import payloadPluginSocials from '../index.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

/**
 * Integration-level check: run the plugin through Payload's real `buildConfig`
 * sanitizer. Unlike the curried-factory wiring test (which calls the factory
 * against a bare config), this exercises Payload's full field/collection/task
 * validation, so a malformed field, an invalid dbName, or a bad task config
 * fails the build. No database connection happens at sanitize time.
 */
let config: SanitizedConfig
let disabledConfig: SanitizedConfig

beforeAll(async () => {
  config = await buildConfig({
    collections: [{ slug: 'products', fields: [{ name: 'title', type: 'text' }] }],
    db: sqliteAdapter({ client: { url: ':memory:' } }),
    editor: lexicalEditor(),
    jobs: {
      autoRun: [{ cron: '13 * * * *', queue: 'host-jobs' }],
    },
    plugins: [
      payloadPluginSocials({
        authorize: () => Promise.resolve(true),
        encryptionKey: HEX_KEY,
        platforms: { pinterest: { enabled: false } },
        scheduling: {
          autoRun: {
            connectionRefreshCron: '0 3 * * *',
            cron: '*/5 * * * *',
            insightsRefreshCron: '0 9 * * *',
          },
          queue: 'operator-socials',
        },
        sources: {
          product: ({ id }) =>
            Promise.resolve({
              baseDescription: 'body',
              baseTitle: 'title',
              images: [],
              link: 'https://example.com',
              sourceId: String(id),
              sourceKind: 'product',
            }),
        },
      }),
    ],
    secret: 'test-secret',
  })

  disabledConfig = await buildConfig({
    collections: [{ slug: 'products', fields: [{ name: 'title', type: 'text' }] }],
    db: sqliteAdapter({ client: { url: ':memory:' } }),
    editor: lexicalEditor(),
    plugins: [
      payloadPluginSocials({
        disabled: true,
        sources: {
          product: () => Promise.reject(new Error('disabled resolver must not run')),
        },
      } as unknown as PayloadPluginSocialsConfig),
    ],
    secret: 'test-secret',
  })
}, 30_000)

describe('buildConfig sanitization', () => {
  it('sanitizes the plugin-owned social-posts collection', () => {
    expect(config.collections.find((c) => c.slug === 'social-posts')).toBeDefined()
  })

  it('sanitizes the plugin-owned social-templates collection', () => {
    expect(config.collections.find((c) => c.slug === 'social-templates')).toBeDefined()
  })

  it('keeps the host collection intact', () => {
    expect(config.collections.find((c) => c.slug === 'products')).toBeDefined()
  })

  it('registers the socials-connections global', () => {
    expect(config.globals.find((g) => g.slug === 'socials-connections')).toBeDefined()
  })

  it('registers every plugin-owned job task', () => {
    const slugs = (config.jobs?.tasks ?? []).map((t) => (t as { slug: string }).slug)
    for (const slug of [
      'socialPostPublish',
      'socialPostRetry',
      'socialPostSweep',
      'socialInsightsRefresh',
      'socialConnectionRefresh',
    ]) {
      expect(slugs).toContain(slug)
    }
  })

  it('preserves host autoRun and attaches periodic task schedules to the configured queue', () => {
    expect(config.jobs?.autoRun).toEqual([{ cron: '13 * * * *', queue: 'host-jobs' }])
    const tasks = (config.jobs?.tasks ?? []) as Array<{
      schedule?: Array<{ cron: string; queue: string }>
      slug: string
    }>
    expect(tasks.find((task) => task.slug === 'socialPostSweep')?.schedule).toEqual([
      { cron: '*/5 * * * *', queue: 'operator-socials' },
    ])
    expect(tasks.find((task) => task.slug === 'socialInsightsRefresh')?.schedule).toEqual([
      { cron: '0 9 * * *', queue: 'operator-socials' },
    ])
    expect(tasks.find((task) => task.slug === 'socialConnectionRefresh')?.schedule).toEqual([
      { cron: '0 3 * * *', queue: 'operator-socials' },
    ])
  })

  it('mounts the plugin REST endpoints including the health probe and composer', () => {
    const paths = (config.endpoints ?? []).map((e) => e.path)
    expect(paths.some((p) => p.includes('/health'))).toBe(true)
    expect(paths.some((p) => p.includes('/compose/publish'))).toBe(true)
  })

  it('sanitizes disabled mode as schema-only and runtime-inert', () => {
    const posts = disabledConfig.collections.find((entry) => entry.slug === 'social-posts')
    const templates = disabledConfig.collections.find((entry) => entry.slug === 'social-templates')
    const connections = disabledConfig.globals.find((entry) => entry.slug === 'socials-connections')
    expect(posts?.admin.hidden).toBe(true)
    expect(templates?.admin.hidden).toBe(true)
    expect(templates?.hooks?.beforeChange ?? []).toHaveLength(0)
    expect(connections?.admin.hidden).toBe(true)
    expect(disabledConfig.endpoints.some((endpoint) => endpoint.path.includes('/socials/'))).toBe(
      false,
    )
    expect(disabledConfig.jobs?.tasks ?? []).toHaveLength(0)
  })
})
