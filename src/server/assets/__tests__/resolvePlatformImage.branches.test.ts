import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { ValidationError } from '../../utilities/errors.js'
import { resolvePlatformImageUrl } from '../resolvePlatformImage.js'
import { fetchRemoteImageBytes } from '../safeRemoteImage.js'

// Mock detectImageFormat at the module level
vi.mock('../detectImageFormat.js', () => ({
  detectImageFormat: vi.fn(),
}))
vi.mock('../safeRemoteImage.js', () => ({
  fetchRemoteImageBytes: vi.fn(),
}))

// Mock the sharp import used inside resolvePlatformImage
vi.mock('sharp', () => ({
  default: (_buf: Buffer) => ({
    jpeg: (opts?: { quality?: number }) => ({
      toBuffer: () => Promise.resolve(Buffer.from(`jpeg-${opts?.quality ?? 80}`)),
    }),
  }),
}))

const { detectImageFormat } = await import('../detectImageFormat.js')
const mockedDetect = vi.mocked(detectImageFormat)
const mockedFetchRemoteImageBytes = vi.mocked(fetchRemoteImageBytes)

const makeOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: {
      autoConvert: false,
      jpegQuality: 82,
      preflight: true,
      remoteFetchTimeoutMs: 15_000,
      renditionCollection: undefined,
      trustedRemoteHosts: ['cdn.example.com'],
      ...overrides,
    },
  }) as unknown as NormalizedPluginOptions

const makePayload = (findDocs: Array<{ url: string }> = []) => {
  const mock = {
    config: { serverURL: 'https://app.example.com' },
    create: vi.fn().mockResolvedValue({ url: '/media/socials-rendition-abc12345.jpg' }),
    find: vi.fn().mockResolvedValue({ docs: findDocs }),
  }
  return mock as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'] & typeof mock
}

describe('resolvePlatformImageUrl — additional branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFetchRemoteImageBytes.mockResolvedValue({
      bytes: new Uint8Array(100),
      finalUrl: 'https://cdn.example.com/photo.webp',
    })
  })

  it('throws when autoConvert is enabled but renditionCollection is not set', async () => {
    const options = makeOptions({ autoConvert: true, renditionCollection: undefined })
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'webp',
        imageUrl: 'https://cdn.example.com/photo.webp',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/renditionCollection/)
  })

  it('throws when fetch returns a non-ok response during transcode', async () => {
    mockedFetchRemoteImageBytes.mockRejectedValueOnce(
      new ValidationError('Remote image could not be fetched (HTTP 404)'),
    )
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'webp',
        imageUrl: 'https://cdn.example.com/photo.webp',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/Remote image could not be fetched/)
  })

  it('throws when content-length exceeds 25MB', async () => {
    mockedFetchRemoteImageBytes.mockRejectedValueOnce(
      new ValidationError('Remote image exceeds the configured 25 MB processing limit'),
    )
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'webp',
        imageUrl: 'https://cdn.example.com/photo.webp',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/25 MB processing limit/)
  })

  it('stops streaming when the actual body exceeds 25MB', async () => {
    mockedFetchRemoteImageBytes.mockRejectedValueOnce(
      new ValidationError('Remote image exceeds the configured 25 MB processing limit'),
    )
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'webp',
        imageUrl: 'https://cdn.example.com/photo.webp',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/25 MB processing limit/)
  })

  it('absolutizes a relative rendition URL from existing rendition lookup', async () => {
    // Existing rendition has a relative URL
    const payload = makePayload([{ url: '/uploads/socials-rendition-abc.jpg' }])
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(true)
    expect(result.url).toBe('https://app.example.com/uploads/socials-rendition-abc.jpg')
    expect(payload.create).not.toHaveBeenCalled()
  })

  it('returns an existing rendition with an absolute URL unchanged', async () => {
    const payload = makePayload([{ url: 'https://cdn.other.com/rendition.jpg' }])
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload,
      platform: 'instagram',
    })
    expect(result.url).toBe('https://cdn.other.com/rendition.jpg')
  })

  it('handles findExistingRendition when payload.find throws (falls through to transcode)', async () => {
    const payload = makePayload()
    payload.find = vi.fn().mockRejectedValue(new Error('DB error'))
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: payload as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'],
      platform: 'instagram',
    })
    // Should fall through to create a new rendition
    expect(result.converted).toBe(true)
    expect(payload.create).toHaveBeenCalled()
  })

  it('absolutizes a relative URL without leading slash from created rendition', async () => {
    const payload = makePayload()
    payload.create = vi.fn().mockResolvedValue({ url: 'media/rendition.jpg' })
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: payload as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'],
      platform: 'instagram',
    })
    expect(result.url).toBe('https://app.example.com/media/rendition.jpg')
  })

  it('returns empty string when rendition.url is undefined', async () => {
    const payload = makePayload()
    payload.create = vi.fn().mockResolvedValue({})
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: payload as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'],
      platform: 'instagram',
    })
    expect(result.url).toBe('')
  })

  it('works when serverURL has trailing slash', async () => {
    const payload = makePayload()
    ;(payload as unknown as { config: { serverURL: string } }).config = {
      serverURL: 'https://app.example.com/',
    }
    payload.create = vi.fn().mockResolvedValue({ url: '/media/r.jpg' })
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: payload as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'],
      platform: 'instagram',
    })
    expect(result.url).toBe('https://app.example.com/media/r.jpg')
  })

  it('uses detectImageFormat when declaredFormat is undefined and format is allowed', async () => {
    mockedDetect.mockResolvedValue('jpeg')
    const options = makeOptions()
    const result = await resolvePlatformImageUrl({
      imageUrl: 'https://cdn.example.com/photo',
      options,
      payload: makePayload(),
      platform: 'instagram',
    })
    expect(result).toEqual({
      converted: false,
      format: 'jpeg',
      url: 'https://cdn.example.com/photo',
    })
  })

  it('findExistingRendition returns undefined when doc has no url field', async () => {
    // payload.find returns a doc without a `url` field
    const payload = makePayload()
    payload.find = vi.fn().mockResolvedValue({ docs: [{}] })
    const options = makeOptions({ autoConvert: true, renditionCollection: 'media' })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: payload as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload'],
      platform: 'instagram',
    })
    // Since doc.url is undefined, it falls through to transcode
    expect(result.converted).toBe(true)
    expect(payload.create).toHaveBeenCalled()
  })
})
