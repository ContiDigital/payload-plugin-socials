import type { Payload, PayloadRequest } from 'payload'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../types/index.js'

import { SOCIAL_POSTS_SLUG } from '../../../constants.js'
import { resolvePlatformImageUrl } from '../../assets/resolvePlatformImage.js'
import { resolveConfiguredText } from '../../copy/resolveConfiguredCopy.js'
import { persistPublicationAudit } from '../../services/publicationPersistence.js'
import { PlatformApiError, ValidationError } from '../../utilities/errors.js'
import { sha256Hex } from '../../utilities/hash.js'
import { resolvePublicationIdempotencyKey } from '../../utilities/publicationIdentity.js'
import { makeMetaRequest } from '../_meta/api.js'
import { buildDefaultFacebookMessage } from './copy.js'
import { getPageAccessToken } from './pages.js'

/**
 * Facebook Page publish path.
 *
 * Three formats supported in v1:
 *   - LINK    : `POST /{page-id}/feed` with `message` + `link`
 *   - PHOTO   : `POST /{page-id}/photos` with `url` (single) OR multi-photo
 *               assembly via `published=false` children + `attached_media`
 *   - VIDEO   : `POST /{page-id}/videos` with `file_url` (Meta fetches it).
 *               This matches the plugin's URL-based source media contract and
 *               avoids proxying large video files through the Payload host.
 *
 * The publish path uses the **Page-scoped access token** (not the user
 * token), derived on demand via `/{page-id}?fields=access_token`. The
 * `_meta/api` client passes whatever token is in the Authorization header
 * verbatim, so we override it inline for these calls.
 *
 * Idempotency key:
 *   sha256("facebook:" + sourceKind + ":" + sourceId + ":" + pageId + ":" + format + ":" + primaryAssetUrl)
 *
 * Image conversion (assets.autoConvert) happens ONLY when constructing the
 * outbound Facebook API request body, AFTER the idempotency key and
 * primaryAssetUrl are locked to the ORIGINAL input URL. The converted URL
 * never touches the key, primaryAssetUrl, sourceHash, or the reservation row.
 */

export const FACEBOOK_FORMATS = ['LINK', 'PHOTO', 'PHOTO_MULTI', 'VIDEO'] as const
export type FacebookFormat = (typeof FACEBOOK_FORMATS)[number]

export type FacebookPublishInput = {
  /** PHOTO: optional alt text. */
  altText?: string
  /** Format. Default `LINK`. */
  format?: FacebookFormat
  /** Exact legacy SHA-256 identity used when adopting an existing audit row. */
  idempotencyKeyOverride?: string
  /** PHOTO: single photo URL. */
  imageUrl?: string
  /** PHOTO_MULTI: array of public URLs (2-10). */
  imageUrls?: string[]
  /** LINK: link URL (defaults to ctx.link). */
  link?: string
  /** Message override (falls back to transformations → copyOverrides → default builder). */
  message?: string
  /** Page id to publish to. Required. */
  pageId: string
  /** Optional location tag (FB Page id of a place). */
  place?: string
  /** Caller-defined logical publication identity for intentional repeat campaigns. */
  publicationKey?: string
  publishedByUserId?: number | string
  /**
   * Schedule the post. 10-minute min, 75-day max from now for /feed.
   * For videos the max is 6 months. ISO-8601 string.
   */
  scheduledPublishTime?: string
  /** VIDEO: optional title. */
  videoTitle?: string
  /** VIDEO: public video URL Meta fetches. */
  videoUrl?: string
}

type FeedResponse = { id: string; post_id?: string }
type PhotoResponse = { id: string; post_id?: string }
type VideoResponse = { id: string; post_id?: string }

type SocialPostRow = {
  attempts?: number
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  status: 'cancelled' | 'draft' | 'failed' | 'published' | 'publishing' | 'queued'
}

const SCHEDULE_MIN_OFFSET_MS = 10 * 60 * 1000
const SCHEDULE_FEED_MAX_OFFSET_MS = 75 * 24 * 60 * 60 * 1000
const SCHEDULE_VIDEO_MAX_OFFSET_MS = 6 * 30 * 24 * 60 * 60 * 1000

const buildIdempotencyKey = (
  ctx: SocialSourceContext,
  input: FacebookPublishInput,
  pageId: string,
  format: FacebookFormat,
  primaryAssetUrl: string,
): string =>
  resolvePublicationIdempotencyKey({
    defaultValue: `facebook:${ctx.sourceKind}:${ctx.sourceId}:${pageId}:${format}:${primaryAssetUrl}`,
    input: input as unknown as Record<string, unknown>,
    platform: 'facebook',
  })

const resolveMessage = (
  ctx: SocialSourceContext,
  input: FacebookPublishInput,
  options: NormalizedPluginOptions,
): string => {
  const resolved = resolveConfiguredText(
    'facebookMessage',
    ctx,
    options,
    buildDefaultFacebookMessage,
  )
  return input.message?.trim() || resolved
}

const validateSchedule = (
  isoTime: string | undefined,
  format: FacebookFormat,
): number | undefined => {
  if (!isoTime) {
    return undefined
  }
  const ms = Date.parse(isoTime)
  if (Number.isNaN(ms)) {
    throw new ValidationError(`scheduledPublishTime is not a valid ISO-8601 string: ${isoTime}`)
  }
  const offsetMs = ms - Date.now()
  if (offsetMs < SCHEDULE_MIN_OFFSET_MS) {
    throw new ValidationError('scheduledPublishTime must be at least 10 minutes in the future')
  }
  const maxOffset = format === 'VIDEO' ? SCHEDULE_VIDEO_MAX_OFFSET_MS : SCHEDULE_FEED_MAX_OFFSET_MS
  if (offsetMs > maxOffset) {
    const cap = format === 'VIDEO' ? '6 months' : '75 days'
    throw new ValidationError(`scheduledPublishTime must be within ${cap}`)
  }
  // Meta expects seconds since epoch.
  return Math.floor(ms / 1000)
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

const buildPermalink = (postId: string, pageId: string, format: FacebookFormat): string => {
  // /{page_id}_{post_id} format. Facebook also resolves /{post_id} alone.
  const [page, post] = postId.split('_')
  if (page && post) {
    return `https://www.facebook.com/${page}/posts/${post}`
  }
  return format === 'VIDEO'
    ? `https://www.facebook.com/${pageId}/videos/${postId}`
    : `https://www.facebook.com/${postId}`
}

// ---------------------------------------------------------------------------
// Per-format publish helpers (use Page access token explicitly)
// ---------------------------------------------------------------------------

const postWithPageToken = async <T>(
  payload: Payload,
  options: NormalizedPluginOptions,
  path: string,
  body: Record<string, unknown>,
  pageAccessToken: string,
): Promise<T> => {
  // Page publishing requires the derived Page token, not the parent user or
  // system token used for discovery.
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) {
      continue
    }
    if (typeof v === 'object') {
      params.set(k, JSON.stringify(v))
    } else if (typeof v === 'string') {
      params.set(k, v)
    } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      params.set(k, String(v))
    }
  }

  // Reuse the Meta client so Page-scoped calls retain retries, quota tracking,
  // and appsecret_proof computed from the Page token.
  const response = await makeMetaRequest(payload, options, 'facebook', path, {
    accessToken: pageAccessToken,
    init: {
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let envelope: { error?: { code?: number; message?: string } } = {}
    try {
      envelope = JSON.parse(text) as typeof envelope
    } catch {
      /* keep raw */
    }
    throw new PlatformApiError({
      message: `Facebook ${path} failed: ${response.status}${envelope.error?.message ? ` — ${envelope.error.message}` : ''}`,
      platform: 'facebook',
      raw: envelope,
      retryable: response.status >= 500 || response.status === 429,
      statusCode: response.status,
      upstreamCode: envelope.error?.code ?? response.status,
      upstreamMessage: envelope.error?.message ?? text,
    })
  }
  return (await response.json()) as T
}

const publishLinkPost = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  input: FacebookPublishInput,
  message: string,
  pageAccessToken: string,
  scheduledSeconds?: number,
): Promise<FeedResponse> => {
  const body: Record<string, unknown> = { message }
  if (input.link) {
    body.link = input.link
  }
  if (input.place) {
    body.place = input.place
  }
  if (scheduledSeconds) {
    body.scheduled_publish_time = scheduledSeconds
    body.published = false
  }
  return postWithPageToken<FeedResponse>(
    payload,
    options,
    `/${encodeURIComponent(input.pageId)}/feed`,
    body,
    pageAccessToken,
  )
}

/**
 * Upload a single photo unpublished, using the given outbound URL (may be
 * a converted rendition). The original URL is used for key derivation only.
 */
const uploadPhotoUnpublished = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  pageId: string,
  outboundImageUrl: string,
  pageAccessToken: string,
  altText?: string,
): Promise<PhotoResponse> => {
  const body: Record<string, unknown> = { published: false, url: outboundImageUrl }
  if (altText) {
    body.alt_text_custom = altText
  }
  return postWithPageToken<PhotoResponse>(
    payload,
    options,
    `/${encodeURIComponent(pageId)}/photos`,
    body,
    pageAccessToken,
  )
}

/**
 * Publish a single PHOTO using the outbound URL (may be converted).
 * The idempotency key and primaryAssetUrl use the ORIGINAL input.imageUrl.
 */
const publishSinglePhoto = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  input: FacebookPublishInput,
  message: string,
  pageAccessToken: string,
  outboundImageUrl: string,
  scheduledSeconds?: number,
): Promise<PhotoResponse> => {
  if (!outboundImageUrl) {
    throw new ValidationError('imageUrl is required for PHOTO')
  }
  const body: Record<string, unknown> = {
    caption: message,
    url: outboundImageUrl,
  }
  if (input.altText) {
    body.alt_text_custom = input.altText
  }
  if (input.place) {
    body.place = input.place
  }
  if (scheduledSeconds) {
    body.scheduled_publish_time = scheduledSeconds
    body.published = false
  }
  return postWithPageToken<PhotoResponse>(
    payload,
    options,
    `/${encodeURIComponent(input.pageId)}/photos`,
    body,
    pageAccessToken,
  )
}

/**
 * Publish a PHOTO_MULTI post. Each image is resolved to its outbound URL
 * (possibly converted) just before the individual upload. The
 * primaryAssetUrl (for the idempotency key) uses the ORIGINAL first URL.
 */
const publishMultiPhoto = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  input: FacebookPublishInput,
  message: string,
  pageAccessToken: string,
  scheduledSeconds?: number,
): Promise<FeedResponse> => {
  if (!input.imageUrls || input.imageUrls.length < 2 || input.imageUrls.length > 10) {
    throw new ValidationError('PHOTO_MULTI requires 2–10 entries in imageUrls')
  }

  // Step 1: resolve each URL to its outbound form, then upload unpublished.
  const uploaded = await Promise.all(
    input.imageUrls.map(async (url) => {
      const resolved = await resolvePlatformImageUrl({
        imageUrl: url,
        options,
        payload,
        platform: 'facebook',
      })
      return uploadPhotoUnpublished(payload, options, input.pageId, resolved.url, pageAccessToken)
    }),
  )
  const mediaIds = uploaded.map((result) => result.id)

  // Step 2: create the parent /feed post with attached_media.
  const body: Record<string, unknown> = {
    attached_media: mediaIds.map((id) => ({ media_fbid: id })),
    message,
  }
  if (input.place) {
    body.place = input.place
  }
  if (scheduledSeconds) {
    body.scheduled_publish_time = scheduledSeconds
    body.published = false
  }
  return postWithPageToken<FeedResponse>(
    payload,
    options,
    `/${encodeURIComponent(input.pageId)}/feed`,
    body,
    pageAccessToken,
  )
}

const publishVideo = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  input: FacebookPublishInput,
  message: string,
  pageAccessToken: string,
  scheduledSeconds?: number,
): Promise<VideoResponse> => {
  if (!input.videoUrl) {
    throw new ValidationError('videoUrl is required for VIDEO')
  }
  const body: Record<string, unknown> = {
    description: message,
    file_url: input.videoUrl,
  }
  if (input.videoTitle) {
    body.title = input.videoTitle
  }
  if (scheduledSeconds) {
    body.scheduled_publish_time = scheduledSeconds
    body.published = false
  }
  return postWithPageToken<VideoResponse>(
    payload,
    options,
    `/${encodeURIComponent(input.pageId)}/videos`,
    body,
    pageAccessToken,
  )
}

const resolvePrimaryAssetUrl = (input: FacebookPublishInput): string => {
  switch (input.format ?? 'LINK') {
    case 'PHOTO':
      return input.imageUrl ?? ''
    case 'PHOTO_MULTI':
      return input.imageUrls?.[0] ?? ''
    case 'VIDEO':
      return input.videoUrl ?? ''
    case 'LINK':
    default:
      return input.link ?? ''
  }
}

/**
 * Pure derivation of the Facebook idempotency identity — identical logic to
 * the publish path. Exported for parity testing against `buildPublicationIdentity`.
 */
export const deriveFacebookIdentity = (
  ctx: SocialSourceContext,
  input: FacebookPublishInput,
): { idempotencyKey: string; primaryAssetUrl: string } => {
  const format: FacebookFormat = input.format ?? 'LINK'
  const primaryAssetUrl = resolvePrimaryAssetUrl(input)
  return {
    idempotencyKey: buildIdempotencyKey(ctx, input, input.pageId, format, primaryAssetUrl),
    primaryAssetUrl,
  }
}

export type FacebookPublishResult = {
  alreadyExisted: boolean
  postId: number | string
  publishedRef: PublishedRef
}

export const publishFacebookPost = async (args: {
  ctx: SocialSourceContext
  input: FacebookPublishInput
  options: NormalizedPluginOptions
  payload: Payload
  req?: PayloadRequest
}): Promise<FacebookPublishResult> => {
  const { ctx, input, options, payload } = args
  if (!input.pageId) {
    throw new ValidationError('pageId is required')
  }
  const format: FacebookFormat = input.format ?? 'LINK'

  const message = resolveMessage(ctx, input, options)

  // Derive primaryAssetUrl and idempotencyKey from the ORIGINAL input URL.
  // These must never be touched by format conversion.
  const primaryAssetUrl = resolvePrimaryAssetUrl(input)

  if (format === 'LINK' && !input.link && !primaryAssetUrl) {
    // /feed accepts a text-only post if `message` is non-empty.
    if (!message.trim()) {
      throw new ValidationError('Facebook posts need message, link, photo, or video')
    }
  }

  const idempotencyKey = buildIdempotencyKey(ctx, input, input.pageId, format, primaryAssetUrl)
  const existing = await findExistingByIdempotencyKey(payload, idempotencyKey)
  if (existing && existing.status === 'published' && existing.externalId) {
    return {
      alreadyExisted: true,
      postId: existing.id,
      publishedRef: {
        externalId: existing.externalId,
        externalUrl: existing.externalUrl ?? undefined,
        platform: 'facebook',
      },
    }
  }

  const pageAccessToken = await getPageAccessToken(payload, options, input.pageId)
  const scheduledSeconds = validateSchedule(input.scheduledPublishTime, format)

  let externalId: string
  let raw: unknown
  switch (format) {
    case 'LINK': {
      const linkResult = {
        ...input,
        link: input.link ?? ctx.link,
      }
      const response = await publishLinkPost(
        payload,
        options,
        linkResult,
        message,
        pageAccessToken,
        scheduledSeconds,
      )
      externalId = response.post_id ?? response.id
      raw = response
      break
    }
    case 'PHOTO': {
      // Resolve the outbound image URL here, just before building the API body.
      // The idempotency key above already used the original input.imageUrl.
      const resolved = await resolvePlatformImageUrl({
        imageUrl: input.imageUrl ?? '',
        options,
        payload,
        platform: 'facebook',
      })
      const response = await publishSinglePhoto(
        payload,
        options,
        input,
        message,
        pageAccessToken,
        resolved.url,
        scheduledSeconds,
      )
      externalId = response.post_id ?? response.id
      raw = response
      break
    }
    case 'PHOTO_MULTI': {
      // publishMultiPhoto resolves each URL internally.
      const response = await publishMultiPhoto(
        payload,
        options,
        input,
        message,
        pageAccessToken,
        scheduledSeconds,
      )
      externalId = response.post_id ?? response.id
      raw = response
      break
    }
    case 'VIDEO': {
      const response = await publishVideo(
        payload,
        options,
        input,
        message,
        pageAccessToken,
        scheduledSeconds,
      )
      externalId = response.post_id ?? response.id
      raw = response
      break
    }
    default:
      throw new ValidationError(`Unsupported Facebook format: ${String(format)}`)
  }

  if (!externalId) {
    throw new PlatformApiError({
      message: 'Facebook publish returned no post id',
      platform: 'facebook',
      raw,
      retryable: false,
      statusCode: 502,
    })
  }

  const externalUrl = buildPermalink(externalId, input.pageId, format)
  // sourceHash uses the ORIGINAL primaryAssetUrl, not any converted URL.
  const sourceHash = sha256Hex(
    JSON.stringify({ format, message, pageId: input.pageId, primaryAssetUrl }),
  )

  const baseFields = {
    altText: input.altText,
    attempts: ((existing as unknown as { attempts?: number })?.attempts ?? 0) + 1,
    body: message,
    destination: {
      id: input.pageId,
      meta: { format, scheduledPublishTime: input.scheduledPublishTime },
    },
    externalId,
    externalUrl,
    idempotencyKey,
    imageUrl: input.imageUrl ?? input.imageUrls?.[0],
    lastAttemptedAt: new Date().toISOString(),
    lastError: null,
    link: input.link ?? ctx.link,
    meta: { format, pageId: input.pageId, raw, scheduledSeconds },
    nextRetryAt: scheduledSeconds ? new Date(scheduledSeconds * 1000 + 60_000).toISOString() : null,
    platform: 'facebook' as const,
    platformPublicationStatus: scheduledSeconds ? 'pending' : 'published',
    publishedAt: scheduledSeconds ? undefined : new Date().toISOString(),
    scheduledAt: scheduledSeconds ? new Date(scheduledSeconds * 1000).toISOString() : undefined,
    ...(options.authCollection ? { publishedBy: input.publishedByUserId } : {}),
    sourceHash,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    status: scheduledSeconds ? ('scheduled' as const) : ('published' as const),
    title: ctx.baseTitle,
  }

  const publishedRef: PublishedRef = {
    externalId,
    externalUrl,
    meta: {
      format,
      pageId: input.pageId,
      scheduled: Boolean(scheduledSeconds),
      scheduledPublishTime: scheduledSeconds,
    },
    platform: 'facebook',
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

export const reconcileFacebookScheduledPost = async (args: {
  externalId: string
  options: NormalizedPluginOptions
  pageId: string
  payload: Payload
  postId: number | string
  scheduledPublishTime?: number
}): Promise<{ pending: boolean }> => {
  const pageAccessToken = await getPageAccessToken(args.payload, args.options, args.pageId)
  const response = await makeMetaRequest(
    args.payload,
    args.options,
    'facebook',
    `/${encodeURIComponent(args.externalId)}?fields=id,is_published,permalink_url`,
    { accessToken: pageAccessToken },
  )
  if (!response.ok) {
    throw new PlatformApiError({
      message: `Facebook scheduled post lookup failed: ${response.status}`,
      platform: 'facebook',
      retryable: response.status >= 500 || response.status === 429,
      statusCode: response.status,
      upstreamCode: response.status,
    })
  }
  const result = (await response.json()) as { is_published?: boolean; permalink_url?: string }
  const published = result.is_published === true
  const overdue =
    args.scheduledPublishTime !== undefined &&
    Date.now() > args.scheduledPublishTime * 1000 + 24 * 60 * 60 * 1000
  await args.payload.update({
    id: args.postId as never,
    collection: SOCIAL_POSTS_SLUG as never,
    data: {
      externalUrl: result.permalink_url,
      lastAttemptedAt: new Date().toISOString(),
      lastError: overdue ? 'Facebook did not publish the scheduled post within 24 hours.' : null,
      nextRetryAt: published || overdue ? null : new Date(Date.now() + 5 * 60_000).toISOString(),
      platformPublicationStatus: published ? 'published' : overdue ? 'failed' : 'pending',
      ...(published ? { publishedAt: new Date().toISOString() } : {}),
      status: published ? 'published' : overdue ? 'failed' : 'scheduled',
    } as never,
    overrideAccess: true,
  })
  return { pending: !published && !overdue }
}

export const deleteFacebookPost = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<void> => {
  const { options, payload, publishedRef } = args
  if (publishedRef.platform !== 'facebook') {
    throw new ValidationError(`Cannot delete: publishedRef is for ${publishedRef.platform}`)
  }
  if (!publishedRef.externalId) {
    return
  }

  const metadataPageId =
    typeof publishedRef.meta?.pageId === 'string' ? publishedRef.meta.pageId.trim() : ''
  const [compoundPageId] = publishedRef.externalId.split('_')
  const pageId = metadataPageId || compoundPageId
  if (!pageId) {
    throw new ValidationError(`Cannot resolve Page id from externalId "${publishedRef.externalId}"`)
  }
  const pageAccessToken = await getPageAccessToken(payload, options, pageId)

  const response = await makeMetaRequest(
    payload,
    options,
    'facebook',
    `/${encodeURIComponent(publishedRef.externalId)}`,
    { accessToken: pageAccessToken, init: { method: 'DELETE' } },
  )
  if (!response.ok && response.status !== 404) {
    throw new ValidationError(
      `Facebook post delete failed: ${response.status} ${await response.text().catch(() => '')}`,
    )
  }
}
