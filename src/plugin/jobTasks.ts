import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import {
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
} from '../constants.js'
import { setSocialsQueueName } from './jobQueue.js'
import { ALL_TASK_BUILDERS, setPluginOptionsForTasks } from './jobTaskDefinitions.js'

/**
 * Resolve the Payload task `schedule` for a periodic task from the host's
 * `scheduling.autoRun` crons. Returns `[{ cron, queue }]` when a cron is
 * configured for this task slug, else `undefined`. This is the correct
 * Payload-native enqueue mechanism — unlike a `jobs.autoRun` entry, which only
 * drains the queue and never enqueues the task. The host must run a Jobs worker
 * that handles schedules; the plugin never writes to `config.jobs.autoRun`.
 */
const scheduleForTaskSlug = (
  slug: string,
  options: NormalizedPluginOptions,
): Array<{ cron: string; queue: string }> | undefined => {
  const auto = options.scheduling.autoRun
  if (!auto) {
    return undefined
  }
  const queue = options.scheduling.queue
  const cron =
    slug === SOCIAL_POST_SWEEP_TASK_SLUG
      ? auto.cron
      : slug === SOCIAL_INSIGHTS_REFRESH_TASK_SLUG
        ? auto.insightsRefreshCron
        : slug === SOCIAL_CONNECTION_REFRESH_TASK_SLUG
          ? auto.connectionRefreshCron
          : undefined
  return cron ? [{ cron, queue }] : undefined
}

const TASK_SLUGS_OWNED_BY_PLUGIN = [
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
] as const

const findTaskBySlug = (config: Config, slug: string): Record<string, unknown> | undefined => {
  const tasks = config.jobs?.tasks
  if (!tasks) {
    return undefined
  }
  return tasks.find((task) => {
    return (
      typeof task === 'object' &&
      task !== null &&
      'slug' in task &&
      (task as { slug?: unknown }).slug === slug
    )
  }) as Record<string, unknown> | undefined
}

const ensureJobsConfig = (config: Config): NonNullable<Config['jobs']> => {
  if (!config.jobs) {
    config.jobs = { tasks: [] }
  }
  if (!config.jobs.tasks) {
    config.jobs.tasks = []
  }
  return config.jobs
}

/**
 * Register the plugin's task definitions on the host Payload config.
 *
 * Idempotent — re-applying the same plugin configuration during HMR
 * does not duplicate task registrations. Tasks already in the host config
 * with a matching slug are left untouched, on the principle that an
 * explicit host override wins.
 *
 * `as never` bridges Payload's task-array generic and the concrete runtime
 * task configuration accepted by `buildConfig`.
 */
export const applyJobEnhancements = (config: Config, options: NormalizedPluginOptions): Config => {
  // Tasks receive only `{ input, req }` at runtime — they need the plugin
  // options to be resolvable from a registry. Stash the normalized options
  // BEFORE pushing the task configs so any in-flight Payload boot that
  // immediately fires a queued job still finds the options.
  const previousOnInit = config.onInit
  config.onInit = async (payload) => {
    setPluginOptionsForTasks(payload, options)
    setSocialsQueueName(payload, options.scheduling.queue)
    if (previousOnInit) {
      await previousOnInit(payload)
    }
  }

  const jobs = ensureJobsConfig(config)
  // `ensureJobsConfig` guarantees `tasks` is an array, but TS narrowing
  // doesn't propagate through the optional chain. Treat the array as
  // `unknown[]` so we can push regardless of Payload's current TaskConfig
  // signature (which varies across @payloadcms/payload versions).
  const tasks = (jobs.tasks ?? []) as unknown[]
  if (jobs.tasks !== tasks) {
    ;(jobs as { tasks: unknown[] }).tasks = tasks
  }

  for (const builder of ALL_TASK_BUILDERS) {
    const taskConfig = builder() as { schedule?: unknown; slug: string }
    // Attach the Payload-native task `schedule` for periodic tasks when the
    // host opted into native scheduling via `scheduling.autoRun` crons.
    const schedule = scheduleForTaskSlug(taskConfig.slug, options)
    if (schedule) {
      taskConfig.schedule = schedule
    }
    if (!findTaskBySlug(config, taskConfig.slug)) {
      tasks.push(taskConfig as never)
    }
  }

  return config
}

export { TASK_SLUGS_OWNED_BY_PLUGIN }
