import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import {
  PlatformApiError,
  PublicationPersistenceError,
  ValidationError,
} from '../../../utilities/errors.js'
import { buildPublicationIdentity } from '../../../utilities/publicationIdentity.js'

vi.mock('../../_meta/api.js', () => ({
  makeMetaRequest: vi.fn(),
  metaJson: vi.fn(),
}))
vi.mock('../../../assets/resolvePlatformImage.js', () => ({
  resolvePlatformImageUrl: vi.fn(),
}))

import { resolvePlatformImageUrl } from '../../../assets/resolvePlatformImage.js'
import { makeMetaRequest, metaJson } from '../../_meta/api.js'
import { deleteInstagramMedia, publishInstagramMedia } from '../publish.js'

const mockedMetaJson = vi.mocked(metaJson)
const mockedRequest = vi.mocked(makeMetaRequest)
const mockedResolve = vi.mocked(resolvePlatformImageUrl)

const options = {
  copyOverrides: {},
  platforms: { instagram: { apiVersion: 'v25.0', enabled: true } },
} as unknown as NormalizedPluginOptions

const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'A regal marble lion.',
  baseTitle: 'Marble Lion',
  images: [{ role: 'main', url: 'https://cdn.example.com/main.jpg' }],
  link: 'https://example.com/products/lion',
  sourceId: '1',
  sourceKind: 'product',
  ...over,
})

interface MockPayload {
  create: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  logger: undefined
  update: ReturnType<typeof vi.fn>
}

let payload: MockPayload
const asPayload = (p: MockPayload): Payload => p as unknown as Payload

/** Serve container-create -> status -> publish responses for the two-phase flow. */
const setupFlow = (opts: { publish?: Record<string, unknown>; status?: string } = {}) => {
  let containerCounter = 0
  mockedMetaJson.mockImplementation((_p, _o, _plat, path) => {
    const p = String(path)
    if (p.includes('/media_publish')) {
      return Promise.resolve(
        opts.publish ?? { id: 'media_1', permalink: 'https://www.instagram.com/p/abc/' },
      )
    }
    if (p.includes('status_code')) {
      return Promise.resolve({ id: 'c', status_code: opts.status ?? 'FINISHED' })
    }
    containerCounter += 1
    return Promise.resolve({ id: `container_${containerCounter}` })
  })
}

const createBodies = (): Array<Record<string, unknown>> =>
  mockedMetaJson.mock.calls
    .filter((c) => String(c[3]).endsWith('/media'))
    .map((c) => JSON.parse((c[4] as { body: string }).body) as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  payload = {
    create: vi.fn().mockResolvedValue({ id: 'row_new' }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    logger: undefined,
    update: vi.fn().mockResolvedValue({ id: 'row_existing' }),
  }
  // Default: pass through (no conversion)
  mockedResolve.mockImplementation(({ imageUrl }) =>
    Promise.resolve({
      converted: false,
      url: imageUrl,
    }),
  )
})

describe('publishInstagramMedia — validation', () => {
  it('requires an igUserId', async () => {
    setupFlow()
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { igUserId: '', imageUrl: 'https://x/y.jpg' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('requires an asset for a non-carousel post', async () => {
    setupFlow()
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { igUserId: 'ig1', mediaType: 'IMAGE' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a caption over 2200 chars', async () => {
    setupFlow()
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { caption: 'x'.repeat(2300), igUserId: 'ig1', imageUrl: 'https://x/y.jpg' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/caption exceeds/i)
  })

  it('rejects a caption with more than 30 hashtags', async () => {
    setupFlow()
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { caption: '#a '.repeat(31), igUserId: 'ig1', imageUrl: 'https://x/y.jpg' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/hashtags/i)
  })

  it('rejects a carousel with fewer than 2 children', async () => {
    setupFlow()
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: {
          carouselChildren: [{ imageUrl: 'https://x/1.jpg' }],
          igUserId: 'ig1',
          mediaType: 'CAROUSEL',
        },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/at least 2/i)
  })
})

describe('publishInstagramMedia — two-phase flow', () => {
  it('captures the media id and fences retries when audit persistence fails', async () => {
    setupFlow()
    payload.create.mockRejectedValue(new Error('database unavailable'))

    const publication = publishInstagramMedia({
      ctx: ctx(),
      input: { igUserId: 'ig_1', imageUrl: 'https://cdn.example.com/main.jpg' },
      options,
      payload: asPayload(payload),
    })

    await expect(publication).rejects.toBeInstanceOf(PublicationPersistenceError)
    await expect(publication).rejects.toMatchObject({
      outcome: 'unknown',
      publishedRef: { externalId: 'media_1', platform: 'instagram' },
    })
  })

  it('publishes a single image: create, poll FINISHED, publish', async () => {
    setupFlow()
    const result = await publishInstagramMedia({
      ctx: ctx(),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn.example.com/main.jpg', mediaType: 'IMAGE' },
      options,
      payload: asPayload(payload),
    })
    expect(result.publishedRef.externalId).toBe('media_1')
    expect(result.publishedRef.externalUrl).toBe('https://www.instagram.com/p/abc/')
    const [body] = createBodies()
    expect(body.image_url).toBe('https://cdn.example.com/main.jpg')
    expect(payload.create.mock.calls[0][0].data.status).toBe('published')
  })

  it('defaults a Reel to share_to_feed=false and honours an explicit true', async () => {
    setupFlow()
    await publishInstagramMedia({
      ctx: ctx(),
      input: { igUserId: 'ig1', mediaType: 'REELS', videoUrl: 'https://cdn/r.mp4' },
      options,
      payload: asPayload(payload),
    })
    expect(createBodies()[0]).toMatchObject({ media_type: 'REELS', share_to_feed: false })

    vi.clearAllMocks()
    payload.find.mockResolvedValue({ docs: [] })
    mockedResolve.mockImplementation(({ imageUrl }) =>
      Promise.resolve({ converted: false, url: imageUrl }),
    )
    setupFlow()
    await publishInstagramMedia({
      ctx: ctx(),
      input: {
        igUserId: 'ig1',
        mediaType: 'REELS',
        shareToFeed: true,
        videoUrl: 'https://cdn/r.mp4',
      },
      options,
      payload: asPayload(payload),
    })
    expect(createBodies()[0]).toMatchObject({ share_to_feed: true })
  })

  it('publishes a story with no caption', async () => {
    setupFlow()
    await publishInstagramMedia({
      ctx: ctx(),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/s.jpg', mediaType: 'STORIES' },
      options,
      payload: asPayload(payload),
    })
    expect(createBodies()[0]).toMatchObject({
      image_url: 'https://cdn/s.jpg',
      media_type: 'STORIES',
    })
  })

  it('builds a carousel: child containers then a parent referencing them', async () => {
    setupFlow()
    await publishInstagramMedia({
      ctx: ctx(),
      input: {
        carouselChildren: [{ imageUrl: 'https://x/1.jpg' }, { imageUrl: 'https://x/2.jpg' }],
        igUserId: 'ig1',
        mediaType: 'CAROUSEL',
      },
      options,
      payload: asPayload(payload),
    })
    const bodies = createBodies()
    const parent = bodies.find((b) => b.media_type === 'CAROUSEL')
    expect(parent?.children).toBe('container_1,container_2')
    expect(bodies.filter((b) => b.is_carousel_item === true)).toHaveLength(2)
  })
})

describe('publishInstagramMedia — idempotency + status errors', () => {
  it('short-circuits when a published row already exists', async () => {
    setupFlow()
    payload.find.mockResolvedValue({
      docs: [{ id: 'row_x', externalId: 'media_existing', status: 'published' }],
    })
    const result = await publishInstagramMedia({
      ctx: ctx(),
      input: { igUserId: 'ig1', imageUrl: 'https://x/y.jpg' },
      options,
      payload: asPayload(payload),
    })
    expect(result.alreadyExisted).toBe(true)
    expect(mockedMetaJson).not.toHaveBeenCalled()
  })

  it('throws a 410 when the container expires before publish', async () => {
    setupFlow({ status: 'EXPIRED' })
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { igUserId: 'ig1', imageUrl: 'https://x/y.jpg' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toMatchObject({ platform: 'instagram', statusCode: 410 })
  })

  it('throws when container processing errors', async () => {
    setupFlow({ status: 'ERROR' })
    await expect(
      publishInstagramMedia({
        ctx: ctx(),
        input: { igUserId: 'ig1', imageUrl: 'https://x/y.jpg' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(PlatformApiError)
  })
})

/**
 * deleteInstagramMedia: Meta's Graph API has no delete endpoint for published
 * IG Business media. The function throws synchronously with an actionable
 * message for ANY call — no network request is made.
 */
describe('deleteInstagramMedia', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'media_1',
    platform: 'instagram',
    ...over,
  })

  it('throws immediately with the unsupported message for a valid instagram ref', () => {
    expect(() =>
      deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).toThrow(/Instagram does not support/)
  })

  it('throws a ValidationError', () => {
    expect(() =>
      deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).toThrow(ValidationError)
  })

  it('makes no network request (no fetch, no makeMetaRequest, no metaJson)', () => {
    expect(() =>
      deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).toThrow()
    expect(mockedRequest).not.toHaveBeenCalled()
    expect(mockedMetaJson).not.toHaveBeenCalled()
  })

  it('throws even for a publishedRef from another platform', () => {
    expect(() =>
      deleteInstagramMedia({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ platform: 'pinterest' }),
      }),
    ).toThrow(ValidationError)
  })

  it('throws even when externalId is absent', () => {
    expect(() =>
      deleteInstagramMedia({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ externalId: undefined }),
      }),
    ).toThrow()
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('message contains the localOnly reconcile instruction', () => {
    expect(() =>
      deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).toThrow(/localOnly=true/)
  })
})

describe('publishInstagramMedia — idempotency key uses ORIGINAL url when autoConvert fires', () => {
  const ORIGINAL_URL = 'https://cdn.example.com/image.avif'
  const CONVERTED_URL = 'https://cdn.example.com/renditions/socials-rendition-abcd1234.jpg'

  const autoConvertOptions = {
    assets: {
      autoConvert: true,
      jpegQuality: 82,
      preflight: true,
      renditionCollection: 'media',
    },
    copyOverrides: {},
    platforms: { instagram: { apiVersion: 'v25.0', enabled: true } },
  } as unknown as NormalizedPluginOptions

  beforeEach(() => {
    // Simulate conversion: returns a different URL.
    mockedResolve.mockResolvedValue({ converted: true, format: 'jpeg', url: CONVERTED_URL })
    setupFlow()
  })

  it('idempotencyKey matches buildPublicationIdentity for the ORIGINAL url', async () => {
    const input = {
      igUserId: 'ig1',
      imageUrl: ORIGINAL_URL,
      mediaType: 'IMAGE' as const,
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishInstagramMedia({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'instagram',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    // Keys must be derived from the ORIGINAL url, not the converted one.
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)
    // The stored imageUrl must be the original.
    expect(saved.imageUrl).toBe(ORIGINAL_URL)

    // The outbound API container body must carry the CONVERTED url.
    const containerBody = createBodies()[0]
    expect(containerBody.image_url).toBe(CONVERTED_URL)
  })

  it('sourceHash includes the ORIGINAL primaryAssetUrl, not the converted one', async () => {
    const input = {
      igUserId: 'ig1',
      imageUrl: ORIGINAL_URL,
      mediaType: 'IMAGE' as const,
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishInstagramMedia({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const { sha256Hex } = await import('../../../utilities/hash.js')

    const recomputedWithOriginal = sha256Hex(
      JSON.stringify({
        caption: saved.body,
        carouselChildren: undefined,
        igUserId: 'ig1',
        mediaType: 'IMAGE',
        primaryAssetUrl: ORIGINAL_URL,
      }),
    )
    const recomputedWithConverted = sha256Hex(
      JSON.stringify({
        caption: saved.body,
        carouselChildren: undefined,
        igUserId: 'ig1',
        mediaType: 'IMAGE',
        primaryAssetUrl: CONVERTED_URL,
      }),
    )

    expect(saved.sourceHash).toBe(recomputedWithOriginal)
    expect(saved.sourceHash).not.toBe(recomputedWithConverted)
  })

  it('STORIES: outbound body uses converted url, key uses original', async () => {
    const input = {
      igUserId: 'ig1',
      imageUrl: ORIGINAL_URL,
      mediaType: 'STORIES' as const,
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishInstagramMedia({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'instagram',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    const saved = payload.create.mock.calls[0][0].data
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)

    const containerBody = createBodies()[0]
    expect(containerBody.image_url).toBe(CONVERTED_URL)
  })

  it('with autoConvert OFF and an allowed format, passes through unchanged', async () => {
    const passthroughOptions = {
      assets: { autoConvert: false, jpegQuality: 82, preflight: true },
      copyOverrides: {},
      platforms: { instagram: { apiVersion: 'v25.0', enabled: true } },
    } as unknown as NormalizedPluginOptions

    const JPEG_URL = 'https://cdn.example.com/image.jpg'
    mockedResolve.mockResolvedValue({ converted: false, format: 'jpeg', url: JPEG_URL })

    const input = {
      igUserId: 'ig1',
      imageUrl: JPEG_URL,
      mediaType: 'IMAGE' as const,
    }
    const testCtx = ctx({ images: [{ format: 'jpeg', role: 'main', url: JPEG_URL }] })

    await publishInstagramMedia({
      ctx: testCtx,
      input,
      options: passthroughOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'instagram',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)

    const containerBody = createBodies()[0]
    // No conversion: outbound body also uses the original url.
    expect(containerBody.image_url).toBe(JPEG_URL)
  })
})
