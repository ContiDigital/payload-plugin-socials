import type { PlatformId, SocialSourceContext } from '../../types/index.js'

import { ValidationError } from './errors.js'
import { sha256Hex } from './hash.js'

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

export const resolvePublicationIdempotencyKey = (args: {
  defaultValue: string
  input: Record<string, unknown>
  platform: PlatformId
}): string => {
  const override = asString(args.input.idempotencyKeyOverride).trim().toLowerCase()
  if (override) {
    if (!/^[a-f0-9]{64}$/.test(override)) {
      throw new ValidationError('idempotencyKeyOverride must be a 64-character SHA-256 hex value')
    }
    return override
  }
  const publicationKey = asString(args.input.publicationKey).trim()
  if (publicationKey.length > 200) {
    throw new ValidationError('publicationKey must be 200 characters or fewer')
  }
  return sha256Hex(
    publicationKey ? `${args.platform}:publication:${publicationKey}` : args.defaultValue,
  )
}

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
        idempotencyKey: resolvePublicationIdempotencyKey({
          defaultValue: `facebook:${sourceKind}:${sourceId}:${pageId}:${format}:${primary}`,
          input,
          platform,
        }),
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
        idempotencyKey: resolvePublicationIdempotencyKey({
          defaultValue: `gbp:${sourceKind}:${sourceId}:${accountId}:${locationId}:${topic}:${asString(input.imageUrl)}`,
          input,
          platform,
        }),
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
        idempotencyKey: resolvePublicationIdempotencyKey({
          defaultValue: `instagram:${sourceKind}:${sourceId}:${igUserId}:${mediaType}:${primary}`,
          input,
          platform,
        }),
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
        idempotencyKey: resolvePublicationIdempotencyKey({
          defaultValue: `manual:${sourceKind}:${sourceId}:${boardId}:${primary}`,
          input,
          platform,
        }),
        primaryAssetUrl: primary,
      }
    }
    default: {
      const _exhaustive: never = platform
      throw new ValidationError(`unsupported platform: ${String(_exhaustive)}`)
    }
  }
}
