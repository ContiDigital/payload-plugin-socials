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
import { deleteFacebookPost, deriveFacebookIdentity, publishFacebookPost } from '../publish.js'

const mockedMetaJson = vi.mocked(metaJson)
const mockedRequest = vi.mocked(makeMetaRequest)
const mockedResolveImage = vi.mocked(resolvePlatformImageUrl)

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
  // Default: passthrough (preflight off / no conversion needed).
  mockedResolveImage.mockImplementation((args) =>
    Promise.resolve({ converted: false, url: args.imageUrl }),
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

  it('key and primaryAssetUrl use the ORIGINAL imageUrl even when autoConvert returns a different URL', async () => {
    const originalUrl = 'https://cdn.example.com/main.jpg'
    const convertedUrl = 'https://payload.example.com/media/main-facebook.jpg'

    // Simulate autoConvert returning a converted URL for the outbound body.
    mockedResolveImage.mockResolvedValue({ converted: true, url: convertedUrl })
    setupPublish()

    const input = { format: 'PHOTO' as const, imageUrl: originalUrl, pageId: 'p1' }
    const testCtx = ctx()

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options,
      payload: asPayload(payload),
    })

    // The persisted row must use the ORIGINAL-derived key.
    const expectedIdentity = deriveFacebookIdentity(testCtx, input)
    const expectedPublicationIdentity = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    const persistedData = (payload.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data

    // idempotencyKey must match the original-url derivation.
    expect(persistedData.idempotencyKey).toBe(expectedIdentity.idempotencyKey)
    expect(persistedData.idempotencyKey).toBe(expectedPublicationIdentity.idempotencyKey)

    // imageUrl stored on the row is the ORIGINAL URL.
    expect(persistedData.imageUrl).toBe(originalUrl)

    // The OUTBOUND Facebook API body must carry the CONVERTED url.
    const photoUrl = requestParams('/photos').get('url')
    expect(photoUrl).toBe(convertedUrl)
  })

  it('key is identical to buildPublicationIdentity with preflight OFF (default passthrough)', async () => {
    setupPublish()
    const input = { format: 'PHOTO' as const, imageUrl: 'https://cdn/x.jpg', pageId: 'p1' }
    const testCtx = ctx()

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options,
      payload: asPayload(payload),
    })

    const expectedIdentity = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })
    const persistedData = (payload.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data
    expect(persistedData.idempotencyKey).toBe(expectedIdentity.idempotencyKey)
  })

  it('PHOTO_MULTI: key uses the ORIGINAL first imageUrl even when autoConvert returns a different URL', async () => {
    const originalUrls = ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']
    const convertedUrls = [
      'https://payload.example.com/media/1-facebook.jpg',
      'https://payload.example.com/media/2-facebook.jpg',
    ]

    mockedResolveImage
      .mockResolvedValueOnce({ converted: true, url: convertedUrls[0] })
      .mockResolvedValueOnce({ converted: true, url: convertedUrls[1] })
    setupPublish()

    const input = { format: 'PHOTO_MULTI' as const, imageUrls: originalUrls, pageId: 'p1' }
    const testCtx = ctx()

    await publishFacebookPost({
      ctx: testCtx,
      input,
      options,
      payload: asPayload(payload),
    })

    const expectedIdentity = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'facebook',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })
    const persistedData = (payload.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data
    expect(persistedData.idempotencyKey).toBe(expectedIdentity.idempotencyKey)

    // Photos are uploaded using the converted URLs.
    const photoCalls = mockedRequest.mock.calls.filter((c) => String(c[3]).includes('/photos'))
    const uploadedUrls = photoCalls.map((c) =>
      new URLSearchParams((c[4] as { init: { body: string } }).init.body).get('url'),
    )
    expect(uploadedUrls).toEqual(convertedUrls)
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
