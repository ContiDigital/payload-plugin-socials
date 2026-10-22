import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { sha256Hex } from '../../utilities/hash.js'
import { resolvePlatformImageUrl } from '../resolvePlatformImage.js'
import { fetchRemoteImageBytes } from '../safeRemoteImage.js'

vi.mock('../detectImageFormat.js', () => ({
  detectImageFormat: vi.fn().mockResolvedValue('jpeg'),
}))
vi.mock('../safeRemoteImage.js', () => ({
  fetchRemoteImageBytes: vi.fn(),
}))

const { calls, outputBytes } = vi.hoisted(() => ({
  calls: [] as Array<{ args: unknown[]; name: string }>,
  outputBytes: { length: 1024 },
}))

// Chainable sharp stand-in that records each pipeline step.
vi.mock('sharp', () => {
  const chain = {
    flatten: (...args: unknown[]) => record('flatten', args),
    jpeg: (...args: unknown[]) => record('jpeg', args),
    resize: (...args: unknown[]) => record('resize', args),
    rotate: (...args: unknown[]) => record('rotate', args),
    toBuffer: () => Promise.resolve(Buffer.alloc(outputBytes.length)),
    toColourspace: (...args: unknown[]) => record('toColourspace', args),
  }
  const record = (name: string, args: unknown[]) => {
    calls.push({ name, args })
    return chain
  }
  return { default: (...args: unknown[]) => record('sharp', args) }
})

const sourceUrl = 'https://cdn.example.com/original.webp'

const makeOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: {
      autoConvert: true,
      jpegQuality: 88,
      maxConcurrentConversions: 1,
      maxSourceImageBytes: 25 * 1024 * 1024,
      normalize: false,
      preflight: true,
      remoteFetchTimeoutMs: 15_000,
      renditionCollection: 'media',
      renditionData: {},
      trustedRemoteHosts: [],
      ...overrides,
    },
  }) as unknown as NormalizedPluginOptions

const create = vi.fn()
const payload = {
  config: { serverURL: 'https://app.example.com' },
  create,
  find: vi.fn().mockResolvedValue({ docs: [] }),
} as unknown as Parameters<typeof resolvePlatformImageUrl>[0]['payload']

beforeEach(() => {
  calls.length = 0
  outputBytes.length = 1024
  create.mockReset()
  create.mockResolvedValue({ url: '/api/media/file/out.jpg' })
  vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
    bytes: new Uint8Array(10),
    finalUrl: sourceUrl,
  })
})

describe('resolvePlatformImageUrl normalization branches', () => {
  it('keeps the legacy rendition name and plain transcode when normalize is off', async () => {
    await resolvePlatformImageUrl({
      declaredFormat: 'webp',
      imageUrl: sourceUrl,
      options: makeOptions(),
      payload,
      platform: 'instagram',
    })

    expect(calls.map((call) => call.name)).toEqual(['sharp', 'jpeg'])
    expect(create.mock.calls[0][0].file.name).toBe(
      `socials-rendition-${sha256Hex(sourceUrl).slice(0, 32)}.jpg`,
    )
    expect(create.mock.calls[0][0].data).toEqual({})
  })

  it('runs the full normalization pipeline with a per-platform canvas', async () => {
    await resolvePlatformImageUrl({
      declaredFormat: 'jpeg',
      imageUrl: sourceUrl,
      options: makeOptions({ normalize: true }),
      payload,
      platform: 'facebook',
    })

    expect(calls.map((call) => call.name)).toEqual([
      'sharp',
      'rotate',
      'flatten',
      'toColourspace',
      'resize',
      'jpeg',
    ])
    expect(calls[0].args[1]).toMatchObject({ pages: 1 })
    expect(calls.find((call) => call.name === 'resize')?.args[0]).toEqual({
      background: '#ffffff',
      fit: 'inside',
      height: 2048,
      width: 2048,
      withoutEnlargement: true,
    })
    expect(calls.find((call) => call.name === 'jpeg')?.args[0]).toEqual({
      chromaSubsampling: '4:4:4',
      quality: 88,
    })
  })

  it.each([
    ['instagram', undefined, { height: 1080, width: 1080 }],
    ['instagram', 'story', { height: 1920, width: 1080 }],
    ['pinterest', undefined, { height: 1080, width: 1080 }],
    ['gbp', undefined, { height: 1080, width: 1080 }],
  ] as const)('fits %s (%s) onto a padded canvas', async (platform, presentation, canvas) => {
    await resolvePlatformImageUrl({
      declaredFormat: 'jpeg',
      imageUrl: sourceUrl,
      options: makeOptions({ normalize: true }),
      payload,
      platform,
      presentation,
    })
    expect(calls.find((call) => call.name === 'resize')?.args[0]).toMatchObject({
      ...canvas,
      fit: 'contain',
    })
  })

  it('rejects a rendition that exceeds the platform byte limit', async () => {
    outputBytes.length = 8 * 1024 * 1024 + 1

    await expect(
      resolvePlatformImageUrl({
        declaredFormat: 'jpeg',
        imageUrl: sourceUrl,
        options: makeOptions({ normalize: true }),
        payload,
        platform: 'instagram',
      }),
    ).rejects.toThrow('exceeds the platform file-size limit')
    expect(create).not.toHaveBeenCalled()
  })

  it('writes the configured rendition data on the created document', async () => {
    await resolvePlatformImageUrl({
      declaredFormat: 'jpeg',
      imageUrl: sourceUrl,
      options: makeOptions({ normalize: true, renditionData: { alt: 'Prepared', tag: 'social' } }),
      payload,
      platform: 'facebook',
    })
    expect(create.mock.calls[0][0].data).toEqual({ alt: 'Prepared', tag: 'social' })
  })
})
