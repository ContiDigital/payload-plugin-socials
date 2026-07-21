import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../../plugin/jobQueue.js', () => ({
  queueSocialConnectionRefresh: vi.fn().mockResolvedValue('job_cr'),
  queueSocialInsightsRefresh: vi.fn().mockResolvedValue('job_ir'),
  queueSocialPostRetry: vi.fn().mockResolvedValue('job_rt'),
  queueSocialPostSweep: vi.fn().mockResolvedValue('job_sw'),
  runQueuedSocialsJobs: vi.fn().mockResolvedValue(undefined),
  sweepDueSocialPosts: vi.fn().mockResolvedValue({ queued: 2, scanned: 2 }),
}))
vi.mock('../../utilities/apiKeyAuth.js', () => ({ assertSchedulerApiKey: vi.fn() }))

import {
  queueSocialConnectionRefresh,
  queueSocialInsightsRefresh,
  queueSocialPostRetry,
  queueSocialPostSweep,
  runQueuedSocialsJobs,
  sweepDueSocialPosts,
} from '../../../plugin/jobQueue.js'
import { assertSchedulerApiKey } from '../../utilities/apiKeyAuth.js'
import { createInternalSchedulerEndpoints } from '../createInternalSchedulerEndpoints.js'

const options = {
  api: { basePath: '/socials' },
  scheduling: { internalApiKey: 'secret' },
} as unknown as NormalizedPluginOptions

const endpoints = createInternalSchedulerEndpoints(options)
const byPath = (suffix: string): Endpoint => {
  const found = endpoints.find((e) => e.path === `/socials/internal${suffix}`)
  if (!found) {
    throw new Error(`no endpoint for ${suffix}`)
  }
  return found
}

const mkReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, ...over }) as unknown as PayloadRequest

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createInternalSchedulerEndpoints — wiring', () => {
  it('registers all six POST endpoints under the internal base path', () => {
    expect(endpoints).toHaveLength(6)
    expect(endpoints.every((e) => e.method === 'post')).toBe(true)
    expect(endpoints.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        '/socials/internal/jobs/sweep',
        '/socials/internal/jobs/run',
        '/socials/internal/jobs/queue/:taskSlug',
        '/socials/internal/posts/:postId/retry',
        '/socials/internal/insights/refresh',
        '/socials/internal/connections/refresh',
      ]),
    )
  })
})

describe('sweep + run endpoints', () => {
  it('sweep sweeps then drains the queue', async () => {
    const res = await byPath('/jobs/sweep').handler(mkReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sweep: { queued: 2, scanned: 2 } })
    expect(sweepDueSocialPosts).toHaveBeenCalledOnce()
    expect(runQueuedSocialsJobs).toHaveBeenCalledOnce()
  })

  it('run drains the queue only', async () => {
    const res = await byPath('/jobs/run').handler(mkReq())
    expect(res.status).toBe(200)
    expect(sweepDueSocialPosts).not.toHaveBeenCalled()
    expect(runQueuedSocialsJobs).toHaveBeenCalledOnce()
  })

  it('returns a server error when Payload cannot drain the queue', async () => {
    vi.mocked(runQueuedSocialsJobs).mockRejectedValueOnce(new Error('database unavailable'))

    const res = await byPath('/jobs/run').handler(mkReq())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('rejects with the auth error status when the API key check fails', async () => {
    vi.mocked(assertSchedulerApiKey).mockImplementationOnce(() => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    })
    const res = await byPath('/jobs/sweep').handler(mkReq())
    expect(res.status).toBe(401)
    expect(sweepDueSocialPosts).not.toHaveBeenCalled()
  })
})

describe('queue-task endpoint', () => {
  const call = (taskSlug: string, body: Record<string, unknown> = {}) =>
    byPath('/jobs/queue/:taskSlug').handler(mkReq({ data: body, routeParams: { taskSlug } }))

  it('queues a sweep with an optional limit', async () => {
    const res = await call('socialPostSweep', { limit: 50 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      jobId: 'job_sw',
      ok: true,
      taskSlug: 'socialPostSweep',
    })
    expect(queueSocialPostSweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
  })

  it('queues a retry with a required postId', async () => {
    const res = await call('socialPostRetry', { postId: 5 })
    expect(res.status).toBe(200)
    expect(queueSocialPostRetry).toHaveBeenCalledWith(expect.objectContaining({ postId: 5 }))
  })

  it('queues an insights refresh with a validated platform', async () => {
    const res = await call('socialInsightsRefresh', { platform: 'pinterest', windowSeconds: 3600 })
    expect(res.status).toBe(200)
    expect(queueSocialInsightsRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'pinterest', windowSeconds: 3600 }),
    )
  })

  it('queues a connection refresh', async () => {
    const res = await call('socialConnectionRefresh', { platform: 'gbp' })
    expect(res.status).toBe(200)
    expect(queueSocialConnectionRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'gbp' }),
    )
  })

  it('refuses to queue socialPostPublish directly', async () => {
    const res = await call('socialPostPublish')
    expect(res.status).toBe(400)
  })

  it('rejects an unknown task slug', async () => {
    const res = await call('notARealTask')
    expect(res.status).toBe(400)
  })
})

describe('retry, insights, and connections endpoints', () => {
  it('retry-post queues a retry for the path post id', async () => {
    // Route params arrive as strings (URL path segments).
    const res = await byPath('/posts/:postId/retry').handler(
      mkReq({ routeParams: { postId: '7' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ jobId: 'job_rt', ok: true, postId: '7' })
    expect(queueSocialPostRetry).toHaveBeenCalledWith(expect.objectContaining({ postId: '7' }))
  })

  it('insights refresh queues and drains', async () => {
    const res = await byPath('/insights/refresh').handler(
      mkReq({ data: { limit: 10, platform: 'instagram' } }),
    )
    expect(res.status).toBe(200)
    expect(queueSocialInsightsRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, platform: 'instagram' }),
    )
    expect(runQueuedSocialsJobs).toHaveBeenCalledOnce()
  })

  it('connection refresh queues and drains', async () => {
    const res = await byPath('/connections/refresh').handler(
      mkReq({ data: { platform: 'facebook' } }),
    )
    expect(res.status).toBe(200)
    expect(queueSocialConnectionRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'facebook' }),
    )
    expect(runQueuedSocialsJobs).toHaveBeenCalledOnce()
  })
})
