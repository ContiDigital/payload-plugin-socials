import type { Payload, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import type { NormalizedPluginOptions, PlatformId, PostStatus } from '../types/index.js'

import {
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
  SOCIAL_POSTS_SLUG,
  SOCIALS_QUEUE_NAME,
} from '../constants.js'
import { logAsyncOperationFailure } from '../server/utilities/logger.js'

/**
 * Queue helpers + the per-`Payload` runner singleton (`runQueuedSocialsJobs`).
 *
 * Every supported scheduling mode converges on these helpers:
 *
 *   - Plugin defines tasks (see `jobTaskDefinitions.ts`).
 *   - Plugin exposes `queueX` helpers + a single `runQueuedSocialsJobs`
 *     entrypoint that drains the queue via `payload.jobs.run()`.
 *   - Host triggers BOTH the queue insertion AND the drain — via Payload's
 *     native autoRun, via external cron hitting the plugin's `/internal`
 *     endpoints, or via a long-running worker process.
 *
 * The runner singleton is keyed by the Payload instance (WeakMap) so:
 *   - Multiple plugin instances on different Payload instances don't share state.
 *   - The Payload instance becoming GC-eligible cleans up automatically.
 *   - Re-entrant calls coalesce into a single in-flight `jobs.run()`.
 */

const getRecordID = (value: unknown): number | string | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record.id === 'number' || typeof record.id === 'string') {
    return record.id
  }
  return undefined
}

const queueNames = new WeakMap<Payload, string>()

export const setSocialsQueueName = (payload: Payload, queue: string): void => {
  queueNames.set(payload, queue)
}

// ---------------------------------------------------------------------------
// Per-payload `jobs.run()` singleton
// ---------------------------------------------------------------------------

const runnerState = new WeakMap<Payload, Promise<void>>()

/**
 * Drains the socials queue. Idempotent across concurrent callers — repeated
 * invocations while a drain is in flight return the SAME promise.
 *
 * Returns `undefined` rather than the raw `jobs.run` result so callers don't
 * grow a dependency on Payload's job-tracking shape.
 */
export const runQueuedSocialsJobs = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  req?: PayloadRequest,
): Promise<void> => {
  const existing = runnerState.get(payload)
  if (existing) {
    return existing
  }

  const limit = options.scheduling.drainBatchSize
  const queue = options.scheduling.queue

  const promise = payload.jobs
    .run({ limit, queue, req })
    .then(() => undefined)
    .finally(() => {
      runnerState.delete(payload)
    })

  runnerState.set(payload, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Sweep — find due `queued` posts and queue their publish tasks
// ---------------------------------------------------------------------------

type SocialPostQueueRow = {
  id: number | string
  meta?: { scheduleToken?: string }
  nextRetryAt?: null | string
  queuedJobId?: null | string
  scheduledAt?: null | string
  status: PostStatus
}

export type SweepResult = {
  queued: number
  scanned: number
}

export const sweepDueSocialPosts = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  req?: PayloadRequest,
): Promise<SweepResult> => {
  const limit = options.scheduling.sweepBatchSize
  const now = new Date().toISOString()
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit,
    overrideAccess: true,
    sort: 'scheduledAt',
    where: {
      or: [
        { and: [{ status: { equals: 'queued' } }, { scheduledAt: { less_than_equal: now } }] },
        {
          and: [
            { platform: { equals: 'gbp' } },
            { status: { equals: 'publishing' } },
            { nextRetryAt: { less_than_equal: now } },
          ],
        },
        {
          and: [
            { platform: { equals: 'facebook' } },
            { status: { equals: 'scheduled' } },
            { nextRetryAt: { less_than_equal: now } },
          ],
        },
      ],
    },
  })

  const rows = result.docs as unknown as SocialPostQueueRow[]
  let queued = 0
  for (const row of rows) {
    try {
      await queueSocialPostPublish({ payload, postId: row.id, req })
      queued++
    } catch (error) {
      logAsyncOperationFailure(payload, 'socials.sweep.queue', error)
    }
  }
  return { queued, scanned: rows.length }
}

// ---------------------------------------------------------------------------
// Queue helpers (each task gets a thin typed wrapper around payload.jobs.queue)
// ---------------------------------------------------------------------------

type QueueArgs = {
  payload: Payload
  req?: PayloadRequest
}

const queueOnSocialsQueue = async (args: {
  input: Record<string, unknown>
  payload: Payload
  req?: PayloadRequest
  task: string
  waitUntil?: Date | string
}): Promise<number | string | undefined> => {
  const queueOptions: {
    input: Record<string, unknown>
    queue: string
    req?: PayloadRequest
    task: string
    waitUntil?: Date
  } = {
    input: args.input,
    queue: queueNames.get(args.payload) ?? SOCIALS_QUEUE_NAME,
    req: args.req,
    task: args.task,
  }
  if (args.waitUntil) {
    queueOptions.waitUntil =
      args.waitUntil instanceof Date ? args.waitUntil : new Date(args.waitUntil)
  }
  const job = await args.payload.jobs.queue(queueOptions as never)
  return getRecordID(job)
}

export type QueuePublishArgs = {
  postId: number | string
  /** Defer the work until this instant (Payload Jobs' `waitUntil`). */
  scheduledAt?: Date | string
  scheduleToken?: string
} & QueueArgs

export const queueSocialPostPublish = async (
  args: QueuePublishArgs,
): Promise<number | string | undefined> => {
  const input: Record<string, unknown> = { postId: args.postId }
  if (args.scheduleToken) {
    input.scheduleToken = args.scheduleToken
  }
  return queueOnSocialsQueue({
    input,
    payload: args.payload,
    req: args.req,
    task: SOCIAL_POST_PUBLISH_TASK_SLUG,
    waitUntil: args.scheduledAt,
  })
}

export type QueueRetryArgs = { postId: number | string } & QueueArgs

export const queueSocialPostRetry = async (
  args: QueueRetryArgs,
): Promise<number | string | undefined> =>
  queueOnSocialsQueue({
    input: { postId: args.postId },
    payload: args.payload,
    req: args.req,
    task: SOCIAL_POST_RETRY_TASK_SLUG,
  })

export type QueueInsightsRefreshArgs = {
  limit?: number
  platform?: PlatformId
  windowSeconds?: number
} & QueueArgs

export const queueSocialInsightsRefresh = async (
  args: QueueInsightsRefreshArgs,
): Promise<number | string | undefined> => {
  const input: Record<string, unknown> = {}
  if (args.platform) {
    input.platform = args.platform
  }
  if (args.windowSeconds !== undefined) {
    input.windowSeconds = args.windowSeconds
  }
  if (args.limit !== undefined) {
    input.limit = args.limit
  }
  return queueOnSocialsQueue({
    input,
    payload: args.payload,
    req: args.req,
    task: SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  })
}

export type QueueConnectionRefreshArgs = {
  platform?: PlatformId
  windowSeconds?: number
} & QueueArgs

export const queueSocialConnectionRefresh = async (
  args: QueueConnectionRefreshArgs,
): Promise<number | string | undefined> => {
  const input: Record<string, unknown> = {}
  if (args.platform) {
    input.platform = args.platform
  }
  if (args.windowSeconds !== undefined) {
    input.windowSeconds = args.windowSeconds
  }
  return queueOnSocialsQueue({
    input,
    payload: args.payload,
    req: args.req,
    task: SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  })
}

export type QueueSweepArgs = { limit?: number } & QueueArgs

export const queueSocialPostSweep = async (
  args: QueueSweepArgs,
): Promise<number | string | undefined> => {
  const input: Record<string, unknown> = {}
  if (args.limit !== undefined) {
    input.limit = args.limit
  }
  return queueOnSocialsQueue({
    input,
    payload: args.payload,
    req: args.req,
    task: SOCIAL_POST_SWEEP_TASK_SLUG,
  })
}

// ---------------------------------------------------------------------------
// One-shot helper: snapshot a publish input into a queued post row
// ---------------------------------------------------------------------------

/**
 * Persist a scheduled publish into the `social-posts` collection AND queue
 * the publish task with `waitUntil` honouring the schedule. Returns the
 * generated post id + job id so callers (admin endpoints, server actions)
 * can surface them.
 *
 * The idempotency contract matches the immediate-publish path: a row keyed
 * by `idempotencyKey` is upserted, so re-scheduling the same `(platform,
 * source, destination, asset)` tuple does NOT create duplicate work.
 */
export const scheduleSocialPostPublish = async (args: {
  body?: string
  /** Snapshotted destination + display fields for the admin UI. */
  destination?: {
    id?: string
    label?: string
    meta?: Record<string, unknown>
  }
  idempotencyKey: string
  imageUrl?: string
  link?: string
  options: NormalizedPluginOptions
  payload: Payload
  platform: PlatformId
  publishedByUserId?: number | string
  /** Snapshot the full publish input the adapter will replay later. */
  queuedInput: Record<string, unknown>
  req?: PayloadRequest
  scheduledAt: Date | string
  sourceHash: string
  sourceId: string
  sourceKind: string
  title?: string
}): Promise<{
  alreadyPublished?: boolean
  externalId?: string
  jobId?: number | string
  postId: number | string
  scheduledAt: string
}> => {
  const scheduledIso =
    args.scheduledAt instanceof Date
      ? args.scheduledAt.toISOString()
      : new Date(args.scheduledAt).toISOString()

  const existing = await args.payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { idempotencyKey: { equals: args.idempotencyKey } },
  })
  const existingDoc = existing.docs[0] as unknown as
    ({ externalId?: null | string } & SocialPostQueueRow) | undefined
  if (existingDoc && existingDoc.status === 'published' && existingDoc.externalId) {
    // Already published — surface as a no-op so callers can return early.
    return {
      alreadyPublished: true,
      externalId: existingDoc.externalId,
      postId: existingDoc.id,
      scheduledAt: existingDoc.scheduledAt ?? scheduledIso,
    }
  }

  const scheduleToken = randomUUID()

  const baseFields = {
    attempts: 0,
    body: args.body,
    destination: args.destination,
    idempotencyKey: args.idempotencyKey,
    imageUrl: args.imageUrl,
    link: args.link,
    meta: { queuedInput: args.queuedInput, scheduleToken },
    platform: args.platform,
    ...(args.options.authCollection ? { publishedBy: args.publishedByUserId } : {}),
    scheduledAt: scheduledIso,
    sourceHash: args.sourceHash,
    sourceId: args.sourceId,
    sourceKind: args.sourceKind,
    status: 'queued' as const,
    title: args.title,
  }

  let postId: number | string
  if (existingDoc) {
    const updated = (await args.payload.update({
      id: existingDoc.id as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: baseFields as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    postId = updated.id
  } else {
    try {
      const created = (await args.payload.create({
        collection: SOCIAL_POSTS_SLUG as never,
        data: baseFields as never,
        overrideAccess: true,
      })) as unknown as { id: number | string }
      postId = created.id
    } catch (error) {
      const raced = await args.payload.find({
        collection: SOCIAL_POSTS_SLUG as never,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        where: { idempotencyKey: { equals: args.idempotencyKey } },
      })
      const racedDoc = raced.docs[0] as unknown as SocialPostQueueRow | undefined
      if (!racedDoc) {
        throw error
      }
      const updated = (await args.payload.update({
        id: racedDoc.id as never,
        collection: SOCIAL_POSTS_SLUG as never,
        data: baseFields as never,
        overrideAccess: true,
      })) as unknown as { id: number | string }
      postId = updated.id
    }
  }

  const jobId = await queueSocialPostPublish({
    payload: args.payload,
    postId,
    req: args.req,
    scheduledAt: scheduledIso,
    scheduleToken,
  })

  // Stamp the queued job id back onto the post for diagnostics.
  if (jobId !== undefined) {
    try {
      await args.payload.update({
        id: postId as never,
        collection: SOCIAL_POSTS_SLUG as never,
        data: { queuedJobId: String(jobId) } as never,
        overrideAccess: true,
      })
    } catch {
      /* non-fatal */
    }
  }

  if (existingDoc?.queuedJobId && String(existingDoc.queuedJobId) !== String(jobId)) {
    try {
      await args.payload.jobs.cancelByID({ id: existingDoc.queuedJobId as never })
    } catch (error) {
      logAsyncOperationFailure(args.payload, 'socials.jobs.cancel-stale', error)
    }
  }

  return { jobId, postId, scheduledAt: scheduledIso }
}
