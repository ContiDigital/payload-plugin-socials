import type { Payload, PayloadRequest } from 'payload'

import type { PostStatus } from '../../../constants.js'
import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../types/index.js'

import {
  INSTAGRAM_CAPTION_MAX_CHARS,
  INSTAGRAM_CAPTION_MAX_HASHTAGS,
  INSTAGRAM_CAPTION_MAX_MENTIONS,
  INSTAGRAM_CAROUSEL_MAX_CHILDREN,
  INSTAGRAM_CAROUSEL_MIN_CHILDREN,
  INSTAGRAM_CONTAINER_LIFETIME_HOURS,
  SOCIAL_POSTS_SLUG,
} from '../../../constants.js'
import { resolvePlatformImageUrl } from '../../assets/resolvePlatformImage.js'
import { resolveConfiguredText } from '../../copy/resolveConfiguredCopy.js'
import { persistPublicationAudit } from '../../services/publicationPersistence.js'
import { PlatformApiError, ValidationError } from '../../utilities/errors.js'
import { sha256Hex } from '../../utilities/hash.js'
import { resolvePublicationIdempotencyKey } from '../../utilities/publicationIdentity.js'
import { sleep } from '../../utilities/sleep.js'
import { metaJson } from '../_meta/api.js'
import { buildDefaultInstagramCaption, countHashtags, countMentions } from './copy.js'

/**
 * Instagram Business publish path.
 *
 * Provider flow:
 *
 *   1. **Container create** — `POST /{ig-user-id}/media` with the media
 *      payload (image_url / video_url / children / etc.). Returns
 *      `{ id: "<container-id>" }`. Container lives for 24 hours.
 *
 *   2. **Status poll** — `GET /{container-id}?fields=status_code` until
 *      `status_code` transitions out of `IN_PROGRESS`. Images: usually
 *      seconds. Videos/Reels: 30 s – 5 min.
 *
 *   3. **Publish** — `POST /{ig-user-id}/media_publish` with
 *      `{ creation_id: "<container-id>" }`. Returns the published
 *      `ig-media-id`.
 *
 * Supported media types:
 *   - Single image                                                ✓
 *   - Single video (`media_type: REELS` since plain `VIDEO` is being phased out — §4.4) ✓
 *   - Reels                                                        ✓
 *   - Stories (image or video)                                     ✓
 *   - Carousel (2–10 children, same aspect ratio, no Reels children) ✓
 *
 * Idempotency key:
 *   sha256("instagram:" + sourceKind + ":" + sourceId + ":" + igUserId + ":" + mediaType + ":" + primaryAssetUrl)
 *
 * Image conversion (assets.autoConvert) happens ONLY when constructing the
 * outbound Instagram API container body, AFTER the idempotency key and
 * primaryAssetUrl are locked to the ORIGINAL input URL. The converted URL
 * never touches the key, primaryAssetUrl, sourceHash, or the reservation row.
 */

export const INSTAGRAM_MEDIA_TYPES = ['IMAGE', 'REELS', 'STORIES', 'CAROUSEL'] as const
export type InstagramMediaType = (typeof INSTAGRAM_MEDIA_TYPES)[number]

export type InstagramPublishInput = {
  /** Optional alt_text (image posts only). */
  altText?: string
  /** Reels-only: audio_name. */
  audioName?: string
  /** Caption override (optional; falls back to transformations → copyOverrides → default builder). */
  caption?: string
  /** Carousel children — 2–10 entries, each `{ imageUrl }` or `{ videoUrl }`. */
  carouselChildren?: Array<{ imageUrl?: string; videoUrl?: string }>
  /** Reels-only: cover image url. */
  coverUrl?: string
  /** Exact legacy SHA-256 identity used when adopting an existing audit row. */
  idempotencyKeyOverride?: string
  /** IG Business user id. Required. */
  igUserId: string
  /** Single-image override. */
  imageUrl?: string
  /** Optional location tag (FB Page id). */
  locationId?: string
  /** What to publish. Default `IMAGE`. */
  mediaType?: InstagramMediaType
  /** Caller-defined logical publication identity for intentional repeat campaigns. */
  publicationKey?: string
  publishedByUserId?: number | string
  /** Reels-only: share to Feed (`share_to_feed`). Default false (Reels-tab only). */
  shareToFeed?: boolean
  /** Reels-only: thumb offset in ms. */
  thumbOffsetMs?: number
  /** Optional user tags `[{ username, x, y }]`. */
  userTags?: Array<{ username: string; x?: number; y?: number }>
  /** Single-video override (used for REELS, STORIES, or feed video). */
  videoUrl?: string
}

type ContainerCreateResponse = { id: string }

type ContainerStatusResponse = {
  id: string
  status?: string
  status_code?: 'ERROR' | 'EXPIRED' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'
}

type MediaPublishResponse = {
  id: string
  permalink?: string
}

type SocialPostRow = {
  attempts?: number
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  status: PostStatus
}

const buildIdempotencyKey = (
  ctx: SocialSourceContext,
  input: InstagramPublishInput,
  igUserId: string,
  mediaType: InstagramMediaType,
  primaryAssetUrl: string,
): string =>
  resolvePublicationIdempotencyKey({
    defaultValue: `instagram:${ctx.sourceKind}:${ctx.sourceId}:${igUserId}:${mediaType}:${primaryAssetUrl}`,
    input: input as unknown as Record<string, unknown>,
    platform: 'instagram',
  })

const resolveCaption = (
  ctx: SocialSourceContext,
  input: InstagramPublishInput,
  options: NormalizedPluginOptions,
): string => {
  if (input.caption !== undefined) {
    return input.caption
  }
  return resolveConfiguredText('instagramCaption', ctx, options, buildDefaultInstagramCaption)
}

const validateCaption = (caption: string): void => {
  if (caption.length > INSTAGRAM_CAPTION_MAX_CHARS) {
    throw new ValidationError(
      `Instagram caption exceeds ${INSTAGRAM_CAPTION_MAX_CHARS} chars (got ${caption.length})`,
    )
  }
  const hashtags = countHashtags(caption)
  if (hashtags > INSTAGRAM_CAPTION_MAX_HASHTAGS) {
    throw new ValidationError(
      `Instagram caption has ${hashtags} hashtags (max ${INSTAGRAM_CAPTION_MAX_HASHTAGS})`,
    )
  }
  const mentions = countMentions(caption)
  if (mentions > INSTAGRAM_CAPTION_MAX_MENTIONS) {
    throw new ValidationError(
      `Instagram caption has ${mentions} @mentions (max ${INSTAGRAM_CAPTION_MAX_MENTIONS})`,
    )
  }
}

/**
 * Build a single-image container body using the OUTBOUND image URL (may be a
 * converted rendition). All key/hash logic uses the original URL from input.
 */
const buildSingleImageContainerBody = (
  caption: string,
  input: InstagramPublishInput,
  outboundImageUrl: string,
): Record<string, unknown> => {
  if (!outboundImageUrl) {
    throw new ValidationError('imageUrl is required for IMAGE media')
  }
  const body: Record<string, unknown> = {
    caption,
    image_url: outboundImageUrl,
  }
  if (input.locationId) {
    body.location_id = input.locationId
  }
  if (input.altText) {
    body.alt_text = input.altText
  }
  if (input.userTags) {
    body.user_tags = input.userTags
  }
  return body
}

const buildReelsContainerBody = (
  caption: string,
  input: InstagramPublishInput,
): Record<string, unknown> => {
  if (!input.videoUrl) {
    throw new ValidationError('videoUrl is required for REELS media')
  }
  const body: Record<string, unknown> = {
    caption,
    media_type: 'REELS',
    share_to_feed: input.shareToFeed ?? false,
    video_url: input.videoUrl,
  }
  if (input.coverUrl) {
    body.cover_url = input.coverUrl
  }
  if (input.audioName) {
    body.audio_name = input.audioName
  }
  if (typeof input.thumbOffsetMs === 'number') {
    body.thumb_offset = input.thumbOffsetMs
  }
  return body
}

/**
 * Build a STORIES container body using the OUTBOUND image URL (may be
 * converted). Original URL is used for keys only.
 */
const buildStoriesContainerBody = (
  input: InstagramPublishInput,
  outboundImageUrl?: string,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { media_type: 'STORIES' }
  if (outboundImageUrl) {
    body.image_url = outboundImageUrl
  } else if (input.videoUrl) {
    body.video_url = input.videoUrl
  } else {
    throw new ValidationError('STORIES requires imageUrl or videoUrl')
  }
  return body
}

const pollContainerStatus = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  containerId: string,
  args: { intervalMs?: number; maxWaitMs?: number } = {},
): Promise<'FINISHED' | 'PUBLISHED'> => {
  const maxWaitMs = args.maxWaitMs ?? 5 * 60 * 1000 // 5 min
  const intervalMs = args.intervalMs ?? 5_000
  const deadline = Date.now() + maxWaitMs

  while (true) {
    const status = await metaJson<ContainerStatusResponse>(
      payload,
      options,
      'instagram',
      `/${encodeURIComponent(containerId)}?fields=status_code,status,id`,
    )
    const code = status.status_code ?? 'IN_PROGRESS'
    if (code === 'FINISHED' || code === 'PUBLISHED') {
      return code
    }
    if (code === 'EXPIRED') {
      throw new PlatformApiError({
        message: `Instagram container ${containerId} expired before publish (24h limit)`,
        platform: 'instagram',
        retryable: false,
        statusCode: 410,
        upstreamCode: 'container_expired',
      })
    }
    if (code === 'ERROR') {
      throw new PlatformApiError({
        message: `Instagram container ${containerId} processing failed: ${status.status ?? 'unknown'}`,
        platform: 'instagram',
        retryable: false,
        statusCode: 502,
        upstreamCode: 'container_error',
        upstreamMessage: status.status,
      })
    }
    if (Date.now() >= deadline) {
      throw new PlatformApiError({
        message: `Instagram container ${containerId} did not finish processing within ${maxWaitMs}ms`,
        platform: 'instagram',
        retryable: true,
        statusCode: 504,
        upstreamCode: 'container_timeout',
      })
    }
    await sleep(intervalMs)
  }
}

const createContainer = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  igUserId: string,
  body: Record<string, unknown>,
): Promise<string> => {
  const response = await metaJson<ContainerCreateResponse>(
    payload,
    options,
    'instagram',
    `/${encodeURIComponent(igUserId)}/media`,
    {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
  )
  if (!response.id) {
    throw new PlatformApiError({
      message: 'Instagram container create returned no id',
      platform: 'instagram',
      raw: response,
      retryable: false,
      statusCode: 502,
    })
  }
  return response.id
}

/**
 * Build carousel child containers using outbound (possibly converted) URLs.
 * The carousel primaryAssetUrl (for keys) uses the original child URLs.
 */
const buildCarouselChildren = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  igUserId: string,
  children: NonNullable<InstagramPublishInput['carouselChildren']>,
): Promise<string[]> => {
  if (children.length < INSTAGRAM_CAROUSEL_MIN_CHILDREN) {
    throw new ValidationError(
      `Instagram carousel requires at least ${INSTAGRAM_CAROUSEL_MIN_CHILDREN} children`,
    )
  }
  if (children.length > INSTAGRAM_CAROUSEL_MAX_CHILDREN) {
    throw new ValidationError(
      `Instagram carousel supports at most ${INSTAGRAM_CAROUSEL_MAX_CHILDREN} children`,
    )
  }

  const ids = await Promise.all(
    children.map(async (child) => {
      const body: Record<string, unknown> = { is_carousel_item: true }
      if (child.imageUrl) {
        // Resolve outbound URL for the child image (conversion if needed).
        const resolved = await resolvePlatformImageUrl({
          imageUrl: child.imageUrl,
          options,
          payload,
          platform: 'instagram',
        })
        body.image_url = resolved.url
      } else if (child.videoUrl) {
        body.media_type = 'VIDEO'
        body.video_url = child.videoUrl
      } else {
        throw new ValidationError('Carousel child requires imageUrl or videoUrl')
      }
      return createContainer(payload, options, igUserId, body)
    }),
  )
  await Promise.all(ids.map((id) => pollContainerStatus(payload, options, id)))
  return ids
}

const findExistingByIdempotencyKey = async (
  payload: Payload,
  key: string,
): Promise<null | SocialPostRow> => {
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { idempotencyKey: { equals: key } },
  })
  return (result.docs[0] as SocialPostRow | undefined) ?? null
}

const publishContainer = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  igUserId: string,
  containerId: string,
): Promise<MediaPublishResponse> => {
  return metaJson<MediaPublishResponse>(
    payload,
    options,
    'instagram',
    `/${encodeURIComponent(igUserId)}/media_publish`,
    {
      body: JSON.stringify({ creation_id: containerId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
  )
}

const resolvePrimaryAssetUrl = (input: InstagramPublishInput): string => {
  if (input.mediaType === 'CAROUSEL') {
    const first = input.carouselChildren?.[0]
    return first?.imageUrl ?? first?.videoUrl ?? ''
  }
  return input.videoUrl ?? input.imageUrl ?? ''
}

/**
 * Pure derivation of the Instagram idempotency identity — identical logic to
 * the publish path. Exported for parity testing against `buildPublicationIdentity`.
 */
export const deriveInstagramIdentity = (
  ctx: SocialSourceContext,
  input: InstagramPublishInput,
): { idempotencyKey: string; primaryAssetUrl: string } => {
  const mediaType = input.mediaType ?? 'IMAGE'
  const primaryAssetUrl = resolvePrimaryAssetUrl(input)
  return {
    idempotencyKey: buildIdempotencyKey(ctx, input, input.igUserId, mediaType, primaryAssetUrl),
    primaryAssetUrl,
  }
}

export type InstagramPublishResult = {
  alreadyExisted: boolean
  postId: number | string
  publishedRef: PublishedRef
}

export const publishInstagramMedia = async (args: {
  ctx: SocialSourceContext
  input: InstagramPublishInput
  options: NormalizedPluginOptions
  payload: Payload
  req?: PayloadRequest
}): Promise<InstagramPublishResult> => {
  const { ctx, input, options, payload } = args

  if (!input.igUserId) {
    throw new ValidationError('igUserId is required')
  }
  const mediaType = input.mediaType ?? 'IMAGE'

  // Derive primaryAssetUrl and idempotencyKey from the ORIGINAL input URL.
  // These must never be touched by format conversion.
  const primaryAssetUrl = resolvePrimaryAssetUrl(input)
  if (!primaryAssetUrl && mediaType !== 'CAROUSEL') {
    throw new ValidationError('imageUrl or videoUrl is required')
  }

  const caption = mediaType === 'STORIES' ? '' : resolveCaption(ctx, input, options)
  if (mediaType !== 'STORIES') {
    validateCaption(caption)
  }

  const idempotencyKey = buildIdempotencyKey(ctx, input, input.igUserId, mediaType, primaryAssetUrl)
  const existing = await findExistingByIdempotencyKey(payload, idempotencyKey)
  if (existing && existing.status === 'published' && existing.externalId) {
    return {
      alreadyExisted: true,
      postId: existing.id,
      publishedRef: {
        externalId: existing.externalId,
        externalUrl: existing.externalUrl ?? undefined,
        platform: 'instagram',
      },
    }
  }

  // ---- Outbound URL resolution (conversion only touches the API request body) ----
  // Resolve the image URL for single-image and STORIES media types.
  let outboundImageUrl: string | undefined
  if ((mediaType === 'IMAGE' || mediaType === 'STORIES') && input.imageUrl) {
    const imgMeta = ctx.images.find((img) => img.url === input.imageUrl)
    const resolved = await resolvePlatformImageUrl({
      declaredFormat: imgMeta?.format,
      imageUrl: input.imageUrl,
      options,
      payload,
      platform: 'instagram',
    })
    outboundImageUrl = resolved.url
  }

  // ---- Container assembly + publish ----
  let containerId: string
  if (mediaType === 'IMAGE') {
    containerId = await createContainer(
      payload,
      options,
      input.igUserId,
      buildSingleImageContainerBody(caption, input, outboundImageUrl ?? ''),
    )
  } else if (mediaType === 'REELS') {
    containerId = await createContainer(
      payload,
      options,
      input.igUserId,
      buildReelsContainerBody(caption, input),
    )
  } else if (mediaType === 'STORIES') {
    containerId = await createContainer(
      payload,
      options,
      input.igUserId,
      buildStoriesContainerBody(input, outboundImageUrl),
    )
  } else if (mediaType === 'CAROUSEL') {
    if (!input.carouselChildren) {
      throw new ValidationError('CAROUSEL requires carouselChildren')
    }
    const childIds = await buildCarouselChildren(
      payload,
      options,
      input.igUserId,
      input.carouselChildren,
    )
    const parentBody: Record<string, unknown> = {
      caption,
      children: childIds.join(','),
      media_type: 'CAROUSEL',
    }
    if (input.locationId) {
      parentBody.location_id = input.locationId
    }
    containerId = await createContainer(payload, options, input.igUserId, parentBody)
  } else {
    throw new ValidationError(`Unsupported Instagram media type: ${String(mediaType)}`)
  }

  // Container created — poll until FINISHED (videos can take minutes).
  await pollContainerStatus(payload, options, containerId)

  // Publish.
  const published = await publishContainer(payload, options, input.igUserId, containerId)
  if (!published.id) {
    throw new PlatformApiError({
      message: 'Instagram media_publish returned no id',
      platform: 'instagram',
      raw: published,
      retryable: false,
      statusCode: 502,
    })
  }

  let externalUrl = published.permalink
  if (!externalUrl && mediaType !== 'STORIES') {
    try {
      const media = await metaJson<{ permalink?: string }>(
        payload,
        options,
        'instagram',
        `/${encodeURIComponent(published.id)}?fields=permalink`,
      )
      externalUrl = media.permalink
    } catch {
      // Publishing already succeeded; permalink enrichment is best-effort.
    }
  }

  // sourceHash is derived from the ORIGINAL primaryAssetUrl, not the converted one.
  const sourceHash = sha256Hex(
    JSON.stringify({
      caption,
      carouselChildren: input.carouselChildren,
      igUserId: input.igUserId,
      mediaType,
      primaryAssetUrl,
    }),
  )

  const baseFields = {
    altText: input.altText,
    attempts: ((existing as unknown as { attempts?: number })?.attempts ?? 0) + 1,
    body: caption,
    destination: {
      id: input.igUserId,
      meta: { containerId, locationId: input.locationId, mediaType },
    },
    externalId: published.id,
    externalUrl,
    idempotencyKey,
    imageUrl: input.imageUrl ?? input.carouselChildren?.[0]?.imageUrl,
    lastAttemptedAt: new Date().toISOString(),
    lastError: null,
    link: ctx.link,
    meta: { containerId, mediaType, raw: published },
    platform: 'instagram' as const,
    platformPublicationStatus: 'published' as const,
    publishedAt: new Date().toISOString(),
    ...(options.authCollection ? { publishedBy: input.publishedByUserId } : {}),
    sourceHash,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    status: 'published' as const,
    title: ctx.baseTitle,
  }

  const publishedRef: PublishedRef = {
    externalId: published.id,
    externalUrl,
    meta: { containerId, mediaType },
    platform: 'instagram',
  }
  const savedId = await persistPublicationAudit({
    persist: async () => {
      if (existing) {
        const updated = (await payload.update({
          id: existing.id as never,
          collection: SOCIAL_POSTS_SLUG as never,
          data: baseFields as never,
          overrideAccess: true,
        })) as unknown as { id: number | string }
        return updated.id
      }
      const created = (await payload.create({
        collection: SOCIAL_POSTS_SLUG as never,
        data: baseFields as never,
        overrideAccess: true,
      })) as unknown as { id: number | string }
      return created.id
    },
    publishedRef,
  })

  return {
    alreadyExisted: false,
    postId: savedId,
    publishedRef,
  }
}

// Surface the lifetime constant for the admin UI banner copy.
export { INSTAGRAM_CONTAINER_LIFETIME_HOURS }
