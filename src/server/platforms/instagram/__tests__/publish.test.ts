import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import { PlatformApiError, ValidationError } from '../../../utilities/errors.js'

vi.mock('../../_meta/api.js', () => ({
  makeMetaRequest: vi.fn(),
  metaJson: vi.fn(),
}))

import { makeMetaRequest, metaJson } from '../../_meta/api.js'
import { deleteInstagramMedia, publishInstagramMedia } from '../publish.js'

const mockedMetaJson = vi.mocked(metaJson)
const mockedRequest = vi.mocked(makeMetaRequest)

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

describe('deleteInstagramMedia', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'media_1',
    platform: 'instagram',
    ...over,
  })

  it('rejects a publishedRef for another platform', async () => {
    await expect(
      deleteInstagramMedia({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ platform: 'pinterest' }),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is a no-op without an external id', async () => {
    await deleteInstagramMedia({
      options,
      payload: asPayload(payload),
      publishedRef: ref({ externalId: undefined }),
    })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('deletes upstream and flips the local row to cancelled', async () => {
    mockedRequest.mockResolvedValue({ ok: true, status: 200 } as unknown as Response)
    payload.find.mockResolvedValue({ docs: [{ id: 'row_1' }] })
    await deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() })
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    )
  })

  it('throws on a non-404 failure', async () => {
    mockedRequest.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('error'),
    } as unknown as Response)
    await expect(
      deleteInstagramMedia({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
