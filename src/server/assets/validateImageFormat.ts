import type { NormalizedPluginOptions, PlatformId, SocialImageFormat } from '../../types/index.js'

import { PLATFORM_IMAGE_CONSTRAINTS } from './imagePreflight.js'

export const getImageFormatValidationIssue = (
  format: SocialImageFormat | undefined,
  options: NormalizedPluginOptions,
  platform: PlatformId,
  platformLabel: string,
): string | undefined => {
  if (!format || !options.assets.preflight || options.assets.autoConvert) {
    return undefined
  }
  const allowed = PLATFORM_IMAGE_CONSTRAINTS[platform].formats as readonly string[]
  if (allowed.includes(format)) {
    return undefined
  }
  return (
    `Image format "${format}" is not accepted by ${platformLabel} ` +
    `(allowed: ${allowed.join(', ')}). Configure a JPEG imageSize on your upload ` +
    'collection or enable assets.autoConvert.'
  )
}
