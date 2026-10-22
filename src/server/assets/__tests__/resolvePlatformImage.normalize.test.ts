import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, PlatformId } from '../../../types/index.js'
import type { ResolvePlatformImageArgs } from '../resolvePlatformImage.js'

import { MAX_NORMALIZED_IMAGE_PIXELS } from '../../../constants.js'
import { resolvePlatformImageUrl } from '../resolvePlatformImage.js'
import { fetchRemoteImageBytes } from '../safeRemoteImage.js'

// Real sharp encoding; only the network and format sniffing are mocked.
vi.mock('../detectImageFormat.js', () => ({
  detectImageFormat: vi.fn().mockResolvedValue('jpeg'),
}))
vi.mock('../safeRemoteImage.js', () => ({
  fetchRemoteImageBytes: vi.fn(),
}))

const sourceUrl = 'https://cdn.example.com/original.jpg'
const maxSourceImageBytes = 64 * 1024 * 1024

const makeOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: {
      autoConvert: true,
      jpegQuality: 88,
      maxConcurrentConversions: 1,
      maxSourceImageBytes,
      normalize: true,
      preflight: true,
      remoteFetchTimeoutMs: 15_000,
      renditionCollection: 'media',
      renditionData: { alt: 'Prepared for social publishing' },
      trustedRemoteHosts: [],
      ...overrides,
    },
  }) as unknown as NormalizedPluginOptions

const create = vi.fn()
const find = vi.fn()
const payload = {
  config: { serverURL: 'https://app.example.com' },
  create,
  find,
} as unknown as ResolvePlatformImageArgs['payload']

const prepare = (
  platform: PlatformId,
  extra: Partial<ResolvePlatformImageArgs> = {},
  options = makeOptions(),
) => resolvePlatformImageUrl({ imageUrl: sourceUrl, options, payload, platform, ...extra })

const image = (width: number, height: number) =>
  sharp({ create: { background: '#b02020', channels: 3, height, width } })
const supply = (bytes: Buffer) =>
  vi.mocked(fetchRemoteImageBytes).mockResolvedValue({ bytes, finalUrl: sourceUrl })
const output = () => create.mock.calls.at(-1)![0].file.data as Buffer

beforeEach(() => {
  find.mockResolvedValue({ docs: [] })
  create.mockImplementation(({ file }: { file?: { name: string } }) =>
    Promise.resolve(file ? { url: `/api/media/file/${file.name}` } : { id: 1 }),
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolvePlatformImageUrl with assets.normalize', () => {
  it('re-encodes an accepted JPEG into a bounded rendition instead of passing it through', async () => {
    supply(await image(7052, 5223).jpeg().toBuffer())

    const result = await prepare('facebook')

    expect(result).toMatchObject({ converted: true, format: 'jpeg' })
    expect(result.url).toMatch(/^https:\/\/app\.example\.com\/api\/media\/file\/socials-rendition-/)
    expect(await sharp(output()).metadata()).toMatchObject({
      format: 'jpeg',
      height: 1517,
      width: 2048,
    })
    expect(fetchRemoteImageBytes).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: maxSourceImageBytes }),
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'media',
        data: { alt: 'Prepared for social publishing' },
      }),
    )
  })

  it('does not enlarge a small photograph for Facebook', async () => {
    supply(await image(640, 480).jpeg().toBuffer())
    await prepare('facebook')
    expect(await sharp(output()).metadata()).toMatchObject({ height: 480, width: 640 })
  })

  it.each(['webp', 'png'] as const)(
    'pads a wide %s image onto a white square Instagram canvas without cropping',
    async (format) => {
      supply(await image(1600, 400).toFormat(format).toBuffer())

      const result = await prepare('instagram')

      expect(result.format).toBe('jpeg')
      expect(await sharp(output()).metadata()).toMatchObject({
        format: 'jpeg',
        height: 1080,
        space: 'srgb',
        width: 1080,
      })
      const { data, info } = await sharp(output()).raw().toBuffer({ resolveWithObject: true })
      const pixel = (x: number, y: number) => {
        const offset = (y * info.width + x) * info.channels
        return [...data.subarray(offset, offset + 3)]
      }
      expect(pixel(540, 10).every((channel) => channel > 245)).toBe(true)
      expect(pixel(10, 540)[0]).toBeGreaterThan(150)
      expect(pixel(1070, 540)[0]).toBeGreaterThan(150)
      expect(pixel(540, 540)[1]).toBeLessThan(60)
    },
  )

  it('uses the vertical story canvas for Instagram stories', async () => {
    supply(await image(1600, 400).png().toBuffer())
    await prepare('instagram', { presentation: 'story' })
    expect(await sharp(output()).metadata()).toMatchObject({ height: 1920, width: 1080 })
  })

  it('applies EXIF orientation before resizing and strips metadata', async () => {
    supply(await image(600, 1200).jpeg().withMetadata({ orientation: 6 }).toBuffer())

    await prepare('facebook')

    const meta = await sharp(output()).metadata()
    expect(meta).toMatchObject({ height: 600, width: 1200 })
    expect(meta.orientation).toBeUndefined()
  })

  it('keeps separate renditions per platform and presentation and reuses them on retry', async () => {
    supply(await image(800, 600).jpeg().toBuffer())

    await prepare('facebook')
    await prepare('instagram')
    await prepare('instagram', { presentation: 'story' })

    const names = create.mock.calls.map((call) => call[0].file.name as string)
    expect(new Set(names).size).toBe(3)
    for (const name of names) {
      expect(name).toMatch(/^socials-rendition-[a-f0-9]{32}\.jpg$/)
    }

    find.mockResolvedValue({ docs: [{ url: '/api/media/file/cached.jpg' }] })
    create.mockClear()
    vi.mocked(fetchRemoteImageBytes).mockClear()

    expect((await prepare('instagram')).url).toBe(
      'https://app.example.com/api/media/file/cached.jpg',
    )
    expect(create).not.toHaveBeenCalled()
    expect(fetchRemoteImageBytes).not.toHaveBeenCalled()
  })

  it('changes the rendition name when the JPEG quality changes', async () => {
    supply(await image(800, 600).jpeg().toBuffer())

    await prepare('facebook')
    await prepare('facebook', {}, makeOptions({ jpegQuality: 70 }))

    const [first, second] = create.mock.calls.map((call) => call[0].file.name as string)
    expect(first).not.toBe(second)
  })

  it('rejects malformed and oversized-pixel inputs before creating any media', async () => {
    supply(Buffer.from('not an image'))
    await expect(prepare('facebook')).rejects.toThrow('could not be prepared')

    supply(await image(8500, 8500).png().toBuffer())
    await expect(prepare('instagram')).rejects.toThrow(
      `${Math.round(MAX_NORMALIZED_IMAGE_PIXELS / 1_000_000)} megapixels`,
    )

    expect(create).not.toHaveBeenCalled()
  })

  it('runs conversions one at a time by default and continues after a corrupt input', async () => {
    const jpeg = await image(600, 400).jpeg().toBuffer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(fetchRemoteImageBytes)
      .mockImplementationOnce(async () => {
        await gate
        return { bytes: Buffer.from('corrupt'), finalUrl: sourceUrl }
      })
      .mockResolvedValue({ bytes: jpeg, finalUrl: sourceUrl })

    const first = prepare('facebook')
    const second = prepare('instagram', { imageUrl: 'https://cdn.example.com/second.jpg' })
    const both = Promise.allSettled([first, second])

    await vi.waitFor(() => expect(fetchRemoteImageBytes).toHaveBeenCalledTimes(1))
    expect(create).not.toHaveBeenCalled()
    release()

    const results = await both
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    expect(fetchRemoteImageBytes).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('leaves an accepted format untouched when normalize is off', async () => {
    supply(await image(800, 600).jpeg().toBuffer())

    const result = await prepare('facebook', {}, makeOptions({ normalize: false }))

    expect(result).toEqual({ converted: false, format: 'jpeg', url: sourceUrl })
    expect(fetchRemoteImageBytes).not.toHaveBeenCalled()
  })
})
