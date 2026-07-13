import type { Payload } from 'payload'

import type {
  NormalizedAssetsConfig,
  NormalizedPluginOptions,
  PlatformId,
  SocialImageFormat,
} from '../../types/index.js'

import { PLUGIN_SLUG } from '../../constants.js'
import { ValidationError } from '../utilities/errors.js'
import { sha256Hex } from '../utilities/hash.js'
import { detectImageFormat } from './detectImageFormat.js'
import { PLATFORM_IMAGE_CONSTRAINTS } from './imagePreflight.js'

const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export type ResolvePlatformImageArgs = {
  declaredFormat?: SocialImageFormat
  imageUrl: string
  options: NormalizedPluginOptions
  payload: Payload
  platform: PlatformId
}

export type ResolvePlatformImageResult = {
  converted: boolean
  format?: SocialImageFormat
  url: string
}

/**
 * Resolve the final image URL for a platform publish, applying format safety.
 *
 * Layers:
 *   1. If preflight is disabled, pass through unchanged.
 *   2. Detect format (from declared or via magic bytes).
 *   3. If the format is allowed for the platform, pass through.
 *   4. If autoConvert is enabled, transcode to JPEG via sharp and upload a
 *      rendition to the configured collection.
 *   5. Otherwise, throw an actionable ValidationError.
 */
export const resolvePlatformImageUrl = async (
  args: ResolvePlatformImageArgs,
): Promise<ResolvePlatformImageResult> => {
  const { declaredFormat, imageUrl, options, payload, platform } = args
  const assets: NormalizedAssetsConfig = options.assets

  // Layer 1: preflight disabled, pass through.
  if (!assets.preflight) {
    return { converted: false, format: declaredFormat, url: imageUrl }
  }

  // Layer 2: determine format.
  const format: SocialImageFormat | undefined =
    declaredFormat ?? (await detectImageFormat(imageUrl))

  if (!format) {
    // Unknown format: pass through with a debug note. We cannot block unknown
    // formats because some hosts use CDN URLs without file extensions and the
    // server may not support Range requests.
    return { converted: false, url: imageUrl }
  }

  // Layer 3: check allowlist.
  const constraints = PLATFORM_IMAGE_CONSTRAINTS[platform]
  const allowed = constraints.formats as readonly string[]

  if (allowed.includes(format)) {
    return { converted: false, format, url: imageUrl }
  }

  // Layer 4: autoConvert.
  if (assets.autoConvert) {
    if (!assets.renditionCollection) {
      throw new ValidationError(
        `${PLUGIN_SLUG}: assets.autoConvert requires assets.renditionCollection to be set`,
      )
    }

    // Check for existing rendition with the same deterministic filename.
    const filename = buildRenditionFilename(imageUrl)
    const existing = await findExistingRendition(payload, assets.renditionCollection, filename)
    if (existing) {
      const absoluteUrl = absolutizeUrl(existing, payload)
      return { converted: true, format: 'jpeg', url: absoluteUrl }
    }

    // Transcode.
    const sourceBytes = await fetchSourceBytes(imageUrl)
    const jpegBuffer = await transcodeToJpeg(sourceBytes, assets.jpegQuality)

    // Upload via Payload.
    const created = (await payload.create({
      collection: assets.renditionCollection as never,
      data: {} as never,
      file: {
        name: filename,
        data: jpegBuffer,
        mimetype: 'image/jpeg',
        size: jpegBuffer.length,
      },
      overrideAccess: true,
    })) as unknown as { url?: string }

    const renditionUrl = absolutizeUrl(created.url, payload)
    return { converted: true, format: 'jpeg', url: renditionUrl }
  }

  // Layer 5: throw actionable error.
  throw new ValidationError(
    `${platform} does not accept ${format} images (allowed: ${allowed.join(', ')}). ` +
      `To fix this, either configure a JPEG imageSize with formatOptions on your upload collection, ` +
      `or enable assets.autoConvert with a renditionCollection in your plugin config.`,
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const buildRenditionFilename = (sourceUrl: string): string => {
  const hash = sha256Hex(sourceUrl).slice(0, 8)
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

const fetchSourceBytes = async (url: string): Promise<Buffer> => {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new ValidationError(
      `Failed to fetch source image for transcoding: ${response.status} ${response.statusText}`,
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_SOURCE_BYTES) {
    throw new ValidationError(
      `Source image is too large for transcoding (${Math.round(contentLength / 1024 / 1024)}MB, max 25MB)`,
    )
  }
  const arrayBuf = await response.arrayBuffer()
  if (arrayBuf.byteLength > MAX_SOURCE_BYTES) {
    throw new ValidationError(
      `Source image is too large for transcoding (${Math.round(arrayBuf.byteLength / 1024 / 1024)}MB, max 25MB)`,
    )
  }
  return Buffer.from(arrayBuf)
}

const transcodeToJpeg = async (input: Buffer, quality: number): Promise<Buffer> => {
  let sharpModule: {
    default: (i: Buffer) => {
      jpeg: (opts?: { quality?: number }) => { toBuffer: () => Promise<Buffer> }
    }
  }
  try {
    sharpModule = (await import('sharp')) as never
  } catch {
    throw new ValidationError(
      `${PLUGIN_SLUG}: assets.autoConvert requires sharp as a peer dependency. ` +
        `Install it with: pnpm add sharp`,
    )
  }
  const sharp = sharpModule.default
  return sharp(input).jpeg({ quality }).toBuffer()
}
