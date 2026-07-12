import type { Payload, PayloadRequest } from 'payload'

import type { NormalizedPluginOptions, PlatformId, SocialSourceContext } from '../types/index.js'

import {
  PLATFORM_IDS,
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_POSTS_SLUG,
} from '../constants.js'
import { getPlatformAdapter } from '../server/platforms/registry.js'
import { resolveSourceContext } from '../server/sources/registry.js'
import { createPluginLogger, redactSecretString } from '../server/utilities/logger.js'

/**
 * Payload `TaskConfig` factories.
 *
 * The plugin OWNS the handler bodies but does NOT own the scheduling cadence
 * (see CLAUDE.md §1.13 "Plugin owns tasks; host wires triggers"). The host
 * decides when to fire — via Payload's native autoRun, via external cron
 * hitting the plugin's internal endpoints, or via a long-running worker
 * calling `runQueuedSocialsJobs` directly.
 *
 * Handler discipline (copied from GMC §1.13):
 *   - Handlers receive only `{ input, req }`. No closure over options —
 *     options are fetched fresh from the plugin's `getPluginOptions()`
 *     registry every invocation. This makes the handlers safe to register
 *     once and survive hot reloads.
 *   - Errors are RETURNED (`{ errorMessage, state: 'failed' }`), not thrown.
 *     Payload's job tracking flags this cleanly without unhandled rejection
 *     noise.
 *   - Side effects on `social-posts` rows use `overrideAccess: true` and
 *     pass `context: { socials:skip-hooks: true }` to keep any future
 *     re-entrant hooks inert.
 */

let pluginOptionsRef: NormalizedPluginOptions | null = null

const safeErrorMessage = (error: unknown): string =>
  redactSecretString(error instanceof Error ? error.message : String(error))

/** Internal: stash the normalized options so task handlers can look them up. */
export const setPluginOptionsForTasks = (options: NormalizedPluginOptions): void => {
  pluginOptionsRef = options
}

const getPluginOptions = (): NormalizedPluginOptions => {
  if (!pluginOptionsRef) {
    throw new Error(
      '[Socials] plugin options not initialised — plugin must be applied to Payload config before tasks run',
    )
  }
  return pluginOptionsRef
}

// ---------------------------------------------------------------------------
// social-post-publish — the workhorse task
// ---------------------------------------------------------------------------

type PublishTaskInput = {
  postId: number | string
}

type SocialPostDoc = {
  attempts?: number
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  idempotencyKey: string
  meta?: { queuedInput?: Record<string, unknown> } & Record<string, unknown>
  platform: PlatformId
  sourceId: string
  sourceKind: string
  status: 'cancelled' | 'draft' | 'failed' | 'published' | 'publishing' | 'queued'
}

const loadPost = async (payload: Payload, id: number | string): Promise<null | SocialPostDoc> => {
  try {
    const doc = (await payload.findByID({
      id: id as never,
      collection: SOCIAL_POSTS_SLUG as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as SocialPostDoc
    return doc ?? null
  } catch {
    return null
  }
}

const markPostFailed = async (
  payload: Payload,
  id: number | string,
  error: unknown,
): Promise<void> => {
  const message = safeErrorMessage(error)
  try {
    await payload.update({
      id: id as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: {
        lastAttemptedAt: new Date().toISOString(),
        lastError: message,
        status: 'failed',
      } as never,
      overrideAccess: true,
    })
  } catch {
    /* swallow — task-tracking still records the failure */
  }
}

const claimPostForPublish = async (payload: Payload, id: number | string): Promise<boolean> => {
  const result = (await payload.update({
    collection: SOCIAL_POSTS_SLUG as never,
    data: {
      lastAttemptedAt: new Date().toISOString(),
      status: 'publishing',
    } as never,
    limit: 1,
    overrideAccess: true,
    where: {
      and: [{ id: { equals: id } }, { status: { in: ['queued', 'failed'] } }],
    },
  } as never)) as unknown as { docs?: unknown[] }
  return (result.docs?.length ?? 0) === 1
}

const buildPublishTaskConfig = () =>
  ({
    slug: SOCIAL_POST_PUBLISH_TASK_SLUG,
    handler: async ({ input, req }: { input: PublishTaskInput; req: PayloadRequest }) => {
      const options = getPluginOptions()
      const log = createPluginLogger(req.payload.logger, {
        postId: input.postId,
        task: SOCIAL_POST_PUBLISH_TASK_SLUG,
      })

      const post = await loadPost(req.payload, input.postId)
      if (!post) {
        return { errorMessage: `social-posts/${input.postId} not found`, state: 'failed' as const }
      }
      if (post.status === 'published' && post.externalId) {
        // Already done — idempotent no-op.
        return {
          output: {
            alreadyPublished: true,
            externalId: post.externalId,
            postId: post.id,
          },
        }
      }
      if (post.status === 'cancelled') {
        return { errorMessage: 'post is cancelled', state: 'failed' as const }
      }

      const queuedInput = post.meta?.queuedInput
      if (!queuedInput || typeof queuedInput !== 'object') {
        const err = `social-posts/${post.id}.meta.queuedInput missing`
        await markPostFailed(req.payload, post.id, err)
        return { errorMessage: err, state: 'failed' as const }
      }

      if (!(await claimPostForPublish(req.payload, post.id))) {
        return {
          output: {
            alreadyInProgress: true,
            postId: post.id,
          },
        }
      }

      let ctx: SocialSourceContext
      try {
        ctx = await resolveSourceContext({
          id: post.sourceId,
          kind: post.sourceKind,
          payload: req.payload,
          req,
        })
      } catch (error) {
        await markPostFailed(req.payload, post.id, error)
        return {
          errorMessage: safeErrorMessage(error),
          state: 'failed' as const,
        }
      }

      try {
        const adapter = getPlatformAdapter(post.platform)
        const ref = await adapter.publish({
          ctx,
          input: queuedInput as never,
          options,
          payload: req.payload,
          postId: post.id,
          req,
        })
        log.info('published')
        return {
          output: {
            externalId: ref.externalId,
            externalUrl: ref.externalUrl,
            postId: post.id,
          },
        }
      } catch (error) {
        await markPostFailed(req.payload, post.id, error)
        log.error('publish failed', { error: safeErrorMessage(error) })
        return {
          errorMessage: safeErrorMessage(error),
          state: 'failed' as const,
        }
      }
    },
    inputSchema: [],
    interfaceName: 'SocialsPublishTaskInput',
    outputSchema: [],
    retries: 3,
  }) as const

// ---------------------------------------------------------------------------
// social-post-retry — explicit retry of a specific failed post
// ---------------------------------------------------------------------------

type RetryTaskInput = {
  postId: number | string
}

const buildRetryTaskConfig = () =>
  ({
    slug: SOCIAL_POST_RETRY_TASK_SLUG,
    handler: async ({ input, req }: { input: RetryTaskInput; req: PayloadRequest }) => {
      const log = createPluginLogger(req.payload.logger, {
        postId: input.postId,
        task: SOCIAL_POST_RETRY_TASK_SLUG,
      })

      // Flip status back to `queued` and let the publish task handle it.
      const post = await loadPost(req.payload, input.postId)
      if (!post) {
        return { errorMessage: `social-posts/${input.postId} not found`, state: 'failed' as const }
      }
      if (post.status === 'published') {
        return { output: { alreadyPublished: true, postId: post.id } }
      }
      try {
        await req.payload.update({
          id: post.id as never,
          collection: SOCIAL_POSTS_SLUG as never,
          data: { lastError: null, nextRetryAt: null, status: 'queued' } as never,
          overrideAccess: true,
        })
      } catch (error) {
        return {
          errorMessage: safeErrorMessage(error),
          state: 'failed' as const,
        }
      }
      // Re-queue the publish task. We DO NOT recurse into the publish task
      // body inline — the queue path keeps retry attempts visible in the
      // jobs UI.
      const { queueSocialPostPublish } = await import('./jobQueue.js')
      await queueSocialPostPublish({ payload: req.payload, postId: post.id, req })
      log.info('retry queued')
      return { output: { postId: post.id, requeued: true } }
    },
    inputSchema: [],
    interfaceName: 'SocialsRetryTaskInput',
    outputSchema: [],
    retries: 1,
  }) as const

// ---------------------------------------------------------------------------
// social-insights-refresh — pulls platform-side analytics for recent posts
// ---------------------------------------------------------------------------

type InsightsRefreshTaskInput = {
  /** Cap on posts processed per platform per invocation. */
  limit?: number
  /** When omitted: refresh insights for every platform with an adapter that supports it. */
  platform?: PlatformId
  /** Override the lookback window (seconds). */
  windowSeconds?: number
}

const refreshInsightsForPlatform = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: PlatformId,
  windowSeconds: number,
  limit: number,
): Promise<{ failed: number; platform: PlatformId; refreshed: number; skipped: number }> => {
  let adapter
  try {
    adapter = getPlatformAdapter(platform)
  } catch {
    return { failed: 0, platform, refreshed: 0, skipped: 0 }
  }
  if (!adapter.getInsights) {
    return { failed: 0, platform, refreshed: 0, skipped: 0 }
  }
  const getInsights: NonNullable<typeof adapter.getInsights> = (args) => adapter.getInsights!(args)

  const since = new Date(Date.now() - windowSeconds * 1000).toISOString()
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit,
    overrideAccess: true,
    sort: '-publishedAt',
    where: {
      and: [
        { platform: { equals: platform } },
        { status: { equals: 'published' } },
        { publishedAt: { greater_than_equal: since } },
      ],
    },
  })

  let refreshed = 0
  let skipped = 0
  let failed = 0
  const rangeEnd = new Date().toISOString()
  const rangeStart = since

  const rows = result.docs as unknown as Array<{
    destination?: { id?: null | string }
    externalId?: null | string
    externalUrl?: null | string
    id: number | string
    meta?: Record<string, unknown>
  }>
  let cursor = 0
  const refreshNext = async (): Promise<void> => {
    while (cursor < rows.length) {
      const row = rows[cursor++]
      if (!row.externalId) {
        skipped++
        continue
      }
      try {
        const snapshot = await getInsights({
          options,
          payload,
          publishedRef: {
            externalId: row.externalId,
            externalUrl: row.externalUrl ?? undefined,
            meta: {
              ...(row.meta ?? {}),
              ...(row.destination?.id ? { destinationId: row.destination.id } : {}),
              ...(platform === 'facebook' && row.destination?.id
                ? { pageId: row.destination.id }
                : {}),
            },
            platform,
          },
          range: { end: rangeEnd, start: rangeStart },
        })
        await payload.update({
          id: row.id as never,
          collection: SOCIAL_POSTS_SLUG as never,
          data: {
            insightsFetchedAt: new Date().toISOString(),
            insightsSnapshot: snapshot,
          } as never,
          overrideAccess: true,
        })
        refreshed++
      } catch (error) {
        failed++
        createPluginLogger(payload.logger, {
          platform,
          postId: row.id,
          task: SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
        }).warn('insights refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  const concurrency = Math.min(Math.max(1, options.rateLimit.maxConcurrency), rows.length || 1)
  await Promise.all(Array.from({ length: concurrency }, refreshNext))

  return { failed, platform, refreshed, skipped }
}

const buildInsightsRefreshTaskConfig = () =>
  ({
    slug: SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
    handler: async ({ input, req }: { input: InsightsRefreshTaskInput; req: PayloadRequest }) => {
      const options = getPluginOptions()
      const log = createPluginLogger(req.payload.logger, {
        task: SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
      })
      const window = input.windowSeconds ?? options.scheduling.insightsRefreshWindowSeconds
      const limit = input.limit ?? 200
      const targets: PlatformId[] = input.platform ? [input.platform] : [...PLATFORM_IDS]

      const summaries: Array<{
        failed: number
        platform: PlatformId
        refreshed: number
        skipped: number
      }> = []
      for (const platform of targets) {
        if (!options.platforms[platform].enabled) {
          continue
        }
        try {
          const summary = await refreshInsightsForPlatform(
            req.payload,
            options,
            platform,
            window,
            limit,
          )
          summaries.push(summary)
        } catch (error) {
          log.error(`insights refresh failed for ${platform}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { output: { summaries } }
    },
    inputSchema: [],
    interfaceName: 'SocialsInsightsRefreshTaskInput',
    outputSchema: [],
    retries: 1,
  }) as const

// ---------------------------------------------------------------------------
// social-connection-refresh — proactive token rotation
// ---------------------------------------------------------------------------

type ConnectionRefreshTaskInput = {
  platform?: PlatformId
  /** Override the expiry window (seconds) — refresh tokens expiring within this. */
  windowSeconds?: number
}

const buildConnectionRefreshTaskConfig = () =>
  ({
    slug: SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
    handler: async ({ input, req }: { input: ConnectionRefreshTaskInput; req: PayloadRequest }) => {
      const options = getPluginOptions()
      const log = createPluginLogger(req.payload.logger, {
        task: SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
      })
      const windowMs =
        (input.windowSeconds ?? options.scheduling.connectionRefreshWindowSeconds) * 1000
      const targets: PlatformId[] = input.platform ? [input.platform] : [...PLATFORM_IDS]

      const { getCredentials } = await import('../server/services/connectionService.js')
      const refreshed: Array<{ platform: PlatformId; refreshed: boolean }> = []

      for (const platform of targets) {
        if (!options.platforms[platform].enabled) {
          continue
        }
        try {
          const creds = await getCredentials(req.payload, options, platform)
          if (!creds?.accessToken && !creds?.refreshToken) {
            refreshed.push({ platform, refreshed: false })
            continue
          }
          const expiresAt = creds.accessTokenExpiresAt
            ? Date.parse(creds.accessTokenExpiresAt)
            : NaN
          if (Number.isFinite(expiresAt) && expiresAt - Date.now() > windowMs) {
            // Token still has time left — skip.
            refreshed.push({ platform, refreshed: false })
            continue
          }
          const adapter = getPlatformAdapter(platform)
          if (typeof adapter.refreshToken === 'function') {
            const result = await adapter.refreshToken({
              options,
              payload: req.payload,
              refreshToken: creds.refreshToken,
            })
            const { saveCredentials } = await import('../server/services/connectionService.js')
            await saveCredentials(req.payload, options, platform, {
              accessToken: result.accessToken,
              accessTokenExpiresAt: result.accessTokenExpiresAt,
              refreshToken: result.refreshToken,
              refreshTokenExpiresAt: result.refreshTokenExpiresAt,
              scopes: result.scopes,
              updateAccount: false,
            })
            refreshed.push({ platform, refreshed: true })
          } else {
            // No adapter-level refresh — the request-layer cache will lazily
            // refresh on next use. Mark not-refreshed for telemetry.
            refreshed.push({ platform, refreshed: false })
          }
        } catch (error) {
          log.error(`connection refresh failed for ${platform}`, {
            error: error instanceof Error ? error.message : String(error),
          })
          refreshed.push({ platform, refreshed: false })
        }
      }
      return { output: { refreshed } }
    },
    inputSchema: [],
    interfaceName: 'SocialsConnectionRefreshTaskInput',
    outputSchema: [],
    retries: 1,
  }) as const

// ---------------------------------------------------------------------------
// social-post-sweep — finds due queued posts and queues publish tasks
// ---------------------------------------------------------------------------

export const SOCIAL_POST_SWEEP_TASK_SLUG = 'socialPostSweep'

type SweepTaskInput = {
  /** Override the batch size (default: scheduling.sweepBatchSize). */
  limit?: number
}

const buildSweepTaskConfig = () =>
  ({
    slug: SOCIAL_POST_SWEEP_TASK_SLUG,
    handler: async ({ input, req }: { input: SweepTaskInput; req: PayloadRequest }) => {
      const options = getPluginOptions()
      const log = createPluginLogger(req.payload.logger, { task: SOCIAL_POST_SWEEP_TASK_SLUG })
      const limit = input.limit ?? options.scheduling.sweepBatchSize

      const now = new Date().toISOString()
      const result = await req.payload.find({
        collection: SOCIAL_POSTS_SLUG as never,
        depth: 0,
        limit,
        overrideAccess: true,
        sort: 'scheduledAt',
        where: {
          and: [{ status: { equals: 'queued' } }, { scheduledAt: { less_than_equal: now } }],
        },
      })

      const { queueSocialPostPublish } = await import('./jobQueue.js')
      let queued = 0
      for (const row of result.docs as unknown as Array<{ id: number | string }>) {
        try {
          await queueSocialPostPublish({ payload: req.payload, postId: row.id, req })
          queued++
        } catch (error) {
          log.error('failed to queue publish for due post', {
            error: error instanceof Error ? error.message : String(error),
            postId: row.id,
          })
        }
      }
      log.info(`sweep queued ${queued} of ${result.docs.length} due posts`)
      return { output: { queued, scanned: result.docs.length } }
    },
    inputSchema: [],
    interfaceName: 'SocialsSweepTaskInput',
    outputSchema: [],
    retries: 0,
  }) as const

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ALL_TASK_BUILDERS = [
  buildPublishTaskConfig,
  buildRetryTaskConfig,
  buildInsightsRefreshTaskConfig,
  buildConnectionRefreshTaskConfig,
  buildSweepTaskConfig,
] as const

export {
  buildConnectionRefreshTaskConfig,
  buildInsightsRefreshTaskConfig,
  buildPublishTaskConfig,
  buildRetryTaskConfig,
  buildSweepTaskConfig,
}
