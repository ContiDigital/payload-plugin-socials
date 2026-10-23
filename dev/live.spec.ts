import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { randomUUID } from 'node:crypto'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  NormalizedPluginOptions,
  PayloadPluginSocialsConfig,
  PublishedRef,
  SocialSourceContext,
} from '../src/types/index.js'

import payloadPluginSocials from '../src/index.js'
import { normalizePluginOptions } from '../src/plugin/normalizeOptions.js'
import { saveCredentials } from '../src/server/services/connectionService.js'
import { createPluginLogger } from '../src/server/utilities/logger.js'
import { getPageAccessToken } from '../src/server/platforms/facebook/pages.js'
import {
  deleteFacebookPost,
  publishFacebookPost,
} from '../src/server/platforms/facebook/publish.js'
import { publishInstagramMedia } from '../src/server/platforms/instagram/publish.js'
import {
  deletePinterestPin,
  publishPinterestPin,
} from '../src/server/platforms/pinterest/publish.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const CANARY_LABEL = 'Automated release canary, removed immediately.'
const platform = process.env.SOCIALS_LIVE_PLATFORM
const lifecycleEnabled = process.env.SOCIALS_LIVE_CANARY === '1'

const hasSecrets = (...names: string[]): boolean =>
  names.every((name) => Boolean(process.env[name]?.trim()))

const pinterestLifecycleEnabled =
  lifecycleEnabled &&
  hasSecrets(
    'PINTEREST_ACCESS_TOKEN',
    'CANARY_PINTEREST_BOARD_ID',
    'SOCIALS_LIVE_CANARY_IMAGE_URL',
    'SOCIALS_LIVE_CANARY_LINK_URL',
  )
const facebookLifecycleEnabled =
  lifecycleEnabled &&
  hasSecrets(
    'META_ACCESS_TOKEN',
    'CANARY_FACEBOOK_PAGE_ID',
    'SOCIALS_LIVE_CANARY_IMAGE_URL',
    'SOCIALS_LIVE_CANARY_LINK_URL',
  )
const instagramLifecycleEnabled =
  lifecycleEnabled &&
  process.env.SOCIALS_LIVE_ALLOW_IG === '1' &&
  hasSecrets(
    'META_ACCESS_TOKEN',
    'CANARY_INSTAGRAM_USER_ID',
    'SOCIALS_LIVE_CANARY_IMAGE_URL',
    'SOCIALS_LIVE_CANARY_LINK_URL',
  )

const requireSecret = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for the selected live contract test`)
  }
  return value
}

const expectOk = async (response: Response): Promise<void> => {
  expect(response.status, `upstream returned HTTP ${response.status}`).toBeGreaterThanOrEqual(200)
  expect(response.status, `upstream returned HTTP ${response.status}`).toBeLessThan(300)
  await response.body?.cancel()
}

const expectJsonOk = async <T>(response: Response): Promise<T> => {
  const raw = await response.text()
  expect(response.ok, `upstream returned HTTP ${response.status}: ${raw}`).toBe(true)
  return JSON.parse(raw) as T
}

const createCanaryContext = (): SocialSourceContext => {
  const imageUrl = requireSecret('SOCIALS_LIVE_CANARY_IMAGE_URL')
  return {
    baseDescription: CANARY_LABEL,
    baseTitle: CANARY_LABEL,
    images: [{ alt: CANARY_LABEL, role: 'main', url: imageUrl }],
    link: requireSecret('SOCIALS_LIVE_CANARY_LINK_URL'),
    sourceId: `release-canary-${randomUUID()}`,
    sourceKind: 'release-canary',
  }
}

const createCanaryOptions = (
  platforms: PayloadPluginSocialsConfig['platforms'],
): NormalizedPluginOptions =>
  normalizePluginOptions({
    assets: { autoConvert: false, preflight: false },
    authorize: () => Promise.resolve(true),
    encryptionKey: HEX_KEY,
    platforms,
    sources: {
      'release-canary': () => Promise.reject(new Error('The live canary resolves inline.')),
    },
  })

let canaryPayload: Payload | undefined

const getCanaryPayload = (): Payload => {
  if (!canaryPayload) {
    throw new Error('Live canary Payload instance was not initialized')
  }
  return canaryPayload
}

const reportCanary = (
  platformName: 'facebook' | 'instagram' | 'pinterest',
  externalId: string,
  message: string,
): void => {
  createPluginLogger(getCanaryPayload().logger, {
    externalId,
    op: 'live-release-canary',
    platform: platformName,
  }).info(message)
}

beforeAll(async () => {
  if (!lifecycleEnabled) {
    return
  }
  const config = await buildConfig({
    collections: [{ slug: 'canary-sources', fields: [{ name: 'title', type: 'text' }] }],
    db: sqliteAdapter({ client: { url: ':memory:' }, push: true }),
    editor: lexicalEditor(),
    plugins: [
      payloadPluginSocials({
        authorize: () => Promise.resolve(true),
        encryptionKey: HEX_KEY,
        platforms: { pinterest: { enabled: false } },
        sources: {
          'release-canary': () => Promise.reject(new Error('The live canary resolves inline.')),
        },
      }),
    ],
    secret: 'live-canary-payload-secret',
  })
  canaryPayload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  await (canaryPayload as unknown as { destroy?: () => Promise<void> } | undefined)?.destroy?.()
})

describe.skipIf(!platform)('live provider contracts', () => {
  it.skipIf(platform !== 'pinterest')('authenticates with Pinterest API v5', async () => {
    const token = requireSecret('PINTEREST_ACCESS_TOKEN')
    await expectOk(
      await fetch('https://api.pinterest.com/v5/user_account', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
  })

  it.skipIf(platform !== 'meta')(
    'authenticates with the configured Meta Graph version',
    async () => {
      const token = requireSecret('META_ACCESS_TOKEN')
      const version = process.env.META_API_VERSION ?? 'v25.0'
      await expectOk(
        await fetch(`https://graph.facebook.com/${version}/me?fields=id,name`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      )
    },
  )

  it.skipIf(platform !== 'gbp')('lists Google Business Profile accounts', async () => {
    const token = requireSecret('GBP_ACCESS_TOKEN')
    await expectOk(
      await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
  })

  // Non-mutating: Google validates the nested update masks the plugin sends, with the
  // listing's own current values, and saves nothing.
  it.skipIf(platform !== 'gbp' || !hasSecrets('GBP_ACCESS_TOKEN', 'CANARY_GBP_LOCATION_ID'))(
    'validates a Business Profile listing patch without saving it',
    async () => {
      const token = requireSecret('GBP_ACCESS_TOKEN')
      const name = `locations/${requireSecret('CANARY_GBP_LOCATION_ID')}`
      const base = `https://mybusinessbusinessinformation.googleapis.com/v1/${name}`
      const read = await fetch(`${base}?readMask=profile,phoneNumbers,openInfo`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      await expectOk(read)
      const current = (await read.json()) as {
        openInfo?: { status?: string }
        phoneNumbers?: { primaryPhone?: string }
        profile?: { description?: string }
      }
      const mask = 'profile.description,phoneNumbers.primaryPhone,openInfo.status'
      await expectOk(
        await fetch(`${base}?updateMask=${mask}&validateOnly=true`, {
          body: JSON.stringify({
            openInfo: { status: current.openInfo?.status ?? 'OPEN' },
            phoneNumbers: { primaryPhone: current.phoneNumbers?.primaryPhone },
            profile: { description: current.profile?.description },
          }),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          method: 'PATCH',
        }),
      )
    },
  )
})

describe('live provider publication lifecycles', () => {
  it.skipIf(!lifecycleEnabled)('boots an isolated Payload canary harness', () => {
    expect(getCanaryPayload().collections['social-posts']).toBeDefined()
  })

  it.skipIf(!pinterestLifecycleEnabled)(
    'publishes, reads, deletes, and confirms deletion of a Pinterest Pin',
    async () => {
      const payload = getCanaryPayload()
      const token = requireSecret('PINTEREST_ACCESS_TOKEN')
      const context = createCanaryContext()
      const options = createCanaryOptions({
        pinterest: {
          clientId: 'live-canary-token-client',
          clientSecret: 'unused-live-canary-token-secret',
          enabled: true,
          redirectUri: 'https://localhost.invalid/pinterest/callback',
        },
      })
      await saveCredentials(payload, options, 'pinterest', {
        accessToken: token,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scopes: ['pins:read', 'pins:write'],
      })

      let publishedRef: PublishedRef | undefined
      try {
        const result = await publishPinterestPin({
          ctx: context,
          input: {
            altText: CANARY_LABEL,
            boardId: requireSecret('CANARY_PINTEREST_BOARD_ID'),
            description: CANARY_LABEL,
            imageUrl: context.images[0]!.url,
            link: context.link,
            mediaType: 'IMAGE',
            publicationKey: context.sourceId,
            title: CANARY_LABEL,
          },
          options,
          payload,
        })
        publishedRef = result.publishedRef
        reportCanary('pinterest', publishedRef.externalId, 'Pinterest live canary published')

        const found = await expectJsonOk<{ id?: string }>(
          await fetch(
            `https://api.pinterest.com/v5/pins/${encodeURIComponent(publishedRef.externalId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          ),
        )
        expect(found.id).toBe(publishedRef.externalId)
      } finally {
        if (publishedRef) {
          await deletePinterestPin({ options, payload, publishedRef })
        }
      }

      expect(publishedRef).toBeDefined()
      const gone = await fetch(
        `https://api.pinterest.com/v5/pins/${encodeURIComponent(publishedRef!.externalId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(gone.status).toBe(404)
      await gone.body?.cancel()
      reportCanary('pinterest', publishedRef!.externalId, 'Pinterest live canary cleanup confirmed')
    },
    120_000,
  )

  it.skipIf(!facebookLifecycleEnabled)(
    'publishes, reads, deletes, and confirms deletion of a Facebook link post',
    async () => {
      const payload = getCanaryPayload()
      const token = requireSecret('META_ACCESS_TOKEN')
      const pageId = requireSecret('CANARY_FACEBOOK_PAGE_ID')
      const version = process.env.META_API_VERSION ?? 'v25.0'
      const context = createCanaryContext()
      const options = createCanaryOptions({
        facebook: {
          apiVersion: version,
          enabled: true,
          systemUserAccessToken: token,
        },
      })

      let publishedRef: PublishedRef | undefined
      let pageAccessToken = ''
      try {
        const result = await publishFacebookPost({
          ctx: context,
          input: {
            format: 'LINK',
            link: context.link,
            message: CANARY_LABEL,
            pageId,
            publicationKey: context.sourceId,
          },
          options,
          payload,
        })
        publishedRef = result.publishedRef
        reportCanary('facebook', publishedRef.externalId, 'Facebook live canary published')

        pageAccessToken = await getPageAccessToken(payload, options, pageId)
        const found = await expectJsonOk<{ id?: string; is_published?: boolean }>(
          await fetch(
            `https://graph.facebook.com/${version}/${encodeURIComponent(
              publishedRef.externalId,
            )}?fields=id,is_published`,
            { headers: { Authorization: `Bearer ${pageAccessToken}` } },
          ),
        )
        expect(found.id).toBe(publishedRef.externalId)
        expect(found.is_published).toBe(true)
      } finally {
        if (publishedRef) {
          await deleteFacebookPost({ options, payload, publishedRef })
        }
      }

      expect(publishedRef).toBeDefined()
      const gone = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(
          publishedRef!.externalId,
        )}?fields=id`,
        { headers: { Authorization: `Bearer ${pageAccessToken}` } },
      )
      expect(gone.ok).toBe(false)
      await gone.body?.cancel()
      reportCanary('facebook', publishedRef!.externalId, 'Facebook live canary cleanup confirmed')
    },
    120_000,
  )

  it.skipIf(!instagramLifecycleEnabled)(
    'publishes and reads an Instagram Story that self-expires after 24 hours',
    async () => {
      const payload = getCanaryPayload()
      const token = requireSecret('META_ACCESS_TOKEN')
      const version = process.env.META_API_VERSION ?? 'v25.0'
      const context = createCanaryContext()
      const options = createCanaryOptions({
        instagram: {
          apiVersion: version,
          enabled: true,
          systemUserAccessToken: token,
        },
      })
      const result = await publishInstagramMedia({
        ctx: context,
        input: {
          igUserId: requireSecret('CANARY_INSTAGRAM_USER_ID'),
          imageUrl: context.images[0]!.url,
          mediaType: 'STORIES',
          publicationKey: context.sourceId,
        },
        options,
        payload,
      })
      reportCanary('instagram', result.publishedRef.externalId, 'Instagram Story canary published')

      const found = await expectJsonOk<{ id?: string; media_product_type?: string }>(
        await fetch(
          `https://graph.facebook.com/${version}/${encodeURIComponent(
            result.publishedRef.externalId,
          )}?fields=id,media_product_type,timestamp`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      )
      expect(found.id).toBe(result.publishedRef.externalId)
      expect(found.media_product_type).toBe('STORY')
    },
    10 * 60_000,
  )
})

// Enable only after Google grants Basic API Access and an owner approves using
// a real verified location for create/read/delete lifecycle evidence.
describe.skip('Google Business Profile publication lifecycle', () => {
  it('creates, reads, and deletes a Standard Local Post', () => {})
})
