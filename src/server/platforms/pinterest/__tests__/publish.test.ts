import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import { ValidationError } from '../../../utilities/errors.js'
import { buildPublicationIdentity } from '../../../utilities/publicationIdentity.js'

vi.mock('../api.js', () => ({
  makePinterestRequest: vi.fn(),
  pinterestJson: vi.fn(),
}))
vi.mock('../videoUpload.js', () => ({ uploadPinterestVideoFromUrl: vi.fn() }))
vi.mock('../../../assets/resolvePlatformImage.js', () => ({
  resolvePlatformImageUrl: vi.fn(),
}))

import { resolvePlatformImageUrl } from '../../../assets/resolvePlatformImage.js'
import { makePinterestRequest, pinterestJson } from '../api.js'
import { buildPinterestPreview, deletePinterestPin, publishPinterestPin } from '../publish.js'
import { uploadPinterestVideoFromUrl } from '../videoUpload.js'

const mockedPinterestJson = vi.mocked(pinterestJson)
const mockedRequest = vi.mocked(makePinterestRequest)
const mockedVideoUpload = vi.mocked(uploadPinterestVideoFromUrl)
const mockedResolve = vi.mocked(resolvePlatformImageUrl)

const options = {
  copyOverrides: {},
  platforms: { pinterest: { environment: 'production' } },
} as unknown as NormalizedPluginOptions

const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'A regal marble lion.',
  baseTitle: 'Marble Lion',
  images: [
    { role: 'detail', url: 'https://cdn.example.com/detail.jpg' },
    { role: 'main', url: 'https://cdn.example.com/main.jpg' },
  ],
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

describe('buildPinterestPreview', () => {
  it('prefers the image with role "main" as the default image', () => {
    const preview = buildPinterestPreview(ctx(), options)
    expect(preview.defaultImageUrl).toBe('https://cdn.example.com/main.jpg')
    expect(preview.availableImages).toHaveLength(2)
    expect(preview.source.kind).toBe('product')
  })
})

describe('publishPinterestPin — validation', () => {
  it('requires a boardId', async () => {
    await expect(
      publishPinterestPin({
        ctx: ctx(),
        input: { boardId: '' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('requires an image', async () => {
    await expect(
      publishPinterestPin({
        ctx: ctx({ images: [] }),
        input: { boardId: 'b1' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/image/i)
  })

  it('requires an outbound link', async () => {
    await expect(
      publishPinterestPin({
        ctx: ctx({ link: '' }),
        input: { boardId: 'b1' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/link/i)
  })
})

describe('publishPinterestPin — idempotency', () => {
  it('short-circuits when a published row already exists for the same key', async () => {
    payload.find.mockResolvedValue({
      docs: [
        {
          id: 'row_existing',
          externalId: 'pin_existing',
          externalUrl: 'https://www.pinterest.com/pin/pin_existing/',
          idempotencyKey: 'k',
          status: 'published',
        },
      ],
    })
    const result = await publishPinterestPin({
      ctx: ctx(),
      input: { boardId: 'b1' },
      options,
      payload: asPayload(payload),
    })
    expect(result.alreadyExisted).toBe(true)
    expect(result.publishedRef.externalId).toBe('pin_existing')
    expect(mockedPinterestJson).not.toHaveBeenCalled()
    expect(payload.create).not.toHaveBeenCalled()
  })

  it('republishes (updates in place) when the existing row is cancelled', async () => {
    payload.find.mockResolvedValue({
      docs: [{ id: 'row_cancelled', idempotencyKey: 'k', status: 'cancelled' }],
    })
    payload.update.mockResolvedValue({ id: 'row_cancelled' })
    mockedPinterestJson.mockResolvedValue({ id: 'pin_new', link: 'https://pin/url' })
    const result = await publishPinterestPin({
      ctx: ctx(),
      input: { boardId: 'b1' },
      options,
      payload: asPayload(payload),
    })
    expect(result.alreadyExisted).toBe(false)
    expect(result.postId).toBe('row_cancelled')
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'row_cancelled' }))
    expect(payload.create).not.toHaveBeenCalled()
  })
})

describe('publishPinterestPin — create + body', () => {
  it('creates the pin with an image_url media source and persists a published row', async () => {
    mockedPinterestJson.mockResolvedValue({ id: 'pin_1', link: 'https://pin/url/1' })
    const result = await publishPinterestPin({
      ctx: ctx(),
      input: { boardId: 'b1', boardName: 'Statues' },
      options,
      payload: asPayload(payload),
    })

    expect(result.alreadyExisted).toBe(false)
    expect(result.publishedRef.externalId).toBe('pin_1')

    const [, , path, init] = mockedPinterestJson.mock.calls[0]
    expect(path).toBe('/v5/pins')
    const body = JSON.parse((init as { body: string }).body)
    expect(body.board_id).toBe('b1')
    expect(body.media_source).toEqual({
      source_type: 'image_url',
      url: 'https://cdn.example.com/main.jpg',
    })

    const created = payload.create.mock.calls[0][0].data
    expect(created.status).toBe('published')
    expect(created.externalId).toBe('pin_1')
    expect(typeof created.idempotencyKey).toBe('string')
    expect(typeof created.sourceHash).toBe('string')
  })

  it('truncates title, description, and alt text to Pinterest limits', async () => {
    mockedPinterestJson.mockResolvedValue({ id: 'pin_1' })
    await publishPinterestPin({
      ctx: ctx(),
      input: {
        altText: 'a'.repeat(800),
        boardId: 'b1',
        description: 'd'.repeat(900),
        title: 't'.repeat(200),
      },
      options,
      payload: asPayload(payload),
    })
    const body = JSON.parse((mockedPinterestJson.mock.calls[0][3] as { body: string }).body)
    expect(body.title.length).toBeLessThanOrEqual(100)
    expect(body.description.length).toBeLessThanOrEqual(500)
    expect(body.alt_text.length).toBeLessThanOrEqual(500)
  })

  it('derives the pin URL from the id when the API omits a link', async () => {
    mockedPinterestJson.mockResolvedValue({ id: 'pin_42' })
    const result = await publishPinterestPin({
      ctx: ctx(),
      input: { boardId: 'b1' },
      options,
      payload: asPayload(payload),
    })
    expect(result.publishedRef.externalUrl).toBe('https://www.pinterest.com/pin/pin_42/')
  })

  it('uploads and publishes a video Pin with its required cover image', async () => {
    mockedVideoUpload.mockResolvedValue('media_1')
    mockedPinterestJson.mockResolvedValue({ id: 'pin_video' })
    await publishPinterestPin({
      ctx: ctx({
        videos: [
          {
            coverImageUrl: 'https://cdn.example.com/cover.jpg',
            url: 'https://cdn.example.com/video.mp4',
          },
        ],
      }),
      input: { boardId: 'b1', mediaType: 'VIDEO' },
      options,
      payload: asPayload(payload),
    })

    expect(mockedVideoUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    )
    const createCall = mockedPinterestJson.mock.calls.find((call) => call[2] === '/v5/pins')
    const body = JSON.parse((createCall?.[3] as { body: string }).body)
    expect(body.media_source).toEqual({
      cover_image_url: 'https://cdn.example.com/cover.jpg',
      media_id: 'media_1',
      source_type: 'video_id',
    })
  })

  it('uses a pre-uploaded mediaId without transferring the video again', async () => {
    mockedPinterestJson.mockResolvedValue({ id: 'pin_video' })
    await publishPinterestPin({
      ctx: ctx(),
      input: {
        boardId: 'b1',
        coverImageUrl: 'https://cdn.example.com/cover.jpg',
        mediaId: 'media_existing',
        mediaType: 'VIDEO',
      },
      options,
      payload: asPayload(payload),
    })
    expect(mockedVideoUpload).not.toHaveBeenCalled()
  })
})

describe('deletePinterestPin', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'pin_1',
    platform: 'pinterest',
    ...over,
  })

  it('rejects a publishedRef for another platform', async () => {
    await expect(
      deletePinterestPin({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ platform: 'facebook' }),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is a no-op when there is no externalId', async () => {
    await deletePinterestPin({
      options,
      payload: asPayload(payload),
      publishedRef: ref({ externalId: undefined }),
    })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('deletes upstream and flips the local row to cancelled', async () => {
    mockedRequest.mockResolvedValue({ ok: true, status: 204 } as unknown as Response)
    payload.find.mockResolvedValue({ docs: [{ id: 'row_1' }] })
    await deletePinterestPin({ options, payload: asPayload(payload), publishedRef: ref() })
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    )
  })

  it('treats a 404 from Pinterest as an idempotent success', async () => {
    mockedRequest.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)
    payload.find.mockResolvedValue({ docs: [] })
    await expect(
      deletePinterestPin({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).resolves.toBeUndefined()
  })

  it('throws on a non-404 failure', async () => {
    mockedRequest.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('server error'),
    } as unknown as Response)
    await expect(
      deletePinterestPin({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('publishPinterestPin — idempotency key uses ORIGINAL url when autoConvert fires', () => {
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
    platforms: { pinterest: { environment: 'production' } },
  } as unknown as NormalizedPluginOptions

  beforeEach(() => {
    // Simulate conversion: returns a different URL.
    mockedResolve.mockResolvedValue({ converted: true, format: 'jpeg', url: CONVERTED_URL })
    mockedPinterestJson.mockResolvedValue({ id: 'pin_converted', link: 'https://pin/url' })
  })

  it('idempotencyKey and primaryAssetUrl match buildPublicationIdentity for the ORIGINAL url', async () => {
    const input = {
      boardId: 'board_1',
      imageUrl: ORIGINAL_URL,
    }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishPinterestPin({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'pinterest',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })

    // Keys must be derived from the ORIGINAL url, not the converted one.
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)
    expect(saved.imageUrl).toBe(ORIGINAL_URL)

    // The outbound API request body must carry the CONVERTED url.
    const pinBody = JSON.parse(
      (mockedPinterestJson.mock.calls.find((c) => c[2] === '/v5/pins')?.[3] as { body: string })
        .body,
    )
    expect(pinBody.media_source.url).toBe(CONVERTED_URL)
  })

  it('sourceHash includes the ORIGINAL url, not the converted one', async () => {
    const input = { boardId: 'board_1', imageUrl: ORIGINAL_URL }
    const testCtx = ctx({ images: [{ format: 'avif', role: 'main', url: ORIGINAL_URL }] })

    await publishPinterestPin({
      ctx: testCtx,
      input,
      options: autoConvertOptions,
      payload: asPayload(payload),
    })

    // Rebuild expected sourceHash independently using original url.
    const { sha256Hex } = await import('../../../utilities/hash.js')
    const expectedHash = sha256Hex(
      JSON.stringify({
        altText: expect.any(String) as unknown as string,
        assetUrl: ORIGINAL_URL,
        boardId: 'board_1',
        description: expect.any(String) as unknown as string,
        link: expect.any(String) as unknown as string,
        mediaType: 'IMAGE',
        title: expect.any(String) as unknown as string,
      }),
    )

    const saved = payload.create.mock.calls[0][0].data
    // The saved sourceHash must NOT be based on the converted url.
    // We verify this by recomputing with the original url and confirming they match.
    const recomputedWithOriginal = sha256Hex(
      JSON.stringify({
        altText: saved.altText,
        assetUrl: ORIGINAL_URL,
        boardId: 'board_1',
        description: saved.body,
        link: saved.link,
        mediaType: 'IMAGE',
        title: saved.title,
      }),
    )
    const recomputedWithConverted = sha256Hex(
      JSON.stringify({
        altText: saved.altText,
        assetUrl: CONVERTED_URL,
        boardId: 'board_1',
        description: saved.body,
        link: saved.link,
        mediaType: 'IMAGE',
        title: saved.title,
      }),
    )
    expect(saved.sourceHash).toBe(recomputedWithOriginal)
    expect(saved.sourceHash).not.toBe(recomputedWithConverted)
    // Suppress the unused variable warning from expectedHash.
    void expectedHash
  })

  it('with autoConvert OFF and an allowed format, passes through unchanged', async () => {
    const passthroughOptions = {
      assets: { autoConvert: false, jpegQuality: 82, preflight: true },
      copyOverrides: {},
      platforms: { pinterest: { environment: 'production' } },
    } as unknown as NormalizedPluginOptions

    const JPEG_URL = 'https://cdn.example.com/image.jpg'
    mockedResolve.mockResolvedValue({ converted: false, format: 'jpeg', url: JPEG_URL })
    mockedPinterestJson.mockResolvedValue({ id: 'pin_jpeg', link: 'https://pin/url' })

    const input = { boardId: 'board_1', imageUrl: JPEG_URL }
    const testCtx = ctx({ images: [{ format: 'jpeg', role: 'main', url: JPEG_URL }] })

    await publishPinterestPin({
      ctx: testCtx,
      input,
      options: passthroughOptions,
      payload: asPayload(payload),
    })

    const saved = payload.create.mock.calls[0][0].data
    const pinBody = JSON.parse(
      (mockedPinterestJson.mock.calls.find((c) => c[2] === '/v5/pins')?.[3] as { body: string })
        .body,
    )
    // With no conversion, both the key and outbound body use the same original url.
    expect(saved.imageUrl).toBe(JPEG_URL)
    expect(pinBody.media_source.url).toBe(JPEG_URL)

    const expected = buildPublicationIdentity({
      ctx: testCtx,
      input,
      platform: 'pinterest',
      sourceId: testCtx.sourceId,
      sourceKind: testCtx.sourceKind,
    })
    expect(saved.idempotencyKey).toBe(expected.idempotencyKey)
  })
})
