import type { Config, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import {
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
} from '../../constants.js'
import { queueSocialPostPublish } from '../jobQueue.js'
import { applyJobEnhancements } from '../jobTasks.js'

type TaskLike = { schedule?: Array<{ cron: string; queue: string }>; slug: string }

const opts = (
  autoRun: NormalizedPluginOptions['scheduling']['autoRun'],
  queue = 'socials',
): NormalizedPluginOptions =>
  ({ scheduling: { autoRun, queue } }) as unknown as NormalizedPluginOptions

const tasksOf = (config: Config): TaskLike[] => (config.jobs?.tasks ?? []) as unknown as TaskLike[]
const bySlug = (config: Config, slug: string) => tasksOf(config).find((t) => t.slug === slug)

describe('applyJobEnhancements task scheduling', () => {
  it('registers all five tasks and never writes config.jobs.autoRun', () => {
    const config = {} as Config
    applyJobEnhancements(config, opts(undefined))
    expect(tasksOf(config)).toHaveLength(5)
    expect((config.jobs as { autoRun?: unknown }).autoRun).toBeUndefined()
    // No schedule attached when the host set no autoRun crons.
    expect(tasksOf(config).every((t) => t.schedule === undefined)).toBe(true)
  })

  it('attaches a task schedule for each configured cron on the socials queue', () => {
    const config = {} as Config
    applyJobEnhancements(
      config,
      opts(
        {
          connectionRefreshCron: '0 3 * * *',
          cron: '*/5 * * * *',
          insightsRefreshCron: '0 9 * * *',
        },
        'operator-socials',
      ),
    )
    expect(bySlug(config, SOCIAL_POST_SWEEP_TASK_SLUG)?.schedule).toEqual([
      { cron: '*/5 * * * *', queue: 'operator-socials' },
    ])
    expect(bySlug(config, SOCIAL_INSIGHTS_REFRESH_TASK_SLUG)?.schedule).toEqual([
      { cron: '0 9 * * *', queue: 'operator-socials' },
    ])
    expect(bySlug(config, SOCIAL_CONNECTION_REFRESH_TASK_SLUG)?.schedule).toEqual([
      { cron: '0 3 * * *', queue: 'operator-socials' },
    ])
  })

  it('schedules only the tasks whose cron is set (refresh crons without a sweep cron)', () => {
    const config = {} as Config
    applyJobEnhancements(config, opts({ insightsRefreshCron: '0 9 * * *' }))
    expect(bySlug(config, SOCIAL_POST_SWEEP_TASK_SLUG)?.schedule).toBeUndefined()
    expect(bySlug(config, SOCIAL_INSIGHTS_REFRESH_TASK_SLUG)?.schedule).toEqual([
      { cron: '0 9 * * *', queue: 'socials' },
    ])
  })

  it('uses a custom queue for helper-enqueued jobs even when no cron is configured', async () => {
    const config = {} as Config
    applyJobEnhancements(config, opts(undefined, 'operator-socials'))
    const queue = vi.fn().mockResolvedValue({ id: 'job-1' })
    const payload = { jobs: { queue } } as unknown as Payload

    await config.onInit?.(payload)
    await queueSocialPostPublish({ payload, postId: 'post-1' })

    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'operator-socials',
        task: 'socialPostPublish',
      }),
    )
  })
})
