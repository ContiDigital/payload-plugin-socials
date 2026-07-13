import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for resolvePlatformImageUrl.
 *
 * These tests exercise the helper directly (not through the adapter path) to:
 * - Document the helper's contract now that it is called from the publish body
 *   builder and NOT from the adapter.
 * - Maintain coverage of the helper even though the adapters no longer own
 *   the conversion step.
 */

// Mock IO dependencies before importing the module under test.
vi.mock('../transformImage.js', () => ({
  transformImage: vi.fn(),
}))

import { resolvePlatformImageUrl } from '../resolvePlatformImage.js'
import { transformImage } from '../transformImage.js'

const mockedTransformImage = vi.mocked(transformImage)

// Minimal mock for payload.create (the upload path).
const makePayload = (url = 'https://payload.example.com/media/converted.jpg'): Payload =>
  ({
    create: vi.fn().mockResolvedValue({ url }),
  }) as unknown as Payload

// A tiny valid JPEG buffer — just enough bytes for tests that need a buffer.
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9])

// Stub global fetch for the auto-convert path.
const stubFetch = (buffer: Buffer, status = 200) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      arrayBuffer: () =>
        Promise.resolve(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        ),
      ok: status >= 200 && status < 300,
      status,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('resolvePlatformImageUrl — preflight OFF (default)', () => {
  it('returns the original URL without any IO when preflight is false', async () => {
    const payload = makePayload()
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'png',
      imageUrl: 'https://cdn.example.com/img.png',
      options: { preflight: false },
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img.png')
    expect(mockedTransformImage).not.toHaveBeenCalled()
    expect(payload.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('returns the original URL without any IO when preflight is omitted', async () => {
    const payload = makePayload()
    const result = await resolvePlatformImageUrl({
      imageUrl: 'https://cdn.example.com/img.png',
      options: {},
      payload,
      platform: 'pinterest',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img.png')
    expect(mockedTransformImage).not.toHaveBeenCalled()
  })
})

describe('resolvePlatformImageUrl — preflight ON, allowed format', () => {
  it('passes through when the declared format is allowed by the platform', async () => {
    const payload = makePayload()
    // jpeg is allowed by instagram
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'jpeg',
      imageUrl: 'https://cdn.example.com/img.jpg',
      options: { preflight: true },
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img.jpg')
    expect(mockedTransformImage).not.toHaveBeenCalled()
  })

  it('normalizes "jpg" to "jpeg" and treats it as allowed', async () => {
    const payload = makePayload()
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'jpg',
      imageUrl: 'https://cdn.example.com/img.jpg',
      options: { preflight: true },
      payload,
      platform: 'facebook',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img.jpg')
  })

  it('normalizes "image/jpeg" mime type to "jpeg" and treats it as allowed', async () => {
    const payload = makePayload()
    const result = await resolvePlatformImageUrl({
      declaredFormat: 'image/jpeg',
      imageUrl: 'https://cdn.example.com/img.jpg',
      options: { preflight: true },
      payload,
      platform: 'pinterest',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img.jpg')
  })
})

describe('resolvePlatformImageUrl — preflight ON, unknown format', () => {
  it('passes through when declaredFormat is undefined (cannot determine without probing)', async () => {
    const payload = makePayload()
    const result = await resolvePlatformImageUrl({
      declaredFormat: undefined,
      imageUrl: 'https://cdn.example.com/img',
      options: { preflight: true },
      payload,
      platform: 'instagram',
    })
    expect(result.converted).toBe(false)
    expect(result.url).toBe('https://cdn.example.com/img')
    expect(mockedTransformImage).not.toHaveBeenCalled()
  })
})

describe('resolvePlatformImageUrl — preflight ON, disallowed format, autoConvert OFF', () => {
  it('throws a descriptive error when the format is disallowed and autoConvert is not enabled', async () => {
    const payload = makePayload()
    // png is NOT allowed by instagram
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'png',
        imageUrl: 'https://cdn.example.com/img.png',
        options: { autoConvert: false, preflight: true },
        payload,
        platform: 'instagram',
      }),
    ).rejects.toThrow(/not accepted by instagram/)
  })

  it('includes the platform-specific allowed formats in the error message', async () => {
    const payload = makePayload()
    // gif is not allowed by pinterest (which only accepts jpeg, png, webp)
    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'gif',
        imageUrl: 'https://cdn.example.com/img.gif',
        options: { preflight: true },
        payload,
        platform: 'pinterest',
      }),
    ).rejects.toThrow(/jpeg/)
  })
})

describe('resolvePlatformImageUrl — preflight ON, disallowed format, autoConvert ON', () => {
  it('fetches, converts, uploads and returns the new URL when autoConvert is enabled', async () => {
    const convertedBuffer = Buffer.from('fake-jpeg-bytes')
    const uploadedUrl = 'https://payload.example.com/media/img-instagram.jpg'
    const payload = makePayload(uploadedUrl)

    stubFetch(TINY_JPEG)
    mockedTransformImage.mockResolvedValue(convertedBuffer)

    const result = await resolvePlatformImageUrl({
      declaredFormat: 'png',
      imageUrl: 'https://cdn.example.com/img.png',
      options: { autoConvert: true, preflight: true },
      payload,
      platform: 'instagram',
    })

    expect(result.converted).toBe(true)
    expect(result.url).toBe(uploadedUrl)

    // transformImage must have been called to re-encode.
    expect(mockedTransformImage).toHaveBeenCalledOnce()
    const [inputBuf, spec] = mockedTransformImage.mock.calls[0]
    expect(Buffer.isBuffer(inputBuf)).toBe(true)
    // instagram's recommended format is jpeg
    expect(spec.format).toBe('jpeg')

    // payload.create must have been called to upload the converted rendition.
    const createCall = (payload.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.file).toBeDefined()
    expect(createCall.file.name).toMatch(/instagram/)
    expect(createCall.file.mimetype).toContain('jpeg')
  })

  it('uses the custom uploadCollection when provided', async () => {
    const payload = makePayload('https://payload.example.com/assets/img-pinterest.jpg')
    stubFetch(TINY_JPEG)
    mockedTransformImage.mockResolvedValue(Buffer.from('converted'))

    // gif is disallowed by pinterest (only jpeg, png, webp allowed)
    await resolvePlatformImageUrl({
      declaredFormat: 'gif',
      imageUrl: 'https://cdn.example.com/banner.gif',
      options: { autoConvert: true, preflight: true, uploadCollection: 'assets' },
      payload,
      platform: 'pinterest',
    })

    const createCall = (payload.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.collection).toBe('assets')
  })

  it('defaults uploadCollection to "media" when not specified', async () => {
    const payload = makePayload()
    stubFetch(TINY_JPEG)
    mockedTransformImage.mockResolvedValue(Buffer.from('converted'))

    // webp is not allowed by facebook (only jpeg, png, gif, bmp, tiff)
    await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/img.webp',
      options: { autoConvert: true, preflight: true },
      payload,
      platform: 'facebook',
    })

    const createCall = (payload.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.collection).toBe('media')
  })

  it('includes the platform name in the uploaded filename', async () => {
    const payload = makePayload()
    stubFetch(TINY_JPEG)
    mockedTransformImage.mockResolvedValue(Buffer.from('converted'))

    // webp is not allowed by facebook
    await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: 'https://cdn.example.com/product-shot.webp',
      options: { autoConvert: true, preflight: true },
      payload,
      platform: 'facebook',
    })

    const createCall = (payload.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(createCall.file.name).toContain('facebook')
    expect(createCall.file.name).toContain('product-shot')
  })

  it('throws when the fetch of the original image fails', async () => {
    const payload = makePayload()
    stubFetch(Buffer.alloc(0), 404)

    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'png',
        imageUrl: 'https://cdn.example.com/missing.png',
        options: { autoConvert: true, preflight: true },
        payload,
        platform: 'instagram',
      }),
    ).rejects.toThrow(/failed to fetch/)
  })

  it('throws when payload.create returns no url', async () => {
    const payload = makePayload(undefined as unknown as string)
    ;(payload.create as ReturnType<typeof vi.fn>).mockResolvedValue({})

    stubFetch(TINY_JPEG)
    mockedTransformImage.mockResolvedValue(Buffer.from('converted'))

    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'png',
        imageUrl: 'https://cdn.example.com/img.png',
        options: { autoConvert: true, preflight: true },
        payload,
        platform: 'instagram',
      }),
    ).rejects.toThrow(/returned no url/)
  })
})
