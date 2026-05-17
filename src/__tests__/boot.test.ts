import type { Config, Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import payloadPluginSocials from '../index.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

/**
 * Real Payload boot against an in-memory sqlite database with schema push.
 * This builds EVERY plugin table (including the four per-platform `scopes`
 * arrays on the connections global), so a duplicate dbName or an over-long
 * identifier fails the boot rather than a host's production migration.
 */
let payload: Payload

const createTestDatabase = async (): Promise<Config['db']> => {
  if (process.env.SOCIALS_TEST_DATABASE === 'postgres') {
    const { postgresAdapter } = await import('@payloadcms/db-postgres')
    return postgresAdapter({
      pool: {
        connectionString:
          process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/socials_test',
      },
      push: true,
    })
  }
  if (process.env.SOCIALS_TEST_DATABASE === 'mongodb') {
    const { mongooseAdapter } = await import('@payloadcms/db-mongodb')
    return mongooseAdapter({
      ensureIndexes: true,
      url: process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017/socials_test',
    })
  }
  return sqliteAdapter({ client: { url: ':memory:' }, push: true })
}

beforeAll(async () => {
  const config = await buildConfig({
    collections: [{ slug: 'products', fields: [{ name: 'title', type: 'text' }] }],
    db: await createTestDatabase(),
    editor: lexicalEditor(),
    plugins: [
      payloadPluginSocials({
        authorize: () => Promise.resolve(true),
        encryptionKey: HEX_KEY,
        platforms: { pinterest: { enabled: false } },
        sources: { product: () => Promise.reject(new Error('stub')) },
      }),
    ],
    secret: 'test-secret',
  })
  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  await (payload as unknown as { destroy?: () => Promise<void> }).destroy?.()
})

describe('Payload boot with the plugin', () => {
  it('registers the plugin-owned collections', () => {
    expect(payload.collections['social-posts']).toBeDefined()
    expect(payload.collections['social-templates']).toBeDefined()
  })

  it('round-trips per-platform scopes on the connections global', async () => {
    await payload.updateGlobal({
      slug: 'socials-connections' as never,
      data: {
        instagram: { state: { connected: true, scopes: [{ value: 'instagram_basic' }] } },
        pinterest: { state: { connected: true, scopes: [{ value: 'pins:write' }] } },
      } as never,
      overrideAccess: true,
    })
    const global = (await payload.findGlobal({
      slug: 'socials-connections' as never,
      overrideAccess: true,
    })) as unknown as {
      instagram?: { state?: { scopes?: Array<{ value: string }> } }
      pinterest?: { state?: { scopes?: Array<{ value: string }> } }
    }
    expect(global.pinterest?.state?.scopes?.[0]?.value).toBe('pins:write')
    expect(global.instagram?.state?.scopes?.[0]?.value).toBe('instagram_basic')
  })

  it('creates a social-templates row', async () => {
    const doc = await payload.create({
      collection: 'social-templates' as never,
      data: { name: 'Spring Promo', templates: { pinterestTitle: '{{title}}' } } as never,
      overrideAccess: true,
    })
    expect((doc as { id: number | string }).id).toBeDefined()
  })
})
