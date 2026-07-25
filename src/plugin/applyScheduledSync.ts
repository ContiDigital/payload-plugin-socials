import type { Config, Payload } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { createPluginLogger } from '../server/utilities/logger.js'

/**
 * Emits a once-per-Payload startup notice describing how to drive the plugin's
 * scheduling. The plugin defines the tasks and (when `scheduling.autoRun` crons
 * are set) attaches Payload task-level `schedule` entries in `applyJobEnhancements`
 * — but it deliberately does NOT run a worker or write to `config.jobs.autoRun`.
 * The host owns the trigger, exactly like the sibling Merchant Center plugin.
 *
 * Three modes (freely mixable):
 *
 *   1. **Native Payload Jobs** — set `scheduling.autoRun` crons and run a
 *      Payload Jobs worker that handles schedules + drains the queue (your own
 *      `jobs.autoRun`, or `handleSchedules()` + `run()` on a cron).
 *   2. **External cron → HTTP** — POST `/socials/internal/jobs/sweep` and
 *      `/socials/internal/jobs/run` with `scheduling.internalApiKey`.
 *   3. **Long-running worker** — call
 *      `runQueuedSocialsJobs(payload, options)` and
 *      `sweepDueSocialPosts(payload, options)` in a loop.
 *
 * A `WeakSet` keeps the notice to once per Payload instance without retaining
 * disposed instances (HMR-safe).
 */

const startupNoticeRegistry = new WeakSet<Payload>()

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
  const queue = options.scheduling.queue

  wrapOnInit(config, (payload) => {
    if (startupNoticeRegistry.has(payload)) {
      return
    }
    startupNoticeRegistry.add(payload)

    const log = createPluginLogger(payload.logger, { op: 'scheduling' })
    if (autoRun) {
      log.info('payload-plugin-socials: task schedules registered', {
        connectionRefreshCron: autoRun.connectionRefreshCron ?? null,
        insightsRefreshCron: autoRun.insightsRefreshCron ?? null,
        note:
          `Attached Payload task \`schedule\` entries on queue "${queue}". Run a Payload Jobs ` +
          'worker that handles schedules and drains this queue (configure your own `jobs.autoRun`, ' +
          'or call `payload.jobs.handleSchedules()` + `payload.jobs.run()` on a cron). Scheduled ' +
          'publishes are enqueued with `waitUntil` and drained by the same worker.',
        queue,
        sweepCron: autoRun.cron ?? null,
      })
    } else {
      log.info('payload-plugin-socials: scheduling tasks registered', {
        note:
          `No \`scheduling.autoRun\` crons set. Drive scheduling by POSTing ` +
          `${options.api.basePath}/internal/jobs/sweep and ` +
          `${options.api.basePath}/internal/jobs/run with your internal API key, ` +
          'or by calling sweepDueSocialPosts(payload, options) + ' +
          'runQueuedSocialsJobs(payload, options) from a worker. ' +
          'Scheduled publishes are enqueued with `waitUntil` and drained by whichever trigger you run.',
        queue,
      })
    }
  })

  return config
}
