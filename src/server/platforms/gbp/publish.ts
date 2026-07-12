import type { Payload, PayloadRequest } from 'payload'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../types/index.js'

import { GBP_SUMMARY_MAX_CHARS, SOCIAL_POSTS_SLUG } from '../../../constants.js'
import { PlatformApiError, ValidationError } from '../../utilities/errors.js'
import { sha256Hex } from '../../utilities/hash.js'
import { GBP_HOSTS, gbpJson, makeGbpRequest } from './api.js'
import { buildDefaultGbpSummary } from './copy.js'

/**
 * GBP LocalPost publish path.
 *
 * Supports all four documented topic types (CLAUDE.md §5.5):
 *
 *   STANDARD : summary + optional CTA + optional media
 *   EVENT    : adds `event` { title, schedule { startDate/startTime, endDate/endTime } }
 *   OFFER    : adds `event` AND `offer` { couponCode, redeemOnlineUrl, termsConditions }
 *              — DO NOT send `callToAction` (API rejects it)
 *   ALERT    : adds `alertType` (`COVID_19` is the only documented value)
 *
 * Idempotency key:
 *   sha256("gbp:" + sourceKind + ":" + sourceId + ":" + accountId + ":" + locationId + ":" + topicType)
 *
 * Notes from CLAUDE.md §5.9:
 *   - Per-location quota soft-caps around 1 post/day; bursts get queued.
 *   - Only one active OFFER per location is featured at a time.
 *   - Post-creation moderation runs async: state transitions PROCESSING → LIVE
 *     in seconds-to-minutes; REJECTED returns NO reason via API. The publish
 *     path returns the LIVE/PROCESSING/SCHEDULED state in `meta` so the
 *     admin UI can surface "manual check on Business Profile dashboard" hints.
 */

export const TOPIC_TYPES = ['STANDARD', 'EVENT', 'OFFER', 'ALERT'] as const
export type GbpTopicType = (typeof TOPIC_TYPES)[number]

export const CTA_ACTION_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'] as const
export type GbpCtaActionType = (typeof CTA_ACTION_TYPES)[number]

export type GbpEventSchedule = {
  endDate: { day: number; month: number; year: number }
  endTime?: { hours?: number; minutes?: number }
  startDate: { day: number; month: number; year: number }
  startTime?: { hours?: number; minutes?: number }
}

export type GbpPublishInput = {
  /** Required when `topicType === 'ALERT'`. */
  alertType?: 'COVID_19'
  /** Call-to-action. Required for STANDARD if you want a button; not allowed for OFFER. */
  callToAction?: {
    actionType: GbpCtaActionType
    /** Required UNLESS `actionType === 'CALL'`. */
    url?: string
  }
  /** Required when `topicType` is EVENT or OFFER. */
  event?: {
    schedule: GbpEventSchedule
    title: string
  }
  /** Optional public image URL Google fetches. */
  imageUrl?: string
  /** Optional override for the language code (BCP-47). Defaults to location's. */
  languageCode?: string
  /** `accounts/{a}/locations/{l}` — the plugin's `GbpLocation.resourceName`. */
  locationResourceName: string
  /** Required when `topicType === 'OFFER'`. */
  offer?: {
    couponCode?: string
    redeemOnlineUrl?: string
    termsConditions?: string
  }
  publishedByUserId?: number | string
  /** Body. Falls back to host copyOverride / default builder. */
  summary?: string
  /** Topic. Default `STANDARD`. */
  topicType?: GbpTopicType
}

type GbpLocalPostMedia = { mediaFormat: 'PHOTO' | 'VIDEO'; sourceUrl: string }

type GbpLocalPostBody = {
  alertType?: GbpPublishInput['alertType']
  callToAction?: { actionType: GbpCtaActionType; url?: string }
  event?: GbpPublishInput['event']
  languageCode?: string
  media?: GbpLocalPostMedia[]
  offer?: GbpPublishInput['offer']
  summary: string
  topicType: GbpTopicType
}

type GbpLocalPostResponse = {
  media?: Array<{ googleUrl?: string; mediaFormat?: string; sourceUrl?: string }>
  name: string
  searchUrl?: string
  state?: string
  topicType?: string
}

type SocialPostRow = {
  attempts?: number
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  status: 'cancelled' | 'draft' | 'failed' | 'published' | 'publishing' | 'queued'
}

const validateLocationResource = (name: string): { accountId: string; locationId: string } => {
  const match = name.match(/^accounts\/([^/]+)\/locations\/([^/]+)$/)
  if (!match) {
    throw new ValidationError(
      `locationResourceName must be of the form "accounts/{a}/locations/{l}"; got "${name}"`,
    )
  }
  return { accountId: match[1], locationId: match[2] }
}

const buildIdempotencyKey = (
  ctx: SocialSourceContext,
  accountId: string,
  locationId: string,
  topicType: GbpTopicType,
): string =>
  sha256Hex(`gbp:${ctx.sourceKind}:${ctx.sourceId}:${accountId}:${locationId}:${topicType}`)

/**
 * Pure derivation of the GBP idempotency identity — identical logic to
 * the publish path. Exported for parity testing against `buildPublicationIdentity`.
 */
export const deriveGbpIdentity = (
  ctx: SocialSourceContext,
  input: GbpPublishInput,
): { idempotencyKey: string; primaryAssetUrl: string } => {
  const { accountId, locationId } = validateLocationResource(input.locationResourceName)
  const topicType: GbpTopicType = input.topicType ?? 'STANDARD'
  return {
    idempotencyKey: buildIdempotencyKey(ctx, accountId, locationId, topicType),
    primaryAssetUrl: input.imageUrl ?? '',
  }
}

const buildSourceHash = (snapshot: GbpLocalPostBody): string => sha256Hex(JSON.stringify(snapshot))

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

const validateInput = (input: GbpPublishInput, summary: string, topicType: GbpTopicType): void => {
  if (!summary.trim()) {
    throw new ValidationError('summary is required')
  }
  if (summary.length > GBP_SUMMARY_MAX_CHARS) {
    throw new ValidationError(
      `summary exceeds ${GBP_SUMMARY_MAX_CHARS} chars (got ${summary.length})`,
    )
  }

  if (topicType === 'OFFER' || topicType === 'EVENT') {
    if (!input.event) {
      throw new ValidationError(`${topicType} posts require an event block`)
    }
    if (!input.event.title?.trim()) {
      throw new ValidationError('event.title is required')
    }
    const { endDate, startDate } = input.event.schedule
    if (!startDate || !endDate) {
      throw new ValidationError('event.schedule.startDate and endDate are required')
    }
    const start = new Date(startDate.year, startDate.month - 1, startDate.day).getTime()
    const end = new Date(endDate.year, endDate.month - 1, endDate.day).getTime()
    if (end < start) {
      throw new ValidationError('event end must be after event start')
    }
  }

  if (topicType === 'OFFER') {
    if (input.callToAction) {
      throw new ValidationError(
        'OFFER posts cannot include callToAction (use offer.redeemOnlineUrl)',
      )
    }
    if (!input.offer) {
      throw new ValidationError('OFFER posts require an offer block')
    }
  }

  if (topicType === 'ALERT') {
    if (!input.alertType) {
      throw new ValidationError('ALERT posts require alertType (e.g. "COVID_19")')
    }
    if (input.imageUrl) {
      throw new ValidationError('ALERT posts cannot include media')
    }
  }

  if (input.callToAction) {
    if (input.callToAction.actionType !== 'CALL' && !input.callToAction.url) {
      throw new ValidationError(
        `callToAction.url is required for actionType "${input.callToAction.actionType}"`,
      )
    }
  }
}

export type GbpPublishResult = {
  alreadyExisted: boolean
  postId: number | string
  publishedRef: PublishedRef
  state: string
}

export const publishGbpLocalPost = async (args: {
  ctx: SocialSourceContext
  input: GbpPublishInput
  options: NormalizedPluginOptions
  payload: Payload
  req?: PayloadRequest
}): Promise<GbpPublishResult> => {
  const { ctx, input, options, payload } = args
  if (!input.locationResourceName) {
    throw new ValidationError('locationResourceName is required')
  }
  const { accountId, locationId } = validateLocationResource(input.locationResourceName)
  const topicType: GbpTopicType = input.topicType ?? 'STANDARD'

  const fallback = options.copyOverrides.gbpSummary?.(ctx) ?? buildDefaultGbpSummary(ctx)
  const summary = (input.summary?.trim() || fallback).slice(0, GBP_SUMMARY_MAX_CHARS)

  validateInput(input, summary, topicType)

  const idempotencyKey = buildIdempotencyKey(ctx, accountId, locationId, topicType)
  const existing = await findExistingByIdempotencyKey(payload, idempotencyKey)
  if (existing && existing.status === 'published' && existing.externalId) {
    return {
      alreadyExisted: true,
      postId: existing.id,
      publishedRef: {
        externalId: existing.externalId,
        externalUrl: existing.externalUrl ?? undefined,
        platform: 'gbp',
      },
      state: 'LIVE',
    }
  }

  const body: GbpLocalPostBody = {
    languageCode: input.languageCode,
    summary,
    topicType,
  }
  if (input.imageUrl) {
    body.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.imageUrl }]
  }
  if (topicType !== 'OFFER' && input.callToAction) {
    body.callToAction = input.callToAction
  }
  if (input.event) {
    body.event = input.event
  }
  if (topicType === 'OFFER' && input.offer) {
    body.offer = input.offer
  }
  if (topicType === 'ALERT' && input.alertType) {
    body.alertType = input.alertType
  }

  const url = `${GBP_HOSTS.legacyV4}/v4/${input.locationResourceName}/localPosts`
  const response = await gbpJson<GbpLocalPostResponse>(payload, options, url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.name) {
    throw new PlatformApiError({
      message: 'GBP localPosts.create returned no name',
      platform: 'gbp',
      raw: response,
      retryable: false,
      statusCode: 502,
    })
  }

  const sourceHash = buildSourceHash(body)
  const state = response.state ?? 'PROCESSING'
  const baseFields = {
    attempts:
      (existing as unknown as { attempts?: number })?.attempts !== undefined
        ? Number((existing as unknown as { attempts?: number }).attempts) + 1
        : 1,
    body: summary,
    destination: {
      id: input.locationResourceName,
      label: undefined as string | undefined,
      meta: { accountId, locationId, topicType },
    },
    externalId: response.name,
    externalUrl: response.searchUrl,
    idempotencyKey,
    imageUrl: input.imageUrl,
    lastAttemptedAt: new Date().toISOString(),
    lastError: null,
    link: input.callToAction?.url ?? input.offer?.redeemOnlineUrl ?? ctx.link,
    meta: {
      raw: response,
      state,
      topicType,
    },
    platform: 'gbp' as const,
    platformPublicationStatus: state === 'LIVE' ? 'published' : 'publishing',
    publishedAt: new Date().toISOString(),
    publishedBy: input.publishedByUserId,
    sourceHash,
    sourceId: ctx.sourceId,
    sourceKind: ctx.sourceKind,
    status: 'published' as const,
    title: input.event?.title ?? ctx.baseTitle,
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
      externalId: response.name,
      externalUrl: response.searchUrl,
      meta: { accountId, locationId, state, topicType },
      platform: 'gbp',
    },
    state,
  }
}

/**
 * Soft-delete a GBP LocalPost. Mirrors the Pinterest deletion contract:
 * delete remotely (idempotent — 404 = already gone) and flip the local
 * `social-posts` row to `cancelled`. NEVER hard-delete the row.
 */
export const deleteGbpLocalPost = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<void> => {
  const { options, payload, publishedRef } = args
  if (publishedRef.platform !== 'gbp') {
    throw new ValidationError(`Cannot delete: publishedRef is for ${publishedRef.platform}`)
  }
  if (!publishedRef.externalId) {
    return
  }

  // externalId is the full `accounts/{a}/locations/{l}/localPosts/{p}` resource name.
  const response = await makeGbpRequest(
    payload,
    options,
    `${GBP_HOSTS.legacyV4}/v4/${publishedRef.externalId}`,
    { init: { method: 'DELETE' } },
  )

  if (!response.ok && response.status !== 404) {
    throw new ValidationError(
      `GBP localPost delete failed: ${response.status} ${await response.text().catch(() => '')}`,
    )
  }

  // Flip local row to cancelled (best-effort).
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      externalId: { equals: publishedRef.externalId },
      platform: { equals: 'gbp' },
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

/**
 * Polls `GET /v4/{name}` until state transitions out of PROCESSING (or hits
 * the timeout). Returns the final state — typically LIVE or REJECTED.
 *
 * Plugin callers use this after publish to surface real moderation status
 * in the admin UI. CLAUDE.md §5.8 notes Google does NOT expose rejection
 * reasons via API — admins must check the GBP dashboard manually.
 */
export const pollGbpLocalPostState = async (args: {
  /** Poll interval in milliseconds. Default 5 seconds. */
  intervalMs?: number
  /** Max time to poll in milliseconds. Default 30 seconds. */
  maxWaitMs?: number
  options: NormalizedPluginOptions
  payload: Payload
  postName: string
}): Promise<{ searchUrl?: string; state: string }> => {
  const maxWaitMs = args.maxWaitMs ?? 30_000
  const intervalMs = args.intervalMs ?? 5_000
  const deadline = Date.now() + maxWaitMs
  const url = `${GBP_HOSTS.legacyV4}/v4/${args.postName}`

  while (true) {
    const post = await gbpJson<GbpLocalPostResponse>(args.payload, args.options, url)
    const state = post.state ?? 'PROCESSING'
    if (state !== 'PROCESSING') {
      return { searchUrl: post.searchUrl, state }
    }
    if (Date.now() >= deadline) {
      return { searchUrl: post.searchUrl, state }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
