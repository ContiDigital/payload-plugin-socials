import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import {
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
  SOCIALS_QUEUE_NAME,
} from '../constants.js'
import { setSocialsQueueName } from './jobQueue.js'
import { ALL_TASK_BUILDERS, setPluginOptionsForTasks } from './jobTaskDefinitions.js'

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
    setSocialsQueueName(payload, options.scheduling.autoRun?.queue ?? SOCIALS_QUEUE_NAME)
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
    const taskConfig = builder()
    if (!findTaskBySlug(config, taskConfig.slug)) {
      tasks.push(taskConfig as never)
    }
  }

  return config
}

export { TASK_SLUGS_OWNED_BY_PLUGIN }
