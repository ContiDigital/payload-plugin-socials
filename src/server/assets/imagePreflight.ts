import type { PlatformId } from '../../types/index.js'

import { PINTEREST_MIN_IMAGE_WIDTH } from '../../constants.js'

/**
 * Per-platform image preflight + crop-target resolution.
 *
 * Pure logic over image metadata (dimensions, format, byte size). It does not
 * touch sharp or any binary — `transformImage.ts` executes the resolved spec.
 * Constraints are sourced from each platform's published media requirements:
 *
 *   Pinterest : >= 600px wide, 2:3 preferred, <= 20MB, jpeg/png/webp
 *   Instagram : jpeg only, 320-1440px wide, 4:5 to 1.91:1, <= 8MB
 *   Facebook  : jpeg/png/gif/bmp/tiff, <= 10MB
 *   GBP       : jpg/png, >= 250x250, 10KB-5MB, 4:3 preferred
 */

export type ImageFormat = 'bmp' | 'gif' | 'jpeg' | 'png' | 'tiff' | 'webp'

export type ImageConstraints = {
  readonly formats: readonly ImageFormat[]
  readonly maxAspect?: number
  readonly maxBytes?: number
  readonly maxWidth?: number
  readonly minAspect?: number
  readonly minBytes?: number
  readonly minHeight?: number
  readonly minWidth: number
  /** Recommended crop target (aspect = width / height). */
  readonly recommended: { aspectRatio: number; height: number; width: number }
}

const MB = 1024 * 1024
const KB = 1024

export const PLATFORM_IMAGE_CONSTRAINTS: Record<PlatformId, ImageConstraints> = {
  facebook: {
    formats: ['jpeg', 'png', 'gif', 'bmp', 'tiff'],
    maxBytes: 10 * MB,
    minWidth: 200,
    recommended: { aspectRatio: 1, height: 1200, width: 1200 },
  },
  gbp: {
    formats: ['jpeg', 'png'],
    maxAspect: 2,
    maxBytes: 5 * MB,
    minAspect: 0.5,
    minBytes: 10 * KB,
    minHeight: 250,
    minWidth: 250,
    recommended: { aspectRatio: 4 / 3, height: 900, width: 1200 },
  },
  instagram: {
    formats: ['jpeg'],
    maxAspect: 1.91,
    maxBytes: 8 * MB,
    maxWidth: 1440,
    minAspect: 0.8,
    minWidth: 320,
    recommended: { aspectRatio: 4 / 5, height: 1350, width: 1080 },
  },
  pinterest: {
    formats: ['jpeg', 'png', 'webp'],
    maxAspect: 1,
    maxBytes: 20 * MB,
    minAspect: 0.5,
    minWidth: PINTEREST_MIN_IMAGE_WIDTH,
    recommended: { aspectRatio: 2 / 3, height: 1500, width: 1000 },
  },
}

export type ImageMeta = {
  bytes?: number
  format?: string
  height: number
  width: number
}

export type PreflightIssue = {
  message: string
  severity: 'error' | 'warning'
}

export type PreflightResult = {
  aspectRatio: number
  issues: PreflightIssue[]
  ok: boolean
}

const normalizeFormat = (format: string | undefined): string | undefined => {
  if (!format) {
    return undefined
  }
  const lower = format
    .trim()
    .toLowerCase()
    .replace(/^image\//, '')
  return lower === 'jpg' ? 'jpeg' : lower
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Validate an image against a platform's constraints. Errors block a publish;
 * warnings flag something the asset pipeline will fix (downscale or crop).
 */
export const preflightImage = (platform: PlatformId, meta: ImageMeta): PreflightResult => {
  const c = PLATFORM_IMAGE_CONSTRAINTS[platform]
  const issues: PreflightIssue[] = []
  const aspect = meta.height > 0 ? round2(meta.width / meta.height) : 0

  const format = normalizeFormat(meta.format)
  if (format && !(c.formats as readonly string[]).includes(format)) {
    issues.push({
      message: `${platform} does not accept ${format} (allowed: ${c.formats.join(', ')})`,
      severity: 'error',
    })
  }
  if (meta.width < c.minWidth) {
    issues.push({
      message: `Image is ${meta.width}px wide; ${platform} requires at least ${c.minWidth}px`,
      severity: 'error',
    })
  }
  if (c.minHeight !== undefined && meta.height < c.minHeight) {
    issues.push({
      message: `Image is ${meta.height}px tall; ${platform} requires at least ${c.minHeight}px`,
      severity: 'error',
    })
  }
  if (c.maxWidth !== undefined && meta.width > c.maxWidth) {
    issues.push({
      message: `Image is wider than ${platform}'s ${c.maxWidth}px max and will be downscaled`,
      severity: 'warning',
    })
  }
  if (c.maxBytes !== undefined && meta.bytes !== undefined && meta.bytes > c.maxBytes) {
    issues.push({
      message: `Image is ${Math.round(meta.bytes / MB)}MB; ${platform} max is ${Math.round(c.maxBytes / MB)}MB`,
      severity: 'error',
    })
  }
  if (c.minBytes !== undefined && meta.bytes !== undefined && meta.bytes < c.minBytes) {
    issues.push({
      message: `Image is under ${platform}'s ${Math.round(c.minBytes / KB)}KB minimum`,
      severity: 'error',
    })
  }
  if (aspect > 0 && c.minAspect !== undefined && aspect < c.minAspect) {
    issues.push({
      message: `Image is taller than ${platform} prefers and will be cropped`,
      severity: 'warning',
    })
  }
  if (aspect > 0 && c.maxAspect !== undefined && aspect > c.maxAspect) {
    issues.push({
      message: `Image is wider than ${platform} prefers and will be cropped`,
      severity: 'warning',
    })
  }

  return {
    aspectRatio: aspect,
    issues,
    ok: issues.every((i) => i.severity !== 'error'),
  }
}

export type TargetDimensions = {
  fit: 'cover' | 'inside'
  height: number
  width: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/**
 * Resolve the dimensions an image should be resized to for a platform. Clamps
 * the width into the platform's [minWidth, maxWidth] band and, when the source
 * aspect falls outside the platform's accepted band, snaps to the nearest edge
 * and signals a `cover` (crop-to-fill) resize. Otherwise it is an `inside`
 * (no-crop) downscale.
 */
export const resolveTargetDimensions = (
  platform: PlatformId,
  source: { height: number; width: number },
): TargetDimensions => {
  const c = PLATFORM_IMAGE_CONSTRAINTS[platform]
  const sourceAspect = source.height > 0 ? source.width / source.height : c.recommended.aspectRatio

  const targetAspect = clamp(sourceAspect, c.minAspect ?? sourceAspect, c.maxAspect ?? sourceAspect)
  const cropNeeded = Math.abs(targetAspect - sourceAspect) > 0.001

  const maxBound = c.maxWidth ?? Number.MAX_SAFE_INTEGER
  const width = Math.round(clamp(source.width, c.minWidth, maxBound))
  const height = Math.round(width / targetAspect)

  return { fit: cropNeeded ? 'cover' : 'inside', height, width }
}
