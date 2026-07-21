import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'

import { PLATFORM_IDS, SOCIAL_POSTS_SLUG } from '../../constants.js'
import { scheduleSocialPostPublish } from '../../plugin/jobQueue.js'
import { buildSocialDraft } from '../compose/socialDraft.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { queuePublicationReconciliation } from '../services/publicationReconciliation.js'
import {
  failPublicationReservation,
  reservePublication,
} from '../services/publicationReservation.js'
import { resolveSourceContext } from '../sources/registry.js'
import { assertAccess } from '../utilities/access.js'
import { NotFoundError, ValidationError } from '../utilities/errors.js'
import { sha256Hex } from '../utilities/hash.js'
import { errorResponse, getRouteParam, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { buildPublicationIdentity } from '../utilities/publicationIdentity.js'
import { requireIdentifier, requireOneOf, requireString } from '../utilities/validation.js'

const isFutureIso = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    return false
  }
  return ms > Date.now() + 60_000 // require >=60s in the future
}

/**
 * Return true when `value` is a non-empty ISO string that parses to a
 * timestamp. Used to detect a scheduledAt that was supplied but is NOT in the
 * future (past or within the 60 s buffer).
 */
const isParsableIso = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false
  }
  const ms = Date.parse(value)
  return !Number.isNaN(ms)
}

/**
 * Three source-polymorphic endpoints, mounted once per `(platform, sourceKind)`:
 *
 *   GET  {basePath}/:platform/:sourceKind/:sourceId/preview
 *   POST {basePath}/:platform/:sourceKind/:sourceId/publish
 *   GET  {basePath}/:platform/:sourceKind/:sourceId/history
 *
 * The plugin doesn't mount Pinterest-specific routes for preview/publish —
 * the same path serves every platform, dispatched by `:platform`.
 */

const PLATFORM_PARAM = ':platform'
const KIND_PARAM = ':sourceKind'
const ID_PARAM = ':sourceId'

const ensurePlatformEnabled = (options: NormalizedPluginOptions, platform: PlatformId): void => {
  if (!options.platforms[platform].enabled) {
    throw new NotFoundError(`platform "${platform}" is not enabled`)
  }
}

export const createPreviewEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const platform = requireOneOf(getRouteParam(req, 'platform'), PLATFORM_IDS, 'platform')
      const sourceKind = requireString(getRouteParam(req, 'sourceKind'), 'sourceKind')
      const sourceId = requireIdentifier(getRouteParam(req, 'sourceId'), 'sourceId')

      ensurePlatformEnabled(options, platform)

      const ctx = await resolveSourceContext({
        id: sourceId,
        kind: sourceKind,
        payload: req.payload,
        req,
        sources: options.sources,
      })
      const adapter = getPlatformAdapter(platform, options)
      const preview = await adapter.preview({ ctx, options, payload: req.payload, req })

      return jsonResponse({
        capabilities: adapter.capabilities,
        draft: buildSocialDraft(ctx),
        platform,
        preview,
        source: { id: String(sourceId), kind: sourceKind },
      })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/${PLATFORM_PARAM}/${KIND_PARAM}/${ID_PARAM}/preview`,
})

export const createValidateEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const platform = requireOneOf(getRouteParam(req, 'platform'), PLATFORM_IDS, 'platform')
      const sourceKind = requireString(getRouteParam(req, 'sourceKind'), 'sourceKind')
      const sourceId = requireIdentifier(getRouteParam(req, 'sourceId'), 'sourceId')

      ensurePlatformEnabled(options, platform)
      const input = await parseRequestBody(req)
      const ctx = await resolveSourceContext({
        id: sourceId,
        kind: sourceKind,
        payload: req.payload,
        req,
        sources: options.sources,
      })
      const adapter = getPlatformAdapter(platform, options)
      const validation = await adapter.validate({ ctx, input, options })

      return jsonResponse({ platform, validation })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/${PLATFORM_PARAM}/${KIND_PARAM}/${ID_PARAM}/validate`,
})

export const createPublishEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const platform = requireOneOf(getRouteParam(req, 'platform'), PLATFORM_IDS, 'platform')
      const sourceKind = requireString(getRouteParam(req, 'sourceKind'), 'sourceKind')
      const sourceId = requireIdentifier(getRouteParam(req, 'sourceId'), 'sourceId')

      ensurePlatformEnabled(options, platform)

      const body = await parseRequestBody(req)
      // `scheduledAt` is plugin-level metadata, not adapter-level — strip it
      // out before validation/publish so adapters never see it. The
      // remaining fields are the per-adapter publish input.
      const { scheduledAt: rawScheduledAt, ...adapterInput } = body

      // Never reinterpret an invalid schedule as an immediate public mutation.
      if (rawScheduledAt !== undefined && rawScheduledAt !== null && rawScheduledAt !== '') {
        if (!isFutureIso(rawScheduledAt)) {
          const detail = isParsableIso(rawScheduledAt)
            ? 'The scheduled time is in the past or too close to now (must be at least 60 seconds in the future).'
            : 'The scheduledAt value is not a valid ISO-8601 date-time string.'
          throw new ValidationError(
            `${detail} Pick a future time or omit scheduledAt to publish immediately.`,
          )
        }
      }

      const ctx = await resolveSourceContext({
        id: sourceId,
        kind: sourceKind,
        payload: req.payload,
        req,
        sources: options.sources,
      })
      const adapter = getPlatformAdapter(platform, options)
      const validation = await adapter.validate({
        ctx,
        input: adapterInput,
        options,
      })
      if (!validation.ok) {
        const errors = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')
        throw new ValidationError(errors || 'Input invalid')
      }

      // ── Scheduled path ──────────────────────────────────────────
      // When `scheduledAt` is a future timestamp, snapshot the input
      // into a `social-posts` row with status='queued' and queue the
      // publish task via `payload.jobs.queue({ waitUntil })`. The
      // host's worker (Payload autoRun OR external cron hitting our
      // internal endpoints) drains the queue and the task replays the
      // adapter publish path against the snapshotted input.
      if (isFutureIso(rawScheduledAt)) {
        const { destinationId, idempotencyKey, primaryAssetUrl } = buildPublicationIdentity({
          ctx,
          input: adapterInput,
          platform,
          sourceId: String(sourceId),
          sourceKind,
        })
        const sourceHash = sha256Hex(
          JSON.stringify({ adapterInput, platform, scheduledAt: rawScheduledAt }),
        )
        const result = await scheduleSocialPostPublish({
          destination: { id: destinationId },
          idempotencyKey,
          imageUrl: primaryAssetUrl,
          link: ctx.link,
          options,
          payload: req.payload,
          platform,
          publishedByUserId:
            req.user && typeof (req.user as { id?: number | string }).id !== 'undefined'
              ? (req.user as { id: number | string }).id
              : undefined,
          queuedInput: adapterInput,
          req,
          scheduledAt: rawScheduledAt,
          sourceHash,
          sourceId: String(sourceId),
          sourceKind,
          title: ctx.baseTitle,
        })
        return jsonResponse({
          alreadyPublished: result.alreadyPublished ?? false,
          externalId: result.externalId,
          jobId: result.jobId,
          platform,
          postId: result.postId,
          scheduled: !result.alreadyPublished,
          scheduledAt: result.scheduledAt,
          source: { id: String(sourceId), kind: sourceKind },
        })
      }

      // ── Immediate path ─────────────────────────────────────────
      const identity = buildPublicationIdentity({
        ctx,
        input: adapterInput,
        platform,
        sourceId: String(sourceId),
        sourceKind,
      })
      const reservation = await reservePublication({
        destinationId: identity.destinationId,
        idempotencyKey: identity.idempotencyKey,
        imageUrl: identity.primaryAssetUrl,
        payload: req.payload,
        platform,
        sourceHash: sha256Hex(JSON.stringify({ adapterInput, platform })),
        sourceId: String(sourceId),
        sourceKind,
        title: ctx.baseTitle,
      })
      let ref = reservation.publishedRef
      if (!ref) {
        try {
          ref = await adapter.publish({
            ctx,
            input: adapterInput as never,
            options,
            payload: req.payload,
            postId: reservation.postId,
            req,
          })
        } catch (error) {
          await failPublicationReservation(req.payload, reservation, error)
          throw error
        }
      }
      await queuePublicationReconciliation({
        payload: req.payload,
        postId: reservation.postId,
        publishedRef: ref,
        req,
      })
      return jsonResponse({
        platform,
        publishedRef: ref,
        source: { id: String(sourceId), kind: sourceKind },
      })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/${PLATFORM_PARAM}/${KIND_PARAM}/${ID_PARAM}/publish`,
})

export const createHistoryEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const platform = requireOneOf(getRouteParam(req, 'platform'), PLATFORM_IDS, 'platform')
      const sourceKind = requireString(getRouteParam(req, 'sourceKind'), 'sourceKind')
      const sourceId = requireIdentifier(getRouteParam(req, 'sourceId'), 'sourceId')

      const result = await req.payload.find({
        collection: SOCIAL_POSTS_SLUG as never,
        depth: 0,
        limit: 50,
        overrideAccess: true,
        sort: '-publishedAt',
        where: {
          and: [
            { platform: { equals: platform } },
            { sourceKind: { equals: sourceKind } },
            { sourceId: { equals: String(sourceId) } },
          ],
        },
      })

      type RawDoc = Record<string, unknown>
      const posts = (result.docs as RawDoc[]).map((doc) => ({
        id: doc.id,
        externalId: doc.externalId,
        externalUrl: doc.externalUrl,
        publishedAt: doc.publishedAt,
        scheduledAt: doc.scheduledAt ?? null,
        status: doc.status,
        title: doc.title,
      }))

      return jsonResponse({
        platform,
        posts,
        source: { id: String(sourceId), kind: sourceKind },
        total: result.totalDocs,
      })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/${PLATFORM_PARAM}/${KIND_PARAM}/${ID_PARAM}/history`,
})

export const createSourcePublishEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  createPreviewEndpoint(options),
  createValidateEndpoint(options),
  createPublishEndpoint(options),
  createHistoryEndpoint(options),
]
