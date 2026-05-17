import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { PLATFORM_IDS } from '../../constants.js'
import {
  queueSocialConnectionRefresh,
  queueSocialInsightsRefresh,
  queueSocialPostRetry,
  queueSocialPostSweep,
  runQueuedSocialsJobs,
  sweepDueSocialPosts,
} from '../../plugin/jobQueue.js'
import { assertSchedulerApiKey } from '../utilities/apiKeyAuth.js'
import { ValidationError } from '../utilities/errors.js'
import { errorResponse, getRouteParam, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { requireIdentifier, requireOneOf, requirePositiveInteger } from '../utilities/validation.js'

/**
 * Internal scheduler endpoints — the HTTP surface external orchestrators
 * (AWS EventBridge, Vercel cron, GitHub Actions, fly machines, etc.)
 * call to trigger plugin-owned work. Gated by a pre-shared API key the
 * host configures via `scheduling.internalApiKey`.
 *
 *   POST /socials/internal/jobs/sweep           — sweep due posts + drain queue
 *   POST /socials/internal/jobs/run             — drain queue (no sweep)
 *   POST /socials/internal/jobs/queue/:taskSlug — queue a specific task with body as input
 *   POST /socials/internal/posts/:postId/retry  — retry a specific failed/cancelled post
 *   POST /socials/internal/insights/refresh     — fire insights refresh now
 *   POST /socials/internal/connections/refresh  — fire connection refresh now
 *
 * Mounted unconditionally — even hosts using Payload's native autoRun
 * benefit from having a manual "force a run now" endpoint for incident
 * response. The endpoint will simply reject with 401 if `internalApiKey`
 * is not configured.
 */

const ALLOWED_TASK_SLUGS = [
  'socialPostPublish',
  'socialPostRetry',
  'socialPostSweep',
  'socialInsightsRefresh',
  'socialConnectionRefresh',
] as const

const createSweepEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      const sweep = await sweepDueSocialPosts(req.payload, options, req)
      // Drain after sweeping so a single external cron tick can fire both
      // the queue insertion AND the queue drain. Hosts on Payload's native
      // autoRun don't need this — Payload drains the queue itself.
      await runQueuedSocialsJobs(req.payload, options, req)
      return jsonResponse({ ok: true, sweep })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/jobs/sweep`,
})

const createRunEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      await runQueuedSocialsJobs(req.payload, options, req)
      return jsonResponse({ ok: true })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/jobs/run`,
})

const createQueueTaskEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      const taskSlug = requireOneOf(getRouteParam(req, 'taskSlug'), ALLOWED_TASK_SLUGS, 'taskSlug')
      const body = await parseRequestBody(req)

      let jobId: number | string | undefined
      switch (taskSlug) {
        case 'socialPostSweep':
          jobId = await queueSocialPostSweep({
            limit: typeof body.limit === 'number' ? body.limit : undefined,
            payload: req.payload,
            req,
          })
          break
        case 'socialPostRetry':
          jobId = await queueSocialPostRetry({
            payload: req.payload,
            postId: requireIdentifier(body.postId, 'postId'),
            req,
          })
          break
        case 'socialInsightsRefresh': {
          const platform =
            typeof body.platform === 'string'
              ? requireOneOf(body.platform, PLATFORM_IDS, 'platform')
              : undefined
          jobId = await queueSocialInsightsRefresh({
            limit: typeof body.limit === 'number' ? body.limit : undefined,
            payload: req.payload,
            platform,
            req,
            windowSeconds: typeof body.windowSeconds === 'number' ? body.windowSeconds : undefined,
          })
          break
        }
        case 'socialConnectionRefresh': {
          const platform =
            typeof body.platform === 'string'
              ? requireOneOf(body.platform, PLATFORM_IDS, 'platform')
              : undefined
          jobId = await queueSocialConnectionRefresh({
            payload: req.payload,
            platform,
            req,
            windowSeconds: typeof body.windowSeconds === 'number' ? body.windowSeconds : undefined,
          })
          break
        }
        case 'socialPostPublish':
          throw new ValidationError(
            'socialPostPublish cannot be queued directly via this endpoint — ' +
              'schedule a publish via POST /:platform/:sourceKind/:sourceId/publish with scheduledAt instead.',
          )
        default: {
          const _exhaustive: never = taskSlug
          throw new ValidationError(`unknown taskSlug: ${String(_exhaustive)}`)
        }
      }
      return jsonResponse({ jobId, ok: true, taskSlug })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/jobs/queue/:taskSlug`,
})

const createRetryPostEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      const postId = requireIdentifier(getRouteParam(req, 'postId'), 'postId')
      const jobId = await queueSocialPostRetry({ payload: req.payload, postId, req })
      return jsonResponse({ jobId, ok: true, postId })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/posts/:postId/retry`,
})

const createInsightsRefreshEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      const body = (await parseRequestBody(req).catch(() => ({}))) as Record<string, unknown>
      const platform =
        typeof body.platform === 'string'
          ? requireOneOf(body.platform, PLATFORM_IDS, 'platform')
          : undefined
      const windowSeconds =
        typeof body.windowSeconds === 'number'
          ? requirePositiveInteger(body.windowSeconds, 'windowSeconds')
          : undefined
      const limit =
        typeof body.limit === 'number' ? requirePositiveInteger(body.limit, 'limit') : undefined
      const jobId = await queueSocialInsightsRefresh({
        limit,
        payload: req.payload,
        platform,
        req,
        windowSeconds,
      })
      await runQueuedSocialsJobs(req.payload, options, req)
      return jsonResponse({ jobId, ok: true })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/insights/refresh`,
})

const createConnectionRefreshEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      assertSchedulerApiKey(req, options)
      const body = (await parseRequestBody(req).catch(() => ({}))) as Record<string, unknown>
      const platform =
        typeof body.platform === 'string'
          ? requireOneOf(body.platform, PLATFORM_IDS, 'platform')
          : undefined
      const windowSeconds =
        typeof body.windowSeconds === 'number'
          ? requirePositiveInteger(body.windowSeconds, 'windowSeconds')
          : undefined
      const jobId = await queueSocialConnectionRefresh({
        payload: req.payload,
        platform,
        req,
        windowSeconds,
      })
      await runQueuedSocialsJobs(req.payload, options, req)
      return jsonResponse({ jobId, ok: true })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/internal/connections/refresh`,
})

export const createInternalSchedulerEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  createSweepEndpoint(options),
  createRunEndpoint(options),
  createQueueTaskEndpoint(options),
  createRetryPostEndpoint(options),
  createInsightsRefreshEndpoint(options),
  createConnectionRefreshEndpoint(options),
]
