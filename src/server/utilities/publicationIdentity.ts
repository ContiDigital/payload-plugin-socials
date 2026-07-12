import type { PlatformId, SocialSourceContext } from '../../types/index.js'

import { ValidationError } from './errors.js'
import { sha256Hex } from './hash.js'

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

export const buildPublicationIdentity = (args: {
  ctx?: SocialSourceContext
  input: Record<string, unknown>
  platform: PlatformId
  sourceId: string
  sourceKind: string
}): { destinationId: string; idempotencyKey: string; primaryAssetUrl: string } => {
  const { ctx, input, platform, sourceId, sourceKind } = args
  switch (platform) {
    case 'facebook': {
      const pageId = asString(input.pageId)
      const format = asString(input.format, 'LINK')
      const primary =
        format === 'PHOTO'
          ? asString(input.imageUrl)
          : format === 'PHOTO_MULTI'
            ? Array.isArray(input.imageUrls)
              ? asString(input.imageUrls[0])
              : ''
            : format === 'VIDEO'
              ? asString(input.videoUrl)
              : asString(input.link)
      return {
        destinationId: pageId,
        idempotencyKey: sha256Hex(
          `facebook:${sourceKind}:${sourceId}:${pageId}:${format}:${primary}`,
        ),
        primaryAssetUrl: primary,
      }
    }
    case 'gbp': {
      const location = asString(input.locationResourceName)
      const topic = asString(input.topicType, 'STANDARD')
      const match = location.match(/^accounts\/([^/]+)\/locations\/([^/]+)$/)
      const accountId = match?.[1] ?? ''
      const locationId = match?.[2] ?? ''
      return {
        destinationId: location,
        idempotencyKey: sha256Hex(
          `gbp:${sourceKind}:${sourceId}:${accountId}:${locationId}:${topic}`,
        ),
        primaryAssetUrl: asString(input.imageUrl),
      }
    }
    case 'instagram': {
      const igUserId = asString(input.igUserId)
      const mediaType = asString(input.mediaType, 'IMAGE')
      const firstChild = Array.isArray(input.carouselChildren)
        ? (input.carouselChildren[0] as Record<string, unknown> | undefined)
        : undefined
      const carouselFirst = asString(firstChild?.imageUrl ?? firstChild?.videoUrl)
      const primary = asString(input.videoUrl ?? input.imageUrl) || carouselFirst
      return {
        destinationId: igUserId,
        idempotencyKey: sha256Hex(
          `instagram:${sourceKind}:${sourceId}:${igUserId}:${mediaType}:${primary}`,
        ),
        primaryAssetUrl: primary,
      }
    }
    case 'pinterest': {
      const boardId = asString(input.boardId)
      const defaultImage = ctx?.images.find((image) => image.role === 'main') ?? ctx?.images[0]
      const imageUrl = asString(input.imageUrl).trim() || defaultImage?.url || ''
      const mediaType = asString(input.mediaType, 'IMAGE')
      const videoUrl = asString(input.videoUrl).trim() || ctx?.videos?.[0]?.url || ''
      const primary =
        mediaType === 'VIDEO' ? videoUrl || asString(input.mediaId).trim() || '' : imageUrl
      return {
        destinationId: boardId,
        idempotencyKey: sha256Hex(`pinterest:${sourceKind}:${sourceId}:${boardId}:${primary}`),
        primaryAssetUrl: primary,
      }
    }
    default: {
      const _exhaustive: never = platform
      throw new ValidationError(`unsupported platform: ${String(_exhaustive)}`)
    }
  }
}
