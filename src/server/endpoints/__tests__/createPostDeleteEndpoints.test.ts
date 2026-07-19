import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PayloadPluginSocialsConfig, PlatformAdapter } from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))

import { getPlatformAdapter } from '../../platforms/registry.js'
import { createPostDeleteEndpoints } from '../createPostDeleteEndpoints.js'

const authorize = vi.fn()

const options = normalizePluginOptions({
  authorize,
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: {
    pinterest: { clientId: 'c', clientSecret: 's', enabled: true, redirectUri: 'https://x/cb' },
  },
  sources: { product: () => Promise.reject(new Error('stub')) },
} as PayloadPluginSocialsConfig)

const run = (endpoint: Endpoint, req: PayloadRequest) =>
  (endpoint.handler as (r: PayloadRequest) => Promise<Response>)(req)

const getEndpoint = () => createPostDeleteEndpoints(options)[0]

/** Minimal published row — pinterest (non-Instagram) by default. */
const publishedRow = {
  id: 'post_1',
  externalId: 'pin_abc',
  externalUrl: 'https://pinterest.com/pin/abc',
  meta: { boardId: 'board_1' },
  platform: 'pinterest',
  status: 'published',
}

/** Instagram row variant. */
const igRow = {
  id: 'ig_post_1',
  externalId: 'ig_media_abc',
  externalUrl: 'https://www.instagram.com/p/abc',
  meta: { mediaType: 'IMAGE' },
  platform: 'instagram',
  status: 'published',
}

/** Facebook row variant. */
const fbRow = {
  id: 'fb_post_1',
  externalId: 'fb_post_xyz',
  externalUrl: 'https://www.facebook.com/posts/xyz',
  meta: {},
  platform: 'facebook',
  status: 'published',
}

type AnyRow = {
  externalId: string
  externalUrl: string
  id: string
  meta: Record<string, unknown>
  platform: string
  status: string
}

const adapterDelete = vi.fn()

const mockAdapter = (deleteImpl: () => Promise<void> = () => Promise.resolve()) => {
  adapterDelete.mockImplementation(deleteImpl)
  vi.mocked(getPlatformAdapter).mockReturnValue({
    id: 'pinterest',
    delete: adapterDelete,
  } as unknown as PlatformAdapter)
}

const mockFacebookAdapter = (deleteImpl: () => Promise<void> = () => Promise.resolve()) => {
  adapterDelete.mockImplementation(deleteImpl)
  vi.mocked(getPlatformAdapter).mockReturnValue({
    id: 'facebook',
    delete: adapterDelete,
  } as unknown as PlatformAdapter)
}

type ReqWithMocks = {
  payload: { findByID: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
} & PayloadRequest

const makeReq = (
  overPayload: { findByID?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> } = {},
  overReq: Record<string, unknown> = {},
): ReqWithMocks => {
  const findByID = overPayload.findByID ?? vi.fn().mockResolvedValue(publishedRow)
  const update = overPayload.update ?? vi.fn().mockResolvedValue({ id: 'post_1' })
  return {
    payload: { findByID, update },
    query: {},
    routeParams: { postId: 'post_1' },
    user: { id: 42 },
    ...overReq,
  } as unknown as ReqWithMocks
}

const makeIgReq = (
  overPayload: { findByID?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> } = {},
  overReq: Record<string, unknown> = {},
): ReqWithMocks => {
  const findByID = overPayload.findByID ?? vi.fn().mockResolvedValue(igRow)
  const update = overPayload.update ?? vi.fn().mockResolvedValue({ id: 'ig_post_1' })
  return {
    payload: { findByID, update },
    query: {},
    routeParams: { postId: 'ig_post_1' },
    user: { id: 42 },
    ...overReq,
  } as unknown as ReqWithMocks
}

const makeLocalOnlyReq = (
  row: AnyRow = publishedRow,
  userId: number | string = 42,
): ReqWithMocks => {
  const findByID = vi.fn().mockResolvedValue(row)
  const update = vi.fn().mockResolvedValue({ id: row.id })
  return {
    payload: { findByID, update },
    query: { localOnly: 'true' },
    routeParams: { postId: String(row.id) },
    user: { id: userId },
  } as unknown as ReqWithMocks
}

beforeEach(() => {
  vi.clearAllMocks()
  authorize.mockResolvedValue(true)
  mockAdapter()
})

describe('createPostDeleteEndpoints — endpoint shape', () => {
  it('mounts a DELETE endpoint at {basePath}/posts/:postId', () => {
    const endpoint = getEndpoint()
    expect(endpoint.method).toBe('delete')
    expect(endpoint.path).toBe('/socials/posts/:postId')
  })
})

// ---------------------------------------------------------------------------
// Normal delete (non-Instagram)
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — happy path (non-Instagram)', () => {
  it('calls adapter.delete and marks the row deleted', async () => {
    const req = makeReq()
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, postId: 'post_1', status: 'deleted' })

    expect(vi.mocked(getPlatformAdapter)).toHaveBeenCalledWith('pinterest')
    expect(adapterDelete).toHaveBeenCalledTimes(1)
    expect(adapterDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedRef: expect.objectContaining({
          externalId: 'pin_abc',
          platform: 'pinterest',
        }),
      }),
    )

    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'post_1',
        data: expect.objectContaining({
          meta: expect.objectContaining({ deletedAt: expect.any(String), deletedBy: 42 }),
          status: 'deleted',
        }),
      }),
    )
  })

  it('records deletedBy as the authenticated user id', async () => {
    const req = makeReq({}, { user: { id: 99 } })
    await run(getEndpoint(), req)
    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meta: expect.objectContaining({ deletedBy: 99 }),
        }),
      }),
    )
  })

  it('treats upstream 404 as success (post already gone)', async () => {
    const notFoundErr = Object.assign(new Error('pin not found'), { statusCode: 404 })
    mockAdapter(() => Promise.reject(notFoundErr))
    const req = makeReq()
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Row should still be marked deleted even though upstream 404'd.
    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }),
    )
  })

  it('treats upstream "not found" message as success', async () => {
    const notFoundErr = new Error('media not found upstream')
    mockAdapter(() => Promise.reject(notFoundErr))
    const req = makeReq()
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('does NOT set deletedLocalOnly on a normal delete', async () => {
    const req = makeReq()
    await run(getEndpoint(), req)
    const updateCall = req.payload.update.mock.calls[0][0] as {
      data: { meta: Record<string, unknown> }
    }
    expect(updateCall.data.meta.deletedLocalOnly).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Facebook plain delete — adapter still called
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — Facebook plain delete', () => {
  it('calls adapter.delete for facebook rows and marks the row deleted', async () => {
    mockFacebookAdapter()
    const findByID = vi.fn().mockResolvedValue(fbRow)
    const update = vi.fn().mockResolvedValue({ id: 'fb_post_1' })
    const req = makeReq({ findByID, update }, { routeParams: { postId: 'fb_post_1' } })
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(200)
    expect(adapterDelete).toHaveBeenCalledTimes(1)
    expect(adapterDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedRef: expect.objectContaining({ platform: 'facebook' }),
      }),
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }),
    )
  })
})

// ---------------------------------------------------------------------------
// Instagram plain delete — 422, adapter NOT called
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — Instagram plain delete (unsupported)', () => {
  it('returns HTTP 422 for an instagram row without calling adapter or touching the row', async () => {
    const req = makeIgReq()
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error?: string; ok?: boolean }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/Instagram does not support/)
    expect(body.error).toMatch(/localOnly=true/)

    // Adapter must NOT be called.
    expect(adapterDelete).not.toHaveBeenCalled()
    // Row must NOT be touched.
    expect(req.payload.update).not.toHaveBeenCalled()
  })

  it('actionable message names the reconcile path', async () => {
    const req = makeIgReq()
    const res = await run(getEndpoint(), req)
    const { error } = (await res.json()) as { error: string }
    expect(error).toContain('Instagram app')
    expect(error).toContain('mark-deleted')
  })
})

// ---------------------------------------------------------------------------
// localOnly mode — any platform, adapter NOT called
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — localOnly (?localOnly=true)', () => {
  it('soft-deletes the pinterest row without calling the adapter', async () => {
    const req = makeLocalOnlyReq(publishedRow as AnyRow, 77)
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(adapterDelete).not.toHaveBeenCalled()
    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meta: expect.objectContaining({
            deletedAt: expect.any(String),
            deletedBy: 77,
            deletedLocalOnly: true,
          }),
          status: 'deleted',
        }),
      }),
    )
  })

  it('soft-deletes an instagram row in localOnly mode without calling the adapter', async () => {
    const req = makeLocalOnlyReq(igRow as AnyRow, 55)
    req.routeParams = { postId: 'ig_post_1' }
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(adapterDelete).not.toHaveBeenCalled()
    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meta: expect.objectContaining({ deletedLocalOnly: true }),
          status: 'deleted',
        }),
      }),
    )
  })

  it('same 404 guard applies in localOnly mode', async () => {
    const findByID = vi.fn().mockRejectedValue(new Error('not found'))
    const req = {
      payload: { findByID, update: vi.fn() },
      query: { localOnly: 'true' },
      routeParams: { postId: 'ghost' },
      user: { id: 1 },
    } as unknown as ReqWithMocks
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(404)
  })

  it('same non-published guard applies in localOnly mode', async () => {
    const findByID = vi.fn().mockResolvedValue({ ...publishedRow, status: 'failed' })
    const req = {
      payload: { findByID, update: vi.fn() },
      query: { localOnly: 'true' },
      routeParams: { postId: 'post_1' },
      user: { id: 1 },
    } as unknown as ReqWithMocks
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Reclaim: deletedLocalOnly instagram row can be re-published
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — deletedLocalOnly row is re-claimable', () => {
  it('localOnly=true produces a deleted row with status "deleted" that the publish path can reuse', async () => {
    // After localOnly soft-delete, the row has status "deleted".
    // The publish path (publicationReservation) treats "deleted" as re-claimable.
    // This test verifies the endpoint writes status: 'deleted' so the invariant holds.
    const req = makeLocalOnlyReq(igRow as AnyRow)
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(200)
    const updateArg = req.payload.update.mock.calls[0][0] as { data: { status: string } }
    expect(updateArg.data.status).toBe('deleted')
  })
})

// ---------------------------------------------------------------------------
// Error cases (pre-existing)
// ---------------------------------------------------------------------------

describe('createPostDeleteEndpoints — error cases', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await run(getEndpoint(), makeReq({}, { user: null }))
    expect(res.status).toBe(401)
  })

  it('returns 403 when the host denies access', async () => {
    authorize.mockResolvedValue(false)
    const res = await run(getEndpoint(), makeReq())
    expect(res.status).toBe(403)
  })

  it('returns 404 when the row does not exist', async () => {
    const findByID = vi.fn().mockRejectedValue(new Error('not found'))
    const update = vi.fn()
    const req = makeReq({ findByID, update })
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(404)
  })

  it('returns 404 when findByID resolves to null/empty', async () => {
    const findByID = vi.fn().mockResolvedValue(null)
    const update = vi.fn()
    const req = makeReq({ findByID, update })
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(404)
  })

  it('returns 400 when the row is not published', async () => {
    const findByID = vi.fn().mockResolvedValue({ ...publishedRow, status: 'failed' })
    const update = vi.fn()
    const req = makeReq({ findByID, update })
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('failed')
  })

  it('returns 400 when the row has no externalId', async () => {
    const findByID = vi.fn().mockResolvedValue({ ...publishedRow, externalId: null })
    const update = vi.fn()
    const req = makeReq({ findByID, update })
    const res = await run(getEndpoint(), req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('externalId')
  })

  it('returns the upstream error and does NOT mark the row deleted when adapter throws a non-404 error', async () => {
    const upstreamErr = Object.assign(new Error('Internal platform error'), { statusCode: 500 })
    mockAdapter(() => Promise.reject(upstreamErr))
    const update = vi.fn()
    const req = makeReq({ update })
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(500)
    // update must NOT have been called — the row stays published.
    expect(update).not.toHaveBeenCalled()
  })

  it('returns the upstream 403 error and does NOT mark the row deleted', async () => {
    const forbiddenErr = Object.assign(new Error('Forbidden by platform'), { statusCode: 403 })
    mockAdapter(() => Promise.reject(forbiddenErr))
    const update = vi.fn()
    const req = makeReq({ update })
    const res = await run(getEndpoint(), req)

    expect(res.status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })
})
