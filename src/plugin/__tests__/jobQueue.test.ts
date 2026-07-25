import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import {
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIALS_QUEUE_NAME,
} from '../../constants.js'
import {
  queueSocialInsightsRefresh,
  queueSocialPostPublish,
  queueSocialPostRetry,
  runQueuedSocialsJobs,
  scheduleSocialPostPublish,
  setSocialsQueueName,
  sweepDueSocialPosts,
} from '../jobQueue.js'

const options = {
  scheduling: { drainBatchSize: 100, queue: SOCIALS_QUEUE_NAME, sweepBatchSize: 50 },
} as unknown as NormalizedPluginOptions

interface MockPayload {
  create: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  jobs: {
    cancelByID: ReturnType<typeof vi.fn>
    queue: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
  }
  logger: undefined
  update: ReturnType<typeof vi.fn>
}

let payload: MockPayload
const asPayload = (p: MockPayload): Payload => p as unknown as Payload

beforeEach(() => {
  payload = {
    create: vi.fn().mockResolvedValue({ id: 'post_1' }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    jobs: {
      cancelByID: vi.fn().mockResolvedValue(undefined),
      queue: vi.fn().mockResolvedValue({ id: 'job_1' }),
      run: vi.fn().mockResolvedValue(undefined),
    },
    logger: undefined,
    update: vi.fn().mockResolvedValue({ id: 'post_1' }),
  }
  setSocialsQueueName(asPayload(payload), SOCIALS_QUEUE_NAME)
})

describe('queue helpers', () => {
  it('queues a publish task on the socials queue and returns the job id', async () => {
    const id = await queueSocialPostPublish({ payload: asPayload(payload), postId: 'post_1' })
    expect(id).toBe('job_1')
    const arg = payload.jobs.queue.mock.calls[0][0]
    expect(arg).toMatchObject({
      input: { postId: 'post_1' },
      queue: SOCIALS_QUEUE_NAME,
      task: SOCIAL_POST_PUBLISH_TASK_SLUG,
    })
  })

  it('converts scheduledAt into a waitUntil Date', async () => {
    const when = new Date(Date.now() + 60_000).toISOString()
    await queueSocialPostPublish({ payload: asPayload(payload), postId: 'p', scheduledAt: when })
    expect(payload.jobs.queue.mock.calls[0][0].waitUntil).toBeInstanceOf(Date)
  })

  it('queues a retry task', async () => {
    await queueSocialPostRetry({ payload: asPayload(payload), postId: 'p' })
    expect(payload.jobs.queue.mock.calls[0][0].task).toBe(SOCIAL_POST_RETRY_TASK_SLUG)
  })

  it('uses the configured custom queue for queued tasks', async () => {
    setSocialsQueueName(asPayload(payload), 'custom-socials')
    await queueSocialPostPublish({ payload: asPayload(payload), postId: 'p' })
    expect(payload.jobs.queue.mock.calls[0][0].queue).toBe('custom-socials')
  })

  it('only includes optional fields in the insights-refresh input when provided', async () => {
    await queueSocialInsightsRefresh({ payload: asPayload(payload) })
    expect(payload.jobs.queue.mock.calls[0][0].input).toEqual({})

    payload.jobs.queue.mockClear()
    await queueSocialInsightsRefresh({
      limit: 10,
      payload: asPayload(payload),
      platform: 'pinterest',
      windowSeconds: 3600,
    })
    expect(payload.jobs.queue.mock.calls[0][0].input).toEqual({
      limit: 10,
      platform: 'pinterest',
      windowSeconds: 3600,
    })
  })
})

describe('runQueuedSocialsJobs', () => {
  it('drains the queue with the configured limit and queue name', async () => {
    await runQueuedSocialsJobs(asPayload(payload), options)
    expect(payload.jobs.run).toHaveBeenCalledWith({
      limit: 100,
      queue: SOCIALS_QUEUE_NAME,
      req: undefined,
    })
  })

  it('coalesces concurrent callers into a single in-flight run', async () => {
    let release: () => void = () => {}
    payload.jobs.run.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve()
      }),
    )
    const a = runQueuedSocialsJobs(asPayload(payload), options)
    const b = runQueuedSocialsJobs(asPayload(payload), options)
    expect(payload.jobs.run).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([a, b])
  })

  it('runs again after a prior drain settles', async () => {
    await runQueuedSocialsJobs(asPayload(payload), options)
    await runQueuedSocialsJobs(asPayload(payload), options)
    expect(payload.jobs.run).toHaveBeenCalledTimes(2)
  })

  it('propagates drain errors so external schedulers can retry', async () => {
    payload.jobs.run.mockRejectedValue(new Error('worker down'))
    await expect(runQueuedSocialsJobs(asPayload(payload), options)).rejects.toThrow('worker down')
  })
})

describe('sweepDueSocialPosts', () => {
  it('queues a publish for each due row and reports counts', async () => {
    payload.find.mockResolvedValue({
      docs: [
        { id: 'p1', status: 'queued' },
        { id: 'p2', status: 'queued' },
      ],
    })
    const result = await sweepDueSocialPosts(asPayload(payload), options)
    expect(result).toEqual({ queued: 2, scanned: 2 })
    expect(payload.jobs.queue).toHaveBeenCalledTimes(2)
  })

  it('counts only the rows it successfully queued', async () => {
    payload.find.mockResolvedValue({
      docs: [
        { id: 'p1', status: 'queued' },
        { id: 'p2', status: 'queued' },
      ],
    })
    payload.jobs.queue
      .mockResolvedValueOnce({ id: 'job_1' })
      .mockRejectedValueOnce(new Error('queue full'))
    const result = await sweepDueSocialPosts(asPayload(payload), options)
    expect(result).toEqual({ queued: 1, scanned: 2 })
  })
})

describe('scheduleSocialPostPublish', () => {
  const baseArgs = () => ({
    idempotencyKey: 'key-1',
    options,
    payload: asPayload(payload),
    platform: 'pinterest' as const,
    queuedInput: { boardId: 'b1', imageUrl: 'https://x/y.jpg' },
    scheduledAt: new Date(Date.now() + 3_600_000),
    sourceHash: 'hash-1',
    sourceId: '1',
    sourceKind: 'product',
  })

  it('creates a queued row, queues the publish, and stamps the job id', async () => {
    const result = await scheduleSocialPostPublish(baseArgs())
    expect(result.postId).toBe('post_1')
    expect(result.jobId).toBe('job_1')
    const created = payload.create.mock.calls[0][0].data
    expect(created.status).toBe('queued')
    expect(created.meta.queuedInput).toEqual({ boardId: 'b1', imageUrl: 'https://x/y.jpg' })
    expect(created.meta.scheduleToken).toEqual(expect.any(String))
    expect(payload.jobs.queue.mock.calls[0][0].input.scheduleToken).toBe(created.meta.scheduleToken)
    expect(payload.jobs.queue.mock.calls[0][0].waitUntil).toBeInstanceOf(Date)
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { queuedJobId: 'job_1' } }),
    )
  })

  it('short-circuits when an already-published row exists for the key', async () => {
    payload.find.mockResolvedValue({
      docs: [{ id: 'post_old', externalId: 'pin_1', status: 'published' }],
    })
    const result = await scheduleSocialPostPublish(baseArgs())
    expect(result.postId).toBe('post_old')
    expect(result.alreadyPublished).toBe(true)
    expect(result.externalId).toBe('pin_1')
    expect(payload.create).not.toHaveBeenCalled()
    expect(payload.jobs.queue).not.toHaveBeenCalled()
  })

  it('updates an existing non-published row in place', async () => {
    payload.find.mockResolvedValue({
      docs: [{ id: 'post_old', status: 'cancelled' }],
    })
    payload.update.mockResolvedValue({ id: 'post_old' })
    const result = await scheduleSocialPostPublish(baseArgs())
    expect(result.postId).toBe('post_old')
    expect(payload.create).not.toHaveBeenCalled()
    expect(payload.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'post_old' }))
  })

  it('cancels the previous queued job when rescheduling', async () => {
    payload.find.mockResolvedValue({
      docs: [{ id: 'post_old', queuedJobId: 'job_old', status: 'queued' }],
    })
    payload.update.mockResolvedValue({ id: 'post_old' })
    await scheduleSocialPostPublish(baseArgs())
    expect(payload.jobs.cancelByID).toHaveBeenCalledWith({ id: 'job_old' })
  })
})
