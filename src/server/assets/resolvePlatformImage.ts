import type { Payload } from 'payload'

import type {
  NormalizedAssetsConfig,
  NormalizedPluginOptions,
  PlatformId,
  SocialImageFormat,
} from '../../types/index.js'

import { MAX_SOURCE_IMAGE_BYTES, PLUGIN_SLUG } from '../../constants.js'
import { ValidationError } from '../utilities/errors.js'
import { sha256Hex } from '../utilities/hash.js'
import { detectImageFormat } from './detectImageFormat.js'
import { PLATFORM_IMAGE_CONSTRAINTS } from './imagePreflight.js'
import { fetchRemoteImageBytes } from './safeRemoteImage.js'

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

export const resolvePlatformImageUrl = async (
  args: ResolvePlatformImageArgs,
): Promise<ResolvePlatformImageResult> => {
  const { declaredFormat, imageUrl, options, payload, platform } = args
  const assets: NormalizedAssetsConfig = options.assets

  if (!assets.preflight) {
    return { converted: false, format: declaredFormat, url: imageUrl }
  }

  const remotePolicy = {
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

  if (allowed.includes(format)) {
    return { converted: false, format, url: imageUrl }
  }

  if (assets.autoConvert) {
    if (!assets.renditionCollection) {
      throw new ValidationError(
        `${PLUGIN_SLUG}: assets.autoConvert requires assets.renditionCollection to be set`,
      )
    }

    const filename = buildRenditionFilename(imageUrl)
    const existing = await findExistingRendition(payload, assets.renditionCollection, filename)
    if (existing) {
      const absoluteUrl = absolutizeUrl(existing, payload)
      return { converted: true, format: 'jpeg', url: absoluteUrl }
    }

    const sourceBytes = await fetchSourceBytes(imageUrl, remotePolicy)
    const jpegBuffer = await transcodeToJpeg(sourceBytes, assets.jpegQuality)

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

  throw new ValidationError(
    `${platform} does not accept ${format} images (allowed: ${allowed.join(', ')}). ` +
      `To fix this, either configure a JPEG imageSize with formatOptions on your upload collection, ` +
      `or enable assets.autoConvert with a renditionCollection in your plugin config.`,
  )
}

const buildRenditionFilename = (sourceUrl: string): string => {
  const hash = sha256Hex(sourceUrl).slice(0, 32)
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
  policy: { timeoutMs: number; trustedHosts: readonly string[] },
): Promise<Buffer> => {
  const result = await fetchRemoteImageBytes({
    maxBytes: MAX_SOURCE_IMAGE_BYTES,
    policy,
    url,
  })
  if (result.contentType && !result.contentType.startsWith('image/')) {
    throw new ValidationError(
      `Remote image returned unsupported content type "${result.contentType}"`,
    )
  }
  return Buffer.from(result.bytes)
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
