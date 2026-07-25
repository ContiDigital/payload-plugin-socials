import type { Config, Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { applyScheduledSync } from '../applyScheduledSync.js'

type AutoRunInput = {
  connectionRefreshCron?: string
  cron?: string
  insightsRefreshCron?: string
}

const buildOptions = (autoRun: AutoRunInput | undefined): NormalizedPluginOptions =>
  ({
    api: { basePath: '/socials' },
    scheduling: { autoRun, queue: 'socials' },
  }) as unknown as NormalizedPluginOptions

const mkPayload = (info = vi.fn()): Payload =>
  ({ logger: { debug: vi.fn(), error: vi.fn(), info, warn: vi.fn() } }) as unknown as Payload

describe('applyScheduledSync', () => {
  it('never writes to config.jobs.autoRun (operator owns the trigger)', async () => {
    const config = {} as Config
    applyScheduledSync(config, buildOptions({ cron: '*/15 * * * *' }))
    // The plugin must not create or mutate the host's autoRun array — it only
    // registers task schedules (in applyJobEnhancements) and logs a notice.
    expect((config.jobs as { autoRun?: unknown } | undefined)?.autoRun).toBeUndefined()
    // onInit is wrapped for the boot notice.
    await config.onInit?.(mkPayload())
  })

  it('returns the same config object', () => {
    const config = {} as Config
    expect(applyScheduledSync(config, buildOptions(undefined))).toBe(config)
  })

  it('logs a boot notice once per payload and runs the prior onInit', async () => {
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

  it('logs the external-trigger notice when no autoRun crons are set', async () => {
    const config = {} as Config
    applyScheduledSync(config, buildOptions(undefined))
    const info = vi.fn()
    await config.onInit?.(mkPayload(info))
    expect(info).toHaveBeenCalledTimes(1)
    const meta = info.mock.calls[0]?.[0] as { note?: string }
    expect(meta.note).toContain('/socials/internal/jobs/sweep')
  })
})
