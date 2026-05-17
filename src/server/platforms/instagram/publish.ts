import type { Payload, PayloadRequest } from 'payload'

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
import { PlatformApiError, ValidationError } from '../../utilities/errors.js'
import { sha256Hex } from '../../utilities/hash.js'
import { metaJson } from '../_meta/api.js'
import { buildDefaultInstagramCaption, countHashtags, countMentions } from './copy.js'

/**
 * Instagram Business publish path.
 *
 * Two-phase flow (CLAUDE.md §4.4):
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
 */

export const INSTAGRAM_MEDIA_TYPES = ['IMAGE', 'REELS', 'STORIES', 'CAROUSEL'] as const
export type InstagramMediaType = (typeof INSTAGRAM_MEDIA_TYPES)[number]

export type InstagramPublishInput = {
  /** Optional alt_text (image posts only). */
  altText?: string
  /** Reels-only: audio_name. */
  audioName?: string
  /** Caption override (optional; falls back to copyOverrides → default builder). */
  caption?: string
  /** Carousel children — 2–10 entries, each `{ imageUrl }` or `{ videoUrl }`. */
  carouselChildren?: Array<{ imageUrl?: string; videoUrl?: string }>
  /** Reels-only: cover image url. */
  coverUrl?: string
  /** IG Business user id. Required. */
  igUserId: string
  /** Single-image override. */
  imageUrl?: string
  /** Optional location tag (FB Page id). */
  locationId?: string
  /** What to publish. Default `IMAGE`. */
  mediaType?: InstagramMediaType
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
  status: 'cancelled' | 'draft' | 'failed' | 'published' | 'publishing' | 'queued'
}

const buildIdempotencyKey = (
  ctx: SocialSourceContext,
  igUserId: string,
  mediaType: InstagramMediaType,
  primaryAssetUrl: string,
): string =>
  sha256Hex(
    `instagram:${ctx.sourceKind}:${ctx.sourceId}:${igUserId}:${mediaType}:${primaryAssetUrl}`,
  )

const resolveCaption = (
  ctx: SocialSourceContext,
  input: InstagramPublishInput,
  options: NormalizedPluginOptions,
): string => {
  const override = options.copyOverrides.instagramCaption?.(ctx)
  return input.caption ?? override ?? buildDefaultInstagramCaption(ctx)
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

const buildSingleImageContainerBody = (
  caption: string,
  input: InstagramPublishInput,
): Record<string, unknown> => {
  if (!input.imageUrl) {
    throw new ValidationError('imageUrl is required for IMAGE media')
  }
  const body: Record<string, unknown> = {
    caption,
    image_url: input.imageUrl,
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

const buildStoriesContainerBody = (input: InstagramPublishInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { media_type: 'STORIES' }
  if (input.imageUrl) {
    body.image_url = input.imageUrl
  } else if (input.videoUrl) {
    body.video_url = input.videoUrl
  } else {
    throw new ValidationError('STORIES requires imageUrl or videoUrl')
  }
  return body
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
        body.image_url = child.imageUrl
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

  const primaryAssetUrl = resolvePrimaryAssetUrl(input)
  if (!primaryAssetUrl && mediaType !== 'CAROUSEL') {
    throw new ValidationError('imageUrl or videoUrl is required')
  }

  const caption = mediaType === 'STORIES' ? '' : resolveCaption(ctx, input, options)
  if (mediaType !== 'STORIES') {
    validateCaption(caption)
  }

  const idempotencyKey = buildIdempotencyKey(ctx, input.igUserId, mediaType, primaryAssetUrl)
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

  // ---- Container assembly + publish ----
  let containerId: string
  if (mediaType === 'IMAGE') {
    containerId = await createContainer(
      payload,
      options,
      input.igUserId,
      buildSingleImageContainerBody(caption, input),
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
      buildStoriesContainerBody(input),
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
    publishedBy: input.publishedByUserId,
    sourceHash,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    status: 'published' as const,
    title: ctx.baseTitle,
  }

  let savedId: number | string
  if (existing) {
    const updated = (await payload.update({
      id: existing.id as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: baseFields as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    savedId = updated.id
  } else {
    const created = (await payload.create({
      collection: SOCIAL_POSTS_SLUG as never,
      data: baseFields as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    savedId = created.id
  }

  return {
    alreadyExisted: false,
    postId: savedId,
    publishedRef: {
      externalId: published.id,
      externalUrl,
      meta: { containerId, mediaType },
      platform: 'instagram',
    },
  }
}

export const deleteInstagramMedia = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<void> => {
  const { options, payload, publishedRef } = args
  if (publishedRef.platform !== 'instagram') {
    throw new ValidationError(`Cannot delete: publishedRef is for ${publishedRef.platform}`)
  }
  if (!publishedRef.externalId) {
    return
  }

  const { makeMetaRequest } = await import('../_meta/api.js')
  const response = await makeMetaRequest(
    payload,
    options,
    'instagram',
    `/${encodeURIComponent(publishedRef.externalId)}`,
    { init: { method: 'DELETE' } },
  )

  if (!response.ok && response.status !== 404) {
    throw new ValidationError(
      `Instagram media delete failed: ${response.status} ${await response.text().catch(() => '')}`,
    )
  }

  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      externalId: { equals: publishedRef.externalId },
      platform: { equals: 'instagram' },
    },
  })
  const doc = result.docs[0] as { id: number | string } | undefined
  if (doc) {
    await payload.update({
      id: doc.id as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: { status: 'cancelled' } as never,
      overrideAccess: true,
    })
  }
}

// Surface the lifetime constant for the admin UI banner copy.
export { INSTAGRAM_CONTAINER_LIFETIME_HOURS }
