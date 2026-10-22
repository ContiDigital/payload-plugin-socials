import type { Payload } from 'payload'

import type {
  NormalizedAssetsConfig,
  NormalizedPluginOptions,
  PlatformId,
  SocialImageFormat,
} from '../../types/index.js'

import {
  MAX_NORMALIZED_IMAGE_PIXELS,
  NORMALIZED_PHOTO_CANVAS,
  NORMALIZED_RENDITION_VERSION,
  NORMALIZED_SQUARE_CANVAS,
  NORMALIZED_STORY_CANVAS,
  PLUGIN_SLUG,
} from '../../constants.js'
import { createConcurrencyLimiter } from '../utilities/concurrency.js'
import { ValidationError } from '../utilities/errors.js'
import { sha256Hex } from '../utilities/hash.js'
import { detectImageFormat } from './detectImageFormat.js'
import { PLATFORM_IMAGE_CONSTRAINTS } from './imagePreflight.js'
import { fetchRemoteImageBytes } from './safeRemoteImage.js'

/** How the platform will present the image; stories use a vertical canvas. */
export type ImagePresentation = 'story'

export type ResolvePlatformImageArgs = {
  declaredFormat?: SocialImageFormat
  imageUrl: string
  options: NormalizedPluginOptions
  payload: Payload
  platform: PlatformId
  presentation?: ImagePresentation
}

export type ResolvePlatformImageResult = {
  converted: boolean
  format?: SocialImageFormat
  url: string
}

type RemotePolicy = { timeoutMs: number; trustedHosts: readonly string[] }

export const resolvePlatformImageUrl = async (
  args: ResolvePlatformImageArgs,
): Promise<ResolvePlatformImageResult> => {
  const { declaredFormat, imageUrl, options, platform } = args
  const assets: NormalizedAssetsConfig = options.assets

  if (!assets.preflight) {
    return { converted: false, format: declaredFormat, url: imageUrl }
  }

  const remotePolicy: RemotePolicy = {
    timeoutMs: assets.remoteFetchTimeoutMs,
    trustedHosts: assets.trustedRemoteHosts,
  }
  const format: SocialImageFormat | undefined =
    declaredFormat ?? (await detectImageFormat(imageUrl, remotePolicy))

  if (!format) {
    throw new ValidationError('Remote image format could not be identified from its file signature')
  }

  const constraints = PLATFORM_IMAGE_CONSTRAINTS[platform]
  const allowed = constraints.formats as readonly string[]

  if (allowed.includes(format) && !assets.normalize) {
    return { converted: false, format, url: imageUrl }
  }

  if (assets.autoConvert) {
    if (!assets.renditionCollection) {
      throw new ValidationError(
        `${PLUGIN_SLUG}: assets.autoConvert requires assets.renditionCollection to be set`,
      )
    }
    return conversionSlot(assets.maxConcurrentConversions)(() =>
      convertToRendition(args, assets.renditionCollection as string, remotePolicy),
    )
  }

  throw new ValidationError(
    `${platform} does not accept ${format} images (allowed: ${allowed.join(', ')}). ` +
      `To fix this, either configure a JPEG imageSize with formatOptions on your upload collection, ` +
      `or enable assets.autoConvert with a renditionCollection in your plugin config.`,
  )
}

// Conversions decode full-size originals, so they share one process-wide
// limiter: carousel and multi-photo publishers resolve their images in parallel.
let limiter: { bound: number; run: ReturnType<typeof createConcurrencyLimiter> } | undefined

const conversionSlot = (bound: number): ReturnType<typeof createConcurrencyLimiter> => {
  if (!limiter || limiter.bound !== bound) {
    limiter = { bound, run: createConcurrencyLimiter(bound) }
  }
  return limiter.run
}

const convertToRendition = async (
  args: ResolvePlatformImageArgs,
  renditionCollection: string,
  remotePolicy: RemotePolicy,
): Promise<ResolvePlatformImageResult> => {
  const { imageUrl, options, payload, platform, presentation } = args
  const assets = options.assets

  const filename = assets.normalize
    ? buildNormalizedRenditionFilename(imageUrl, platform, assets.jpegQuality, presentation)
    : buildRenditionFilename(imageUrl)
  const existing = await findExistingRendition(payload, renditionCollection, filename)
  if (existing) {
    return { converted: true, format: 'jpeg', url: absolutizeUrl(existing, payload) }
  }

  const sourceBytes = await fetchSourceBytes(imageUrl, remotePolicy, assets.maxSourceImageBytes)
  const jpegBuffer = assets.normalize
    ? await normalizeToJpeg(sourceBytes, assets.jpegQuality, platform, presentation)
    : await transcodeToJpeg(sourceBytes, assets.jpegQuality)

  const created = (await payload.create({
    collection: renditionCollection as never,
    data: { ...assets.renditionData } as never,
    file: {
      name: filename,
      data: jpegBuffer,
      mimetype: 'image/jpeg',
      size: jpegBuffer.length,
    },
    overrideAccess: true,
  })) as unknown as { url?: string }

  return { converted: true, format: 'jpeg', url: absolutizeUrl(created.url, payload) }
}

const buildRenditionFilename = (sourceUrl: string): string => {
  const hash = sha256Hex(sourceUrl).slice(0, 32)
  return `socials-rendition-${hash}.jpg`
}

// Normalized renditions differ per platform canvas, presentation and quality,
// so each combination gets its own deterministic name.
const buildNormalizedRenditionFilename = (
  sourceUrl: string,
  platform: PlatformId,
  quality: number,
  presentation: ImagePresentation | undefined,
): string => {
  const hash = sha256Hex(
    JSON.stringify([NORMALIZED_RENDITION_VERSION, sourceUrl, platform, quality, presentation]),
  ).slice(0, 32)
  return `socials-rendition-${hash}.jpg`
}

const findExistingRendition = async (
  payload: Payload,
  collection: string,
  filename: string,
): Promise<string | undefined> => {
  try {
    const result = await payload.find({
      collection: collection as never,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { filename: { equals: filename } },
    })
    const doc = result.docs[0] as { url?: string } | undefined
    return doc?.url ?? undefined
  } catch {
    return undefined
  }
}

const absolutizeUrl = (url: string | undefined, payload: Payload): string => {
  if (!url) {
    return ''
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  const serverURL = (payload.config?.serverURL ?? '').replace(/\/$/, '')
  return `${serverURL}${url.startsWith('/') ? '' : '/'}${url}`
}

const fetchSourceBytes = async (
  url: string,
  policy: RemotePolicy,
  maxBytes: number,
): Promise<Buffer> => {
  const result = await fetchRemoteImageBytes({ maxBytes, policy, url })
  if (result.contentType && !result.contentType.startsWith('image/')) {
    throw new ValidationError(
      `Remote image returned unsupported content type "${result.contentType}"`,
    )
  }
  return Buffer.from(result.bytes)
}

type SharpPipeline = {
  flatten: (opts: { background: string }) => SharpPipeline
  jpeg: (opts?: { chromaSubsampling?: string; quality?: number }) => SharpPipeline
  resize: (opts: {
    background?: string
    fit: 'contain' | 'inside'
    height: number
    width: number
    withoutEnlargement?: boolean
  }) => SharpPipeline
  rotate: () => SharpPipeline
  toBuffer: () => Promise<Buffer>
  toColourspace: (space: string) => SharpPipeline
}

type SharpFactory = (
  input: Buffer,
  opts?: { limitInputPixels?: number; pages?: number },
) => SharpPipeline

const loadSharp = async (): Promise<SharpFactory> => {
  try {
    const sharpModule = (await import('sharp')) as unknown as { default: SharpFactory }
    return sharpModule.default
  } catch {
    throw new ValidationError(
      `${PLUGIN_SLUG}: assets.autoConvert requires sharp as a peer dependency. ` +
        `Install it with: pnpm add sharp`,
    )
  }
}

const transcodeToJpeg = async (input: Buffer, quality: number): Promise<Buffer> => {
  const sharp = await loadSharp()
  return sharp(input).jpeg({ quality }).toBuffer()
}

export type NormalizedCanvas = {
  fit: 'contain' | 'inside'
  height: number
  width: number
  withoutEnlargement: boolean
}

/**
 * The canvas a normalized rendition is fitted onto. Nothing is ever cropped:
 * Facebook keeps the photograph's own proportions within the photo canvas,
 * stories use the vertical canvas, and everything else is padded onto a
 * square so a set of mixed-ratio images publishes intact.
 */
export const resolveNormalizedCanvas = (
  platform: PlatformId,
  presentation: ImagePresentation | undefined,
): NormalizedCanvas => {
  if (platform === 'facebook') {
    return {
      fit: 'inside',
      height: NORMALIZED_PHOTO_CANVAS,
      width: NORMALIZED_PHOTO_CANVAS,
      withoutEnlargement: true,
    }
  }
  if (presentation === 'story') {
    return { fit: 'contain', withoutEnlargement: false, ...NORMALIZED_STORY_CANVAS }
  }
  return {
    fit: 'contain',
    height: NORMALIZED_SQUARE_CANVAS,
    width: NORMALIZED_SQUARE_CANVAS,
    withoutEnlargement: false,
  }
}

const normalizeToJpeg = async (
  input: Buffer,
  quality: number,
  platform: PlatformId,
  presentation: ImagePresentation | undefined,
): Promise<Buffer> => {
  const sharp = await loadSharp()
  const canvas = resolveNormalizedCanvas(platform, presentation)
  let output: Buffer
  try {
    output = await sharp(input, { limitInputPixels: MAX_NORMALIZED_IMAGE_PIXELS, pages: 1 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .resize({ background: '#ffffff', ...canvas })
      .jpeg({ chromaSubsampling: '4:4:4', quality })
      .toBuffer()
  } catch {
    const megapixels = Math.round(MAX_NORMALIZED_IMAGE_PIXELS / 1_000_000)
    throw new ValidationError(
      `This image could not be prepared for publishing. Choose a valid image under ${megapixels} megapixels.`,
    )
  }
  const maxBytes = PLATFORM_IMAGE_CONSTRAINTS[platform].maxBytes
  if (maxBytes !== undefined && output.length > maxBytes) {
    throw new ValidationError(
      'The prepared image exceeds the platform file-size limit. Choose a smaller image.',
    )
  }
  return output
}
