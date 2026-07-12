import type { PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

vi.mock('../../server/platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../server/sources/registry.js', () => ({ resolveSourceContext: vi.fn() }))
vi.mock('../jobQueue.js', () => ({ queueSocialPostPublish: vi.fn() }))
vi.mock('../../server/services/connectionService.js', () => ({
  getCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}))

import { getPlatformAdapter } from '../../server/platforms/registry.js'
import { getCredentials, saveCredentials } from '../../server/services/connectionService.js'
import { resolveSourceContext } from '../../server/sources/registry.js'
import { queueSocialPostPublish } from '../jobQueue.js'
import {
  buildConnectionRefreshTaskConfig,
  buildInsightsRefreshTaskConfig,
  buildPublishTaskConfig,
  buildRetryTaskConfig,
  buildSweepTaskConfig,
  setPluginOptionsForTasks,
} from '../jobTaskDefinitions.js'

const options = {
  platforms: {
    facebook: { enabled: true },
    gbp: { enabled: true },
    instagram: { enabled: true },
    pinterest: { enabled: true },
  },
  rateLimit: { maxConcurrency: 4 },
  scheduling: {
    connectionRefreshWindowSeconds: 86_400,
    insightsRefreshWindowSeconds: 2_592_000,
    sweepBatchSize: 100,
  },
} as unknown as NormalizedPluginOptions

const mkReq = (payload: Record<string, unknown>): PayloadRequest =>
  ({ payload: { logger: undefined, ...payload } }) as unknown as PayloadRequest

const publish = buildPublishTaskConfig().handler
const retry = buildRetryTaskConfig().handler
const insights = buildInsightsRefreshTaskConfig().handler
const connectionRefresh = buildConnectionRefreshTaskConfig().handler
const sweep = buildSweepTaskConfig().handler

beforeEach(() => {
  vi.clearAllMocks()
  setPluginOptionsForTasks(options)
})

describe('socialPostPublish handler', () => {
  it('fails when the post is missing', async () => {
    const req = mkReq({ findByID: vi.fn().mockRejectedValue(new Error('nf')) })
    const result = await publish({ input: { postId: 1 }, req })
    expect(result).toEqual({ errorMessage: 'social-posts/1 not found', state: 'failed' })
  })

  it('is a no-op when already published', async () => {
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({ id: 1, externalId: 'pin_1', status: 'published' }),
    })
    const result = await publish({ input: { postId: 1 }, req })
    expect(result).toEqual({ output: { alreadyPublished: true, externalId: 'pin_1', postId: 1 } })
  })

  it('fails a cancelled post', async () => {
    const req = mkReq({ findByID: vi.fn().mockResolvedValue({ id: 1, status: 'cancelled' }) })
    expect(await publish({ input: { postId: 1 }, req })).toEqual({
      errorMessage: 'post is cancelled',
      state: 'failed',
    })
  })

  it('fails and marks the post when queuedInput is missing', async () => {
    const update = vi.fn().mockResolvedValue({})
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({ id: 1, meta: {}, status: 'queued' }),
      update,
    })
    const result = await publish({ input: { postId: 1 }, req })
    expect(result.state).toBe('failed')
    expect(update).toHaveBeenCalled()
  })

  it('fails when the source context cannot be resolved', async () => {
    vi.mocked(resolveSourceContext).mockRejectedValue(new Error('no resolver'))
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 1 }], errors: [] })
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({
        id: 1,
        meta: { queuedInput: { boardId: 'b' } },
        platform: 'pinterest',
        sourceId: 's',
        sourceKind: 'product',
        status: 'queued',
      }),
      update,
    })
    const result = await publish({ input: { postId: 1 }, req })
    expect(result.state).toBe('failed')
    expect(result.errorMessage).toBe('no resolver')
    expect(update).toHaveBeenCalled()
  })

  it('publishes and returns the external ref on success', async () => {
    vi.mocked(resolveSourceContext).mockResolvedValue({ images: [] } as never)
    const adapterPublish = vi
      .fn()
      .mockResolvedValue({ externalId: 'pin_1', externalUrl: 'https://p' })
    vi.mocked(getPlatformAdapter).mockReturnValue({ publish: adapterPublish } as never)
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({
        id: 9,
        meta: { queuedInput: { boardId: 'b' } },
        platform: 'pinterest',
        sourceId: 's',
        sourceKind: 'product',
        status: 'queued',
      }),
      update: vi.fn().mockResolvedValue({ docs: [{ id: 9 }], errors: [] }),
    })
    const result = await publish({ input: { postId: 9 }, req })
    expect(result).toEqual({ output: { externalId: 'pin_1', externalUrl: 'https://p', postId: 9 } })
    expect(adapterPublish).toHaveBeenCalled()
  })

  it('marks the post failed when the adapter publish throws', async () => {
    vi.mocked(resolveSourceContext).mockResolvedValue({ images: [] } as never)
    vi.mocked(getPlatformAdapter).mockReturnValue({
      publish: vi.fn().mockRejectedValue(new Error('upstream 500')),
    } as never)
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 1 }], errors: [] })
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({
        id: 1,
        meta: { queuedInput: { boardId: 'b' } },
        platform: 'pinterest',
        sourceId: 's',
        sourceKind: 'product',
        status: 'queued',
      }),
      update,
    })
    const result = await publish({ input: { postId: 1 }, req })
    expect(result.state).toBe('failed')
    expect(result.errorMessage).toBe('upstream 500')
    expect(update).toHaveBeenCalled()
  })

  it('does not publish when another worker already claimed the row', async () => {
    const adapterPublish = vi.fn()
    vi.mocked(getPlatformAdapter).mockReturnValue({ publish: adapterPublish } as never)
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({
        id: 8,
        meta: { queuedInput: { boardId: 'b' } },
        platform: 'pinterest',
        sourceId: 's',
        sourceKind: 'product',
        status: 'queued',
      }),
      update: vi.fn().mockResolvedValue({ docs: [], errors: [] }),
    })
    expect(await publish({ input: { postId: 8 }, req })).toEqual({
      output: { alreadyInProgress: true, postId: 8 },
    })
    expect(adapterPublish).not.toHaveBeenCalled()
  })

  it('regression: proceeds past claim and calls adapter.publish when bulk update returns real BulkOperationResult with docs', async () => {
    vi.mocked(resolveSourceContext).mockResolvedValue({ images: [] } as never)
    const adapterPublish = vi
      .fn()
      .mockResolvedValue({ externalId: 'ext_42', externalUrl: 'https://social/42' })
    vi.mocked(getPlatformAdapter).mockReturnValue({ publish: adapterPublish } as never)
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 42 }], errors: [] })
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({
        id: 42,
        meta: { queuedInput: { boardId: 'b', text: 'Hello' } },
        platform: 'pinterest',
        sourceId: 'src_1',
        sourceKind: 'product',
        status: 'queued',
      }),
      update,
    })
    const result = await publish({ input: { postId: 42 }, req })
    expect(adapterPublish).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      output: { externalId: 'ext_42', externalUrl: 'https://social/42', postId: 42 },
    })
  })
})

describe('socialPostRetry handler', () => {
  it('fails when the post is missing', async () => {
    const req = mkReq({ findByID: vi.fn().mockResolvedValue(null) })
    expect((await retry({ input: { postId: 1 }, req })).state).toBe('failed')
  })

  it('is a no-op when already published', async () => {
    const req = mkReq({ findByID: vi.fn().mockResolvedValue({ id: 1, status: 'published' }) })
    expect(await retry({ input: { postId: 1 }, req })).toEqual({
      output: { alreadyPublished: true, postId: 1 },
    })
  })

  it('re-queues a failed post', async () => {
    const update = vi.fn().mockResolvedValue({})
    const req = mkReq({
      findByID: vi.fn().mockResolvedValue({ id: 4, status: 'failed' }),
      update,
    })
    const result = await retry({ input: { postId: 4 }, req })
    expect(result).toEqual({ output: { postId: 4, requeued: true } })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued' }) }),
    )
    expect(queueSocialPostPublish).toHaveBeenCalled()
  })
})

describe('socialInsightsRefresh handler', () => {
  it('refreshes posts with an external id and skips those without', async () => {
    vi.mocked(getPlatformAdapter).mockReturnValue({
      getInsights: vi.fn().mockResolvedValue({ impressions: 5 }),
    } as never)
    const update = vi.fn().mockResolvedValue({})
    const find = vi.fn().mockResolvedValue({
      docs: [
        { id: 1, externalId: 'pin_1' },
        { id: 2, externalId: null },
      ],
    })
    const req = mkReq({ find, update })
    const result = await insights({ input: { platform: 'pinterest' }, req })
    expect(result.output.summaries).toEqual([
      { failed: 0, platform: 'pinterest', refreshed: 1, skipped: 1 },
    ])
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('skips a platform whose adapter has no getInsights', async () => {
    vi.mocked(getPlatformAdapter).mockReturnValue({} as never)
    const req = mkReq({ find: vi.fn() })
    const result = await insights({ input: { platform: 'facebook' }, req })
    expect(result.output.summaries[0]).toMatchObject({ refreshed: 0 })
  })
})

describe('socialConnectionRefresh handler', () => {
  it('refreshes a token that is about to expire', async () => {
    vi.mocked(getCredentials).mockResolvedValue({
      accessToken: 'AT',
      accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString(),
      refreshToken: 'RT',
    } as never)
    const refreshToken = vi.fn().mockResolvedValue({ accessToken: 'NEW', refreshToken: 'NRT' })
    vi.mocked(getPlatformAdapter).mockReturnValue({ refreshToken } as never)
    const req = mkReq({})
    const result = await connectionRefresh({ input: { platform: 'pinterest' }, req })
    expect(result.output.refreshed).toEqual([{ platform: 'pinterest', refreshed: true }])
    expect(saveCredentials).toHaveBeenCalled()
  })

  it('skips a token with plenty of time left', async () => {
    vi.mocked(getCredentials).mockResolvedValue({
      accessToken: 'AT',
      accessTokenExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      refreshToken: 'RT',
    } as never)
    const result = await connectionRefresh({ input: { platform: 'pinterest' }, req: mkReq({}) })
    expect(result.output.refreshed).toEqual([{ platform: 'pinterest', refreshed: false }])
    expect(saveCredentials).not.toHaveBeenCalled()
  })

  it('refreshes legacy credentials that have no access-token expiry', async () => {
    vi.mocked(getCredentials).mockResolvedValue({ refreshToken: 'RT' } as never)
    const refreshToken = vi.fn().mockResolvedValue({ accessToken: 'NEW' })
    vi.mocked(getPlatformAdapter).mockReturnValue({ refreshToken } as never)
    const result = await connectionRefresh({ input: { platform: 'pinterest' }, req: mkReq({}) })
    expect(result.output.refreshed).toEqual([{ platform: 'pinterest', refreshed: true }])
    expect(refreshToken).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'RT' }))
  })

  it('reports not-refreshed when there are no credentials', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    const result = await connectionRefresh({ input: { platform: 'gbp' }, req: mkReq({}) })
    expect(result.output.refreshed).toEqual([{ platform: 'gbp', refreshed: false }])
  })
})

describe('socialPostSweep handler', () => {
  it('queues a publish task for each due post', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [{ id: 1 }, { id: 2 }] })
    const result = await sweep({ input: {}, req: mkReq({ find }) })
    expect(result.output).toEqual({ queued: 2, scanned: 2 })
    expect(queueSocialPostPublish).toHaveBeenCalledTimes(2)
  })
})
