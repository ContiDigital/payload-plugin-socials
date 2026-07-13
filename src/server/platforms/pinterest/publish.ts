import type { Payload, PayloadRequest } from 'payload'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../types/index.js'

import {
  PINTEREST_ALT_TEXT_MAX,
  PINTEREST_DESCRIPTION_MAX,
  PINTEREST_TITLE_MAX,
  SOCIAL_POSTS_SLUG,
} from '../../../constants.js'
import { resolvePlatformImageUrl } from '../../assets/resolvePlatformImage.js'
import { ValidationError } from '../../utilities/errors.js'
import { sha256Hex } from '../../utilities/hash.js'
import { pinterestJson } from './api.js'
import {
  buildDefaultPinterestAltText,
  buildDefaultPinterestDescription,
  buildDefaultPinterestHashtags,
  buildDefaultPinterestTitle,
} from './copy.js'
import { uploadPinterestVideoFromUrl } from './videoUpload.js'

/**
 * Pinterest publish path — the on-demand staff-driven flow extracted from
 * Fine's `src/lib/pinterest/manualPin.ts`.
 *
 * Idempotency:
 *   key = sha256("pinterest:" + sourceKind + ":" + sourceId + ":" + boardId + ":" + imageUrl)
 *
 * Same (kind, id, board, image) → identical key → "already published"
 * short-circuit. Different board OR different image → different key →
 * distinct pin record. A prior row with `status: 'cancelled'` is allowed
 * to be republished (status reset to `published`); the audit history
 * shows the most recent publish.
 *
 * NEVER hard-deletes a `social-posts` row — it's both audit AND idempotency
 * anchor. Cancellation flips `status: 'cancelled'`.
 *
 * Image conversion ordering (critical):
 *   idempotencyKey and primaryAssetUrl are derived from the ORIGINAL input
 *   imageUrl. resolvePlatformImageUrl is called ONLY when building the
 *   outbound Pinterest API request body. The converted URL never touches the
 *   key, primaryAssetUrl, sourceHash, or the reservation.
 */

export type PinterestPublishInput = {
  altText?: string
  boardId: string
  boardName?: string
  coverImageUrl?: string
  declaredImageFormat?: string
  description?: string
  imageUrl?: string
  link?: string
  mediaId?: string
  mediaType?: 'IMAGE' | 'VIDEO'
  publishedByUserId?: number | string
  title?: string
  videoUrl?: string
}

type PinResponse = {
  board_id?: string
  id?: string
  link?: string
}

type SocialPostRow = {
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  idempotencyKey: string
  status: 'cancelled' | 'draft' | 'failed' | 'published' | 'publishing' | 'queued'
}

const buildIdempotencyKey = (ctx: SocialSourceContext, boardId: string, imageUrl: string): string =>
  sha256Hex(`pinterest:${ctx.sourceKind}:${ctx.sourceId}:${boardId}:${imageUrl}`)

const buildSourceHash = (snapshot: {
  altText: string
  assetUrl: string
  boardId: string
  description: string
  link: string
  mediaType: 'IMAGE' | 'VIDEO'
  title: string
}): string =>
  sha256Hex(
    JSON.stringify({
      altText: snapshot.altText,
      assetUrl: snapshot.assetUrl,
      boardId: snapshot.boardId,
      description: snapshot.description,
      link: snapshot.link,
      mediaType: snapshot.mediaType,
      title: snapshot.title,
    }),
  )

const resolveDefaults = (
  ctx: SocialSourceContext,
  options: NormalizedPluginOptions,
): { altText: string; description: string; title: string } => {
  const o = options.copyOverrides
  return {
    altText: o.pinterestAltText?.(ctx) ?? buildDefaultPinterestAltText(ctx),
    description: o.pinterestDescription?.(ctx) ?? buildDefaultPinterestDescription(ctx),
    title: o.pinterestTitle?.(ctx) ?? buildDefaultPinterestTitle(ctx),
  }
}

export type PinterestPreview = {
  altText: string
  availableImages: SocialSourceContext['images']
  defaultImageUrl: string
  description: string
  hashtags: string[]
  link: string
  source: {
    id: string
    kind: string
    modelLabel?: null | string
    title: string
  }
  title: string
}

export const buildPinterestPreview = (
  ctx: SocialSourceContext,
  options: NormalizedPluginOptions,
): PinterestPreview => {
  const defaults = resolveDefaults(ctx, options)
  const defaultImage = ctx.images.find((img) => img.role === 'main') ?? ctx.images[0]
  const overrideHashtags = options.copyOverrides.pinterestHashtags?.(ctx)
  return {
    altText: defaults.altText,
    availableImages: ctx.images,
    defaultImageUrl: defaultImage?.url ?? '',
    description: defaults.description,
    hashtags: overrideHashtags ?? buildDefaultPinterestHashtags(ctx),
    link: ctx.link,
    source: {
      id: ctx.sourceId,
      kind: ctx.sourceKind,
      modelLabel: ctx.modelLabel,
      title: ctx.baseTitle,
    },
    title: defaults.title,
  }
}

/**
 * Pure derivation of the Pinterest idempotency identity — identical logic to
 * the publish path. Exported for parity testing against `buildPublicationIdentity`.
 */
export const derivePinterestIdentity = (
  ctx: SocialSourceContext,
  input: PinterestPublishInput,
): { idempotencyKey: string; primaryAssetUrl: string } => {
  const defaultImage = ctx.images.find((img) => img.role === 'main') ?? ctx.images[0]
  const mediaType = input.mediaType ?? 'IMAGE'
  const imageUrl = input.imageUrl?.trim() || defaultImage?.url || ''
  const videoUrl = input.videoUrl?.trim() || ctx.videos?.[0]?.url || ''
  const primaryAssetUrl = mediaType === 'VIDEO' ? videoUrl || input.mediaId?.trim() || '' : imageUrl
  return {
    idempotencyKey: buildIdempotencyKey(ctx, input.boardId, primaryAssetUrl),
    primaryAssetUrl,
  }
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
  const doc = result.docs[0] as SocialPostRow | undefined
  return doc ?? null
}

const createPin = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  body: {
    alt_text: string
    board_id: string
    description: string
    link: string
    media_source:
      | { cover_image_url: string; media_id: string; source_type: 'video_id' }
      | { source_type: 'image_url'; url: string }
    title: string
  },
): Promise<PinResponse> => {
  return pinterestJson<PinResponse>(payload, options, '/v5/pins', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}

export type PinterestPublishResult = {
  alreadyExisted: boolean
  postId: number | string
  publishedRef: PublishedRef
}

export const publishPinterestPin = async (args: {
  ctx: SocialSourceContext
  input: PinterestPublishInput
  options: NormalizedPluginOptions
  payload: Payload
  req?: PayloadRequest
}): Promise<PinterestPublishResult> => {
  const { ctx, input, options, payload } = args

  if (!input.boardId) {
    throw new ValidationError('boardId is required')
  }

  const preview = buildPinterestPreview(ctx, options)
  const title = (input.title?.trim() || preview.title).slice(0, PINTEREST_TITLE_MAX)
  const description = (input.description?.trim() || preview.description).slice(
    0,
    PINTEREST_DESCRIPTION_MAX,
  )
  const altText = (input.altText?.trim() || preview.altText).slice(0, PINTEREST_ALT_TEXT_MAX)
  const link = input.link?.trim() || preview.link
  const mediaType = input.mediaType ?? 'IMAGE'

  // Resolve the ORIGINAL asset URLs — these are the source-of-truth for
  // idempotency. They must not be modified by image conversion.
  const imageUrl = input.imageUrl?.trim() || preview.defaultImageUrl
  const videoUrl = input.videoUrl?.trim() || ctx.videos?.[0]?.url || ''
  const coverImageUrl = input.coverImageUrl?.trim() || ctx.videos?.[0]?.coverImageUrl || imageUrl

  // primaryAssetUrl is derived from the ORIGINAL input, in lockstep with
  // buildPublicationIdentity and derivePinterestIdentity.
  const primaryAssetUrl = mediaType === 'VIDEO' ? videoUrl || input.mediaId?.trim() || '' : imageUrl

  if (mediaType === 'IMAGE' && !imageUrl) {
    throw new ValidationError('No image available for this source')
  }
  if (mediaType === 'VIDEO' && !videoUrl && !input.mediaId?.trim()) {
    throw new ValidationError('Video Pins require videoUrl or a previously uploaded mediaId')
  }
  if (mediaType === 'VIDEO' && !coverImageUrl) {
    throw new ValidationError('Video Pins require coverImageUrl')
  }
  if (!link) {
    throw new ValidationError('Outbound link is required')
  }
  if (!title) {
    throw new ValidationError('Pin title is required')
  }

  // Derive idempotency key from the ORIGINAL primaryAssetUrl — identical to
  // buildPublicationIdentity. This happens BEFORE any image conversion.
  const idempotencyKey = buildIdempotencyKey(ctx, input.boardId, primaryAssetUrl)
  const existing = await findExistingByIdempotencyKey(payload, idempotencyKey)

  if (existing && existing.status === 'published' && existing.externalId) {
    return {
      alreadyExisted: true,
      postId: existing.id,
      publishedRef: {
        externalId: existing.externalId,
        externalUrl: existing.externalUrl ?? undefined,
        platform: 'pinterest',
      },
    }
  }
  // A `cancelled` row indicates the pin was explicitly removed by staff —
  // fall through and republish, overwriting the same row so the audit
  // history shows the most recent publish.

  // sourceHash is computed from the ORIGINAL primaryAssetUrl, never the
  // converted one.
  const sourceHash = buildSourceHash({
    altText,
    assetUrl: primaryAssetUrl,
    boardId: input.boardId,
    description,
    link,
    mediaType,
    title,
  })

  const mediaId =
    mediaType === 'VIDEO'
      ? input.mediaId?.trim() ||
        (await uploadPinterestVideoFromUrl({
          options,
          payload,
          videoUrl,
        }))
      : undefined

  // --- Image conversion: happens ONLY when building the outbound body ---
  // The converted URL is used exclusively for the Pinterest API request.
  // It never touches idempotencyKey, primaryAssetUrl, or sourceHash.
  const assetsOptions =
    (
      options as unknown as {
        assets?: { autoConvert?: boolean; preflight?: boolean; uploadCollection?: string }
      }
    ).assets ?? {}
  const outboundImageUrl =
    mediaType === 'IMAGE'
      ? (
          await resolvePlatformImageUrl({
            declaredFormat: input.declaredImageFormat,
            imageUrl,
            options: assetsOptions,
            payload,
            platform: 'pinterest',
          })
        ).url
      : imageUrl

  const pin = await createPin(payload, options, {
    alt_text: altText,
    board_id: input.boardId,
    description,
    link,
    media_source:
      mediaType === 'VIDEO'
        ? {
            cover_image_url: coverImageUrl,
            media_id: mediaId ?? '',
            source_type: 'video_id',
          }
        : { source_type: 'image_url', url: outboundImageUrl },
    title,
  })

  const pinId = pin.id ?? ''
  const pinUrl = pin.link || (pinId ? `https://www.pinterest.com/pin/${pinId}/` : undefined)

  const baseFields = {
    altText,
    attempts: (existing as unknown as { attempts?: number })?.attempts
      ? Number((existing as unknown as { attempts?: number }).attempts) + 1
      : 1,
    body: description,
    destination: {
      id: input.boardId,
      label: input.boardName ?? undefined,
    },
    externalId: pinId,
    externalUrl: pinUrl,
    idempotencyKey,
    imageUrl: mediaType === 'VIDEO' ? coverImageUrl : imageUrl,
    lastAttemptedAt: new Date().toISOString(),
    lastError: null,
    link,
    meta: {
      boardName: input.boardName,
      mediaId,
      mediaType,
      videoUrl: mediaType === 'VIDEO' ? videoUrl : undefined,
    },
    platform: 'pinterest' as const,
    platformPublicationStatus: 'published' as const,
    publishedAt: new Date().toISOString(),
    publishedBy: input.publishedByUserId,
    sourceHash,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    status: 'published' as const,
    title,
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
      externalId: pinId,
      externalUrl: pinUrl,
      meta: {
        boardId: input.boardId,
        boardName: input.boardName,
        mediaId,
        mediaType,
      },
      platform: 'pinterest',
    },
  }
}

/**
 * Soft-delete a pin: deletes on Pinterest's side AND flips the local
 * `social-posts` row to `cancelled`. The row stays in the database — it
 * is both the audit record AND the idempotency anchor for any future
 * republish to the same `(source, board, image)` tuple.
 */
export const deletePinterestPin = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<void> => {
  const { options, payload, publishedRef } = args
  if (publishedRef.platform !== 'pinterest') {
    throw new ValidationError(`Cannot delete: publishedRef is for ${publishedRef.platform}`)
  }
  if (!publishedRef.externalId) {
    return
  } // Nothing to do.

  const { makePinterestRequest } = await import('./api.js')
  const response = await makePinterestRequest(
    payload,
    options,
    `/v5/pins/${encodeURIComponent(publishedRef.externalId)}`,
    { init: { method: 'DELETE' } },
  )

  // 204 success or 404 already-gone are both idempotent successes.
  if (!response.ok && response.status !== 404) {
    throw new ValidationError(
      `Pinterest pin delete failed: ${response.status} ${await response.text().catch(() => '')}`,
    )
  }

  // Flip local row to cancelled (best-effort lookup by externalId).
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      externalId: { equals: publishedRef.externalId },
      platform: { equals: 'pinterest' },
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
