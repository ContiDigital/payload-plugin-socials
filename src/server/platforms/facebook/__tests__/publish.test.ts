import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import { ValidationError } from '../../../utilities/errors.js'
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
import { deleteFacebookPost, publishFacebookPost } from '../publish.js'

const mockedMetaJson = vi.mocked(metaJson)
const mockedRequest = vi.mocked(makeMetaRequest)
const mockedResolve = vi.mocked(resolvePlatformImageUrl)

const options = {
  copyOverrides: {},
  platforms: { facebook: { apiVersion: 'v25.0', enabled: true } },
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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

const setupPublish = (feed: Record<string, unknown> = { id: 'feed_1', post_id: 'p1_123' }) => {
  mockedMetaJson.mockResolvedValue({ id: 'p1', access_token: 'PAGE_TOKEN' })
  let photoN = 0
  mockedRequest.mockImplementation((_p, _o, _plat, path) => {
    const p = String(path)
    if (p.includes('/photos')) {
      photoN += 1
      return Promise.resolve(jsonResponse({ id: `photo_${photoN}` }))
    }
    if (p.includes('/videos')) {
      return Promise.resolve(jsonResponse({ id: 'vid_1', post_id: 'p1_777' }))
    }
    return Promise.resolve(jsonResponse(feed))
  })
}

const requestParams = (pathFragment: string): URLSearchParams => {
  const call = mockedRequest.mock.calls.find((c) => String(c[3]).includes(pathFragment))
  const init = (call?.[4] as { init: { body: string } }).init
  return new URLSearchParams(init.body)
}

const requestOpts = (
  pathFragment: string,
): { accessToken?: string; skipAppsecretProof?: boolean } => {
  const call = mockedRequest.mock.calls.find((c) => String(c[3]).includes(pathFragment))
  return call?.[4] as { skipAppsecretProof?: boolean }
}

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

describe('publishFacebookPost — formats', () => {
  it('publishes a LINK post to /feed using the Page token', async () => {
    setupPublish()
    const result = await publishFacebookPost({
      ctx: ctx(),
      input: { format: 'LINK', link: 'https://example.com/p', pageId: 'p1' },
      options,
      payload: asPayload(payload),
    })
    expect(result.publishedRef.externalId).toBe('p1_123')
    expect(result.publishedRef.externalUrl).toBe('https://www.facebook.com/p1/posts/123')
    const params = requestParams('/feed')
    expect(params.get('access_token')).toBeNull()
    expect(params.get('link')).toBe('https://example.com/p')
    expect(requestOpts('/feed')).toMatchObject({ accessToken: 'PAGE_TOKEN' })
    expect(requestOpts('/feed').skipAppsecretProof).not.toBe(true)
  })

  it('publishes a single PHOTO with caption + url', async () => {
    setupPublish()
    await publishFacebookPost({
      ctx: ctx(),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/x.jpg', pageId: 'p1' },
      options,
      payload: asPayload(payload),
    })
    const params = requestParams('/photos')
    expect(params.get('url')).toBe('https://cdn/x.jpg')
    expect(params.get('caption')).toBeTruthy()
  })

  it('assembles a PHOTO_MULTI post: unpublished photos then a /feed parent', async () => {
    setupPublish()
    await publishFacebookPost({
      ctx: ctx(),
      input: {
        format: 'PHOTO_MULTI',
        imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
        pageId: 'p1',
      },
      options,
      payload: asPayload(payload),
    })
    const photoCalls = mockedRequest.mock.calls.filter((c) => String(c[3]).includes('/photos'))
    expect(photoCalls).toHaveLength(2)
    const attached = JSON.parse(requestParams('/feed').get('attached_media') ?? '[]')
    expect(attached).toEqual([{ media_fbid: 'photo_1' }, { media_fbid: 'photo_2' }])
  })

  it('rejects PHOTO_MULTI outside the 2 to 10 range', async () => {
    setupPublish()
    await expect(
      publishFacebookPost({
        ctx: ctx(),
        input: { format: 'PHOTO_MULTI', imageUrls: ['https://cdn/1.jpg'], pageId: 'p1' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/2.*10/)
  })

  it('publishes a VIDEO via file_url', async () => {
    setupPublish()
    await publishFacebookPost({
      ctx: ctx(),
      input: { format: 'VIDEO', pageId: 'p1', videoUrl: 'https://cdn/v.mp4' },
      options,
      payload: asPayload(payload),
    })
    expect(requestParams('/videos').get('file_url')).toBe('https://cdn/v.mp4')
  })
})

describe('publishFacebookPost — scheduling', () => {
  it('records a platform-scheduled post as accepted and pending', async () => {
    setupPublish()
    const when = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const result = await publishFacebookPost({
      ctx: ctx(),
      input: {
        format: 'LINK',
        link: 'https://example.com/p',
        pageId: 'p1',
        scheduledPublishTime: when,
      },
      options,
      payload: asPayload(payload),
    })
    expect(payload.create.mock.calls[0][0].data.status).toBe('published')
    expect(payload.create.mock.calls[0][0].data.platformPublicationStatus).toBe('pending')
    expect(payload.create.mock.calls[0][0].data.publishedAt).toBe(
      new Date(Math.floor(Date.parse(when) / 1000) * 1000).toISOString(),
    )
    expect(requestParams('/feed').get('published')).toBe('false')
    expect(result.publishedRef.meta?.scheduled).toBe(true)
  })

  it('rejects a schedule less than 10 minutes out', async () => {
    setupPublish()
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await expect(
      publishFacebookPost({
        ctx: ctx(),
        input: { format: 'LINK', pageId: 'p1', scheduledPublishTime: soon },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/10 minutes/)
  })

  it('rejects a non-ISO schedule string', async () => {
    setupPublish()
    await expect(
      publishFacebookPost({
        ctx: ctx(),
        input: { format: 'LINK', pageId: 'p1', scheduledPublishTime: 'not-a-date' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/ISO/)
  })
})

describe('publishFacebookPost — validation + idempotency', () => {
  it('requires a pageId', async () => {
    await expect(
      publishFacebookPost({
        ctx: ctx(),
        input: { pageId: '' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an empty text-only post', async () => {
    setupPublish()
    await expect(
      publishFacebookPost({
        ctx: ctx({ baseDescription: '', baseTitle: '' }),
        input: { format: 'LINK', pageId: 'p1' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/message, link, photo, or video/)
  })

  it('short-circuits when a published row already exists', async () => {
    payload.find.mockResolvedValue({
      docs: [{ id: 'row_x', externalId: 'p1_999', status: 'published' }],
    })
    const result = await publishFacebookPost({
      ctx: ctx(),
      input: { format: 'LINK', link: 'https://example.com/p', pageId: 'p1' },
      options,
      payload: asPayload(payload),
    })
    expect(result.alreadyExisted).toBe(true)
    expect(mockedRequest).not.toHaveBeenCalled()
  })
})

describe('deleteFacebookPost', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'p1_123',
    platform: 'facebook',
    ...over,
  })

  it('rejects a publishedRef for another platform', async () => {
    await expect(
      deleteFacebookPost({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ platform: 'pinterest' }),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is a no-op without an external id', async () => {
    await deleteFacebookPost({
      options,
      payload: asPayload(payload),
      publishedRef: ref({ externalId: undefined }),
    })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('deletes upstream with the Page token and flips the row to cancelled', async () => {
    mockedMetaJson.mockResolvedValue({ id: 'p1', access_token: 'PAGE_TOKEN' })
    mockedRequest.mockResolvedValue(jsonResponse({ success: true }))
    payload.find.mockResolvedValue({ docs: [{ id: 'row_1' }] })
    await deleteFacebookPost({ options, payload: asPayload(payload), publishedRef: ref() })
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    )
  })

  it('throws on a non-404 failure', async () => {
    mockedMetaJson.mockResolvedValue({ id: 'p1', access_token: 'PAGE_TOKEN' })
    mockedRequest.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(
      deleteFacebookPost({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('publishFacebookPost — idempotency key uses ORIGINAL url when autoConvert fires', () => {
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
    platforms: { facebook: { apiVersion: 'v25.0', enabled: true } },
  } as unknown as NormalizedPluginOptions

  beforeEach(() => {
    // Simulate conversion: returns a different URL.
    mockedResolve.mockResolvedValue({ converted: true, format: 'jpeg', url: CONVERTED_URL })
    setupPublish({ id: 'photo_1', post_id: 'p1_999' })
  })

  it('PHOTO: idempotencyKey matches buildPublicationIdentity for the ORIGINAL url', async () => {
    const input = {
      format: 'PHOTO' as const,
      imageUrl: ORIGINAL_URL,
      pageId: 'p1',
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    // Key must be derived from the ORIGINAL url, not the converted one.
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)
    // The stored imageUrl must be the original.
    expect(saved.imageUrl).toBe(ORIGINAL_URL)

    // The outbound API request body must carry the CONVERTED url.
    const params = requestParams('/photos')
    expect(params.get('url')).toBe(CONVERTED_URL)
  })

  it('PHOTO: sourceHash uses the ORIGINAL primaryAssetUrl', async () => {
    const input = {
      format: 'PHOTO' as const,
      imageUrl: ORIGINAL_URL,
      pageId: 'p1',
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const { sha256Hex } = await import('../../../utilities/hash.js')

    const recomputedWithOriginal = sha256Hex(
      JSON.stringify({
        format: 'PHOTO',
        message: saved.body,
        pageId: 'p1',
        primaryAssetUrl: ORIGINAL_URL,
      }),
    )
    const recomputedWithConverted = sha256Hex(
      JSON.stringify({
        format: 'PHOTO',
        message: saved.body,
        pageId: 'p1',
        primaryAssetUrl: CONVERTED_URL,
      }),
    )

    expect(saved.sourceHash).toBe(recomputedWithOriginal)
    expect(saved.sourceHash).not.toBe(recomputedWithConverted)
  })

  it('PHOTO_MULTI: idempotencyKey uses the ORIGINAL first url; each outbound photo uses converted', async () => {
    const ORIG_1 = 'https://cdn.example.com/1.avif'
    const ORIG_2 = 'https://cdn.example.com/2.avif'
    const CONV_1 = 'https://cdn.example.com/renditions/1.jpg'
    const CONV_2 = 'https://cdn.example.com/renditions/2.jpg'

    // Return different converted urls per original.
    mockedResolve.mockImplementation(({ imageUrl }) =>
      Promise.resolve({
        converted: true,
        format: 'jpeg' as const,
        url: imageUrl === ORIG_1 ? CONV_1 : CONV_2,
      }),
    )
    setupPublish({ id: 'feed_multi', post_id: 'p1_multi' })

    const input = {
      format: 'PHOTO_MULTI' as const,
      imageUrls: [ORIG_1, ORIG_2],
      pageId: 'p1',
    }
    const testCtx = ctx()

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    // Key must use original first url.
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)

    // Outbound /photos calls must use the converted urls.
    const photoCalls = mockedRequest.mock.calls.filter((c) => String(c[3]).includes('/photos'))
    const uploadedUrls = photoCalls.map((c) =>
      new URLSearchParams((c[4] as { init: { body: string } }).init.body).get('url'),
    )
    expect(uploadedUrls).toContain(CONV_1)
    expect(uploadedUrls).toContain(CONV_2)
    expect(uploadedUrls).not.toContain(ORIG_1)
    expect(uploadedUrls).not.toContain(ORIG_2)
  })

  it('with autoConvert OFF and an allowed format, passes through unchanged', async () => {
    const passthroughOptions = {
      assets: { autoConvert: false, jpegQuality: 82, preflight: true },
      copyOverrides: {},
      platforms: { facebook: { apiVersion: 'v25.0', enabled: true } },
    } as unknown as NormalizedPluginOptions

    const JPEG_URL = 'https://cdn.example.com/image.jpg'
    mockedResolve.mockResolvedValue({ converted: false, format: 'jpeg', url: JPEG_URL })
    setupPublish({ id: 'photo_jpeg', post_id: 'p1_jpeg' })

    const input = { format: 'PHOTO' as const, imageUrl: JPEG_URL, pageId: 'p1' }
    const testCtx = ctx({ images: [{ format: 'jpeg', role: 'main', url: JPEG_URL }] })

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options: passthroughOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)

    // No conversion: outbound body also uses the original url.
    const params = requestParams('/photos')
    expect(params.get('url')).toBe(JPEG_URL)
  })
})
