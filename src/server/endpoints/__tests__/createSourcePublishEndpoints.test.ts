import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PayloadPluginSocialsConfig,
  PlatformAdapter,
  SocialSourceContext,
} from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../../plugin/jobQueue.js', () => ({ scheduleSocialPostPublish: vi.fn() }))

import { scheduleSocialPostPublish } from '../../../plugin/jobQueue.js'
import { getPlatformAdapter } from '../../platforms/registry.js'
import { __resetSourceResolverRegistry, registerSourceResolvers } from '../../sources/registry.js'
import {
  createHistoryEndpoint,
  createPreviewEndpoint,
  createPublishEndpoint,
  createValidateEndpoint,
} from '../createSourcePublishEndpoints.js'

const authorize = vi.fn()

const options = normalizePluginOptions({
  authorize,
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: {
    pinterest: { clientId: 'c', clientSecret: 's', enabled: true, redirectUri: 'https://x/cb' },
  },
  sources: { product: () => Promise.reject(new Error('stub')) },
} as PayloadPluginSocialsConfig)

const sampleCtx = (): SocialSourceContext => ({
  baseDescription: 'body',
  baseTitle: 'Marble Lion',
  images: [{ role: 'main', url: 'https://cdn/x.jpg' }],
  link: 'https://example.com/p',
  sourceId: '1',
  sourceKind: 'product',
})

const adapter = {
  id: 'pinterest',
  capabilities: { scheduling: true },
  preview: vi.fn(),
  publish: vi.fn(),
  validate: vi.fn(),
}

const makeReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({
    payload: {
      create: vi.fn().mockResolvedValue({ id: 'row_1' }),
      find: vi.fn().mockResolvedValue({ docs: [], totalDocs: 0 }),
      update: vi.fn().mockResolvedValue({ id: 'row_1' }),
    },
    routeParams: { platform: 'pinterest', sourceId: '1', sourceKind: 'product' },
    user: { id: 1 },
    ...over,
  }) as unknown as PayloadRequest

const run = (endpoint: Endpoint, req: PayloadRequest) =>
  (endpoint.handler as (r: PayloadRequest) => Promise<Response>)(req)

beforeEach(() => {
  vi.clearAllMocks()
  __resetSourceResolverRegistry()
  registerSourceResolvers({ product: () => Promise.resolve(sampleCtx()) })
  authorize.mockResolvedValue(true)
  adapter.preview.mockResolvedValue({ body: 'B', title: 'T' })
  adapter.publish.mockResolvedValue({ externalId: 'pin_1', platform: 'pinterest' })
  adapter.validate.mockResolvedValue({ issues: [], ok: true })
  vi.mocked(getPlatformAdapter).mockReturnValue(adapter as unknown as PlatformAdapter)
  vi.mocked(scheduleSocialPostPublish).mockResolvedValue({
    jobId: 'job_1',
    postId: 'post_1',
    scheduledAt: '2027-01-01T00:00:00.000Z',
  })
})

describe('createPreviewEndpoint', () => {
  it('returns the adapter preview for an authorized request', async () => {
    const res = await run(createPreviewEndpoint(options), makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.platform).toBe('pinterest')
    expect(body.preview).toEqual({ body: 'B', title: 'T' })
    expect(body.draft).toMatchObject({
      content: { body: 'body', link: 'https://example.com/p', title: 'Marble Lion' },
      source: { id: '1', kind: 'product' },
      version: 1,
    })
    expect(body.source).toEqual({ id: '1', kind: 'product' })
    expect(adapter.preview).toHaveBeenCalledTimes(1)
  })

  it('returns 401 when the request has no user', async () => {
    const res = await run(createPreviewEndpoint(options), makeReq({ user: null }))
    expect(res.status).toBe(401)
  })

  it('returns 403 when the host denies access', async () => {
    authorize.mockResolvedValue(false)
    const res = await run(createPreviewEndpoint(options), makeReq())
    expect(res.status).toBe(403)
  })

  it('returns 400 for an unknown platform', async () => {
    const res = await run(
      createPreviewEndpoint(options),
      makeReq({ routeParams: { platform: 'twitter', sourceId: '1', sourceKind: 'product' } }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the platform is not enabled', async () => {
    const res = await run(
      createPreviewEndpoint(options),
      makeReq({ routeParams: { platform: 'facebook', sourceId: '1', sourceKind: 'product' } }),
    )
    expect(res.status).toBe(404)
  })
})

describe('createValidateEndpoint', () => {
  it('returns structured adapter validation without publishing', async () => {
    adapter.validate.mockResolvedValue({
      issues: [{ field: 'boardId', message: 'boardId is required', severity: 'error' }],
      ok: false,
    })
    const res = await run(createValidateEndpoint(options), makeReq({ data: { boardId: '' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      platform: 'pinterest',
      validation: { ok: false },
    })
    expect(adapter.publish).not.toHaveBeenCalled()
  })
})

describe('createPublishEndpoint', () => {
  it('publishes immediately when no schedule is given', async () => {
    const res = await run(
      createPublishEndpoint(options),
      makeReq({ data: { boardId: 'b1', imageUrl: 'https://cdn/x.jpg' } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.publishedRef.externalId).toBe('pin_1')
    expect(adapter.publish).toHaveBeenCalledTimes(1)
    expect(scheduleSocialPostPublish).not.toHaveBeenCalled()
  })

  it('returns 400 when adapter validation fails', async () => {
    adapter.validate.mockResolvedValue({
      issues: [{ message: 'boardId is required', severity: 'error' }],
      ok: false,
    })
    const res = await run(createPublishEndpoint(options), makeReq({ data: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('boardId is required')
  })

  it('schedules the publish when scheduledAt is in the future', async () => {
    const when = new Date(Date.now() + 3_600_000).toISOString()
    const res = await run(
      createPublishEndpoint(options),
      makeReq({ data: { boardId: 'b1', imageUrl: 'https://cdn/x.jpg', scheduledAt: when } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scheduled).toBe(true)
    expect(body.jobId).toBe('job_1')
    expect(body.postId).toBe('post_1')
    expect(scheduleSocialPostPublish).toHaveBeenCalledTimes(1)
    expect(adapter.publish).not.toHaveBeenCalled()
    // scheduledAt must be stripped from the adapter input.
    const scheduleArg = vi.mocked(scheduleSocialPostPublish).mock.calls[0][0]
    expect(scheduleArg.queuedInput).not.toHaveProperty('scheduledAt')
  })
})

describe('createHistoryEndpoint', () => {
  it('returns the persisted post history for the source', async () => {
    const req = makeReq()
    vi.mocked(req.payload.find).mockResolvedValue({
      docs: [{ id: 'row_1' }],
      totalDocs: 1,
    } as never)
    const res = await run(createHistoryEndpoint(options), req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.posts).toHaveLength(1)
    expect(body.platform).toBe('pinterest')
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await run(createHistoryEndpoint(options), makeReq({ user: null }))
    expect(res.status).toBe(401)
  })
})
