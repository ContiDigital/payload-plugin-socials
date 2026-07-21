import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

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

describe('resolvePlatformImageUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFetchRemoteImageBytes.mockResolvedValue({
      bytes: new Uint8Array(100),
      finalUrl: 'https://cdn.example.com/photo.webp',
    })
  })

  it('passes through unchanged when preflight is disabled', async () => {
    const options = makeOptions({ preflight: false })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: makePayload(),
      platform: 'instagram',
    })
    expect(result).toEqual({
      converted: false,
      format: 'webp',
      url: 'https://cdn.example.com/photo.webp',
    })
  })

  it('passes through when the format is allowed for the platform', async () => {
    const options = makeOptions()
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'jpeg',
      imageUrl: 'https://cdn.example.com/photo.jpg',
      options,
      payload: makePayload(),
      platform: 'instagram',
    })
    expect(result).toEqual({
      converted: false,
      format: 'jpeg',
      url: 'https://cdn.example.com/photo.jpg',
    })
  })

  it('rejects an image whose format cannot be identified', async () => {
    mockedDetect.mockResolvedValue(undefined)
    const options = makeOptions()
    await expect(
      resolvePlatformImageUrl({
        imageUrl: 'https://cdn.example.com/unknown',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow('could not be identified')
  })

  it('detects format via magic bytes when declaredFormat is not provided', async () => {
    mockedDetect.mockResolvedValue('png')
    const options = makeOptions()
    // PNG is not allowed on Instagram
    await expect(
      resolvePlatformImageUrl({
        imageUrl: 'https://cdn.example.com/photo.png',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/does not accept png/)
  })

  it('throws actionable error when format is disallowed and autoConvert is off', async () => {
    const options = makeOptions()
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'webp',
        imageUrl: 'https://cdn.example.com/photo.webp',
        options,
        payload: makePayload(),
        platform: 'instagram',
      }),
    ).rejects.toThrow(/instagram does not accept webp/)
  })

  it('transcodes and uploads when autoConvert is enabled', async () => {
    const payload = makePayload()
    const options = makeOptions({
      autoConvert: true,
      renditionCollection: 'media',
    })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(true)
    expect(result.format).toBe('jpeg')
    expect(result.url).toBe('https://app.example.com/media/socials-rendition-abc12345.jpg')
    expect(payload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'media',
        file: expect.objectContaining({
          name: expect.stringMatching(/^socials-rendition-[a-f0-9]{32}\.jpg$/),
          mimetype: 'image/jpeg',
        }),
        overrideAccess: true,
      }),
    )
  })

  it('reuses an existing rendition instead of re-uploading', async () => {
    const payload = makePayload([{ url: '/media/socials-rendition-existing.jpg' }])
    const options = makeOptions({
      autoConvert: true,
      renditionCollection: 'media',
    })
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(true)
    expect(result.url).toBe('https://app.example.com/media/socials-rendition-existing.jpg')
    // Should NOT have called create since the rendition already exists
    expect(payload.create).not.toHaveBeenCalled()
  })

  it('allows webp for Pinterest (it is in the allowlist)', async () => {
    const options = makeOptions()
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/photo.webp',
      options,
      payload: makePayload(),
      platform: 'pinterest',
    })
    expect(result).toEqual({
      converted: false,
      format: 'webp',
      url: 'https://cdn.example.com/photo.webp',
    })
  })

  it('rejects avif for Pinterest', async () => {
    const options = makeOptions()
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'avif',
        imageUrl: 'https://cdn.example.com/photo.avif',
        options,
        payload: makePayload(),
        platform: 'pinterest',
      }),
    ).rejects.toThrow(/pinterest does not accept avif/)
  })
})
