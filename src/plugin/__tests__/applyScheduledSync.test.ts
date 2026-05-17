import type { Config, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { SOCIALS_QUEUE_NAME } from '../../constants.js'
import { applyScheduledSync } from '../applyScheduledSync.js'

type AutoRunInput = {
  connectionRefreshCron?: string
  cron: string
  insightsRefreshCron?: string
  queue?: string
}

const buildOptions = (autoRun: AutoRunInput | undefined): NormalizedPluginOptions =>
  ({ scheduling: { autoRun } }) as unknown as NormalizedPluginOptions

const autoRunOf = (config: Config): Array<{ cron: string; queue: string }> =>
  (config.jobs as { autoRun?: Array<{ cron: string; queue: string }> } | undefined)?.autoRun ?? []

const mkPayload = (info = vi.fn()): Payload =>
  ({ logger: { debug: vi.fn(), error: vi.fn(), info, warn: vi.fn() } }) as unknown as Payload

describe('applyScheduledSync', () => {
  it('returns the config untouched when autoRun is not configured', () => {
    const config = {} as Config
    expect(applyScheduledSync(config, buildOptions(undefined))).toBe(config)
    expect(config.jobs).toBeUndefined()
  })

  it('registers the sweep entry under the default socials queue', () => {
    const config = {} as Config
    applyScheduledSync(config, buildOptions({ cron: '*/15 * * * *' }))
    expect(autoRunOf(config)).toEqual([{ cron: '*/15 * * * *', queue: SOCIALS_QUEUE_NAME }])
  })

  it('registers insights and connection refresh entries when their crons are set', () => {
    const config = {} as Config
    applyScheduledSync(
      config,
      buildOptions({
        connectionRefreshCron: '0 3 * * *',
        cron: '*/15 * * * *',
        insightsRefreshCron: '0 9 * * *',
      }),
    )
    expect(autoRunOf(config).map((e) => e.cron)).toEqual(['*/15 * * * *', '0 9 * * *', '0 3 * * *'])
  })

  it('honors a custom queue name', () => {
    const config = {} as Config
    applyScheduledSync(config, buildOptions({ cron: 'c', queue: 'my-queue' }))
    expect(autoRunOf(config)[0]?.queue).toBe('my-queue')
  })

  it('is idempotent: re-applying does not stack entries', () => {
    const config = {} as Config
    const opts = buildOptions({ cron: '*/15 * * * *' })
    applyScheduledSync(config, opts)
    applyScheduledSync(config, opts)
    expect(autoRunOf(config)).toHaveLength(1)
  })

  it('preserves an existing autoRun array', () => {
    const config = {
      jobs: { autoRun: [{ cron: 'existing', queue: 'other' }], tasks: [] },
    } as unknown as Config
    applyScheduledSync(config, buildOptions({ cron: '*/15 * * * *' }))
    expect(autoRunOf(config)).toHaveLength(2)
  })

  it('wraps onInit to log the startup notice once per payload and runs the prior onInit', async () => {
    const existingOnInit = vi.fn()
    const config = { onInit: existingOnInit } as unknown as Config
    applyScheduledSync(config, buildOptions({ cron: '*/15 * * * *' }))

    const info = vi.fn()
    const payload = mkPayload(info)
    await config.onInit?.(payload)
    expect(existingOnInit).toHaveBeenCalledWith(payload)
    expect(info).toHaveBeenCalledTimes(1)

    // Same payload again: the WeakSet suppresses a duplicate startup log.
    await config.onInit?.(payload)
    expect(info).toHaveBeenCalledTimes(1)
  })
})
