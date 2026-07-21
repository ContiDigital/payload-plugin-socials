import type { Config, Payload } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import {
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
  SOCIALS_QUEUE_NAME,
} from '../constants.js'
import { createPluginLogger } from '../server/utilities/logger.js'

/**
 * Optionally registers cron-driven `autoRun` entries for the plugin's
 * scheduling tasks on the host's Payload Jobs config.
 *
 * The host can choose among three scheduling modes:
 *
 *   1. **Native Payload Jobs autoRun** (this file). Host sets
 *      `scheduling.autoRun.cron` and the plugin registers an autoRun entry
 *      under the socials queue. Payload's built-in scheduler fires it.
 *
 *   2. **External cron → HTTP**. Host wires AWS EventBridge, Vercel cron,
 *      GitHub Actions, fly machines, etc. to POST against the plugin's
 *      `/socials/internal/jobs/sweep` and `/socials/internal/jobs/run`
 *      endpoints with the configured API key. These endpoints invoke the
 *      sweep + drain helpers inline.
 *
 *   3. **Long-running worker**. Host imports `runQueuedSocialsJobs` and
 *      `sweepDueSocialPosts` from this package and calls them in a loop.
 *
 * `applyScheduledSync` only activates mode (1). Modes (2) and (3) are
 * always available regardless of this module — they just exercise the
 * `jobQueue` helpers directly.
 *
 * Idempotent — re-applying the same plugin configuration during HMR
 * does not stack autoRun entries. Existing entries with a matching task
 * slug + queue are left untouched.
 *
 * A `WeakSet` keeps the startup notice once per Payload instance without
 * retaining disposed instances.
 */

const startupNoticeRegistry = new WeakSet<Payload>()

type AutoRunEntry = {
  cron: string
  queue: string
  taskSlug?: string
}

const findAutoRunEntry = (config: Config, needle: AutoRunEntry): boolean => {
  const autoRun = (config.jobs as { autoRun?: unknown } | undefined)?.autoRun
  if (!Array.isArray(autoRun)) {
    return false
  }
  return autoRun.some((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const e = entry as Record<string, unknown>
    if (e.cron !== needle.cron) {
      return false
    }
    if (e.queue !== needle.queue) {
      return false
    }
    return true
  })
}

const ensureAutoRunArray = (config: Config): unknown[] => {
  if (!config.jobs) {
    config.jobs = { tasks: [] }
  }
  const jobs = config.jobs as { tasks: unknown[] } & Record<string, unknown>
  if (!Array.isArray(jobs.autoRun)) {
    jobs.autoRun = []
  }
  return jobs.autoRun as unknown[]
}

const wrapOnInit = (config: Config, onInit: (payload: Payload) => Promise<void> | void): void => {
  const existing = config.onInit
  config.onInit = async (payload) => {
    if (existing) {
      await existing(payload)
    }
    await onInit(payload)
  }
}

export const applyScheduledSync = (config: Config, options: NormalizedPluginOptions): Config => {
  const autoRun = options.scheduling.autoRun
  if (!autoRun) {
    return config
  }

  const queue = autoRun.queue ?? SOCIALS_QUEUE_NAME

  // Register the main sweep cron — fires sweep task which queues publish
  // tasks for any `social-posts` row whose `scheduledAt` has elapsed.
  // The sweep task itself runs on the socials queue and Payload's worker
  // drains the queue on the same tick.
  const entries: AutoRunEntry[] = [
    { cron: autoRun.cron, queue, taskSlug: SOCIAL_POST_SWEEP_TASK_SLUG },
  ]
  if (autoRun.insightsRefreshCron) {
    entries.push({
      cron: autoRun.insightsRefreshCron,
      queue,
      taskSlug: SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
    })
  }
  if (autoRun.connectionRefreshCron) {
    entries.push({
      cron: autoRun.connectionRefreshCron,
      queue,
      taskSlug: SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
    })
  }

  const autoRunArray = ensureAutoRunArray(config)
  for (const entry of entries) {
    if (findAutoRunEntry(config, entry)) {
      continue
    }
    // Payload's autoRun entries are loosely typed (varies across versions
    // of `@payloadcms/payload`). `as never` is the documented Payload-types
    // Payload's config type is narrower than the runtime autoRun shape.
    autoRunArray.push({ cron: entry.cron, queue: entry.queue } as never)
  }

  // Boot-time notice so operators see "yes, the plugin is on autoRun" in
  // their startup logs. `WeakSet` keyed on Payload guarantees once-per
  // instance (HMR reloads don't spam the log).
  wrapOnInit(config, (payload) => {
    if (startupNoticeRegistry.has(payload)) {
      return
    }
    startupNoticeRegistry.add(payload)
    const log = createPluginLogger(payload.logger, { op: 'autoRun' })
    log.info('payload-plugin-socials autoRun enabled', {
      connectionRefreshCron: autoRun.connectionRefreshCron ?? null,
      insightsRefreshCron: autoRun.insightsRefreshCron ?? null,
      note:
        'Sweep task scans social-posts for queued rows whose scheduledAt has elapsed and queues their publish task on the same queue. ' +
        'Make sure Payload Jobs has a worker running for this queue (or invoke runQueuedSocialsJobs from an external trigger).',
      queue,
      sweepCron: autoRun.cron,
    })
  })

  return config
}
