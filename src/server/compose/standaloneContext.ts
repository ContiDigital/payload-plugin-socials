import type {
  SocialImage,
  SocialImageFormat,
  SocialSourceContext,
  SocialVideo,
} from '../../types/index.js'

import { STANDALONE_SOURCE_KIND } from '../../constants.js'
import { sha256Hex } from '../utilities/hash.js'

/**
 * Build a `SocialSourceContext` for a standalone composer post — content typed
 * directly into the composer rather than transposed from a host source record.
 *
 * The `sourceKind` is the reserved `standalone` value and `sourceId` is a
 * stable content hash, so the per-adapter idempotency keys still behave: the
 * same content published to the same destination dedupes, different content
 * produces a distinct `social-posts` row.
 */

export type StandaloneComposeInput = {
  body?: string
  hints?: SocialSourceContext['hints']
  images?: Array<{
    format?: SocialImageFormat
    height?: number
    role?: string
    url: string
    width?: number
  }>
  imageUrl?: string
  link?: string
  metadata?: Record<string, unknown>
  modelLabel?: string
  title: string
  videos?: SocialVideo[]
}

const normalizeImages = (input: StandaloneComposeInput): SocialImage[] => {
  if (input.images && input.images.length > 0) {
    return input.images
      .filter((img) => typeof img.url === 'string' && img.url.length > 0)
      .map((img) => ({
        format: img.format,
        height: img.height,
        role: img.role ?? 'main',
        url: img.url,
        width: img.width,
      }))
  }
  if (input.imageUrl) {
    return [{ role: 'main', url: input.imageUrl }]
  }
  return []
}

export const buildStandaloneContext = (input: StandaloneComposeInput): SocialSourceContext => {
  const images = normalizeImages(input)
  const sourceId = sha256Hex(
    JSON.stringify({
      body: input.body ?? '',
      primaryImage: images[0]?.url ?? '',
      title: input.title,
    }),
  )
  return {
    baseDescription: input.body ?? '',
    baseTitle: input.title,
    hints: input.hints,
    images,
    link: input.link ?? '',
    metadata: input.metadata,
    modelLabel: input.modelLabel,
    sourceId,
    sourceKind: STANDALONE_SOURCE_KIND,
    videos: input.videos,
  }
}
