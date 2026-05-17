import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/gbp/locations.js', () => ({
  listAccounts: vi.fn(),
  listLocations: vi.fn(),
  listPostablesLocations: vi.fn(),
}))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))

import {
  listAccounts,
  listLocations,
  listPostablesLocations,
} from '../../platforms/gbp/locations.js'
import { assertAccess } from '../../utilities/access.js'
import { createGbpLocationsEndpoints } from '../createGbpLocationsEndpoints.js'

const buildOptions = (enabled = true): NormalizedPluginOptions =>
  ({
    api: { basePath: '/socials' },
    platforms: { gbp: { enabled } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const mkReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, ...over }) as unknown as PayloadRequest

const find = (path: string): Endpoint => {
  const e = createGbpLocationsEndpoints(options).find((x) => x.path === `/socials${path}`)
  if (!e) {
    throw new Error(`no endpoint ${path}`)
  }
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
})

describe('gbp discovery endpoints', () => {
  it('lists accounts', async () => {
    vi.mocked(listAccounts).mockResolvedValue([{ name: 'accounts/123', accountId: '123' }] as never)
    const res = await find('/gbp/accounts').handler(mkReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accounts: [{ name: 'accounts/123', accountId: '123' }] })
  })

  it('lists locations for the account id in the path', async () => {
    vi.mocked(listLocations).mockResolvedValue([{ locationId: 'l1' }] as never)
    const res = await find('/gbp/accounts/:accountId/locations').handler(
      mkReq({ routeParams: { accountId: '123' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accountId: '123', locations: [{ locationId: 'l1' }] })
    expect(listLocations).toHaveBeenCalledWith(expect.anything(), options, '123')
  })

  it('400s a missing account id', async () => {
    const res = await find('/gbp/accounts/:accountId/locations').handler(mkReq({ routeParams: {} }))
    expect(res.status).toBe(400)
  })

  it('lists the flattened postable locations', async () => {
    vi.mocked(listPostablesLocations).mockResolvedValue([{ locationId: 'a' }] as never)
    const res = await find('/gbp/locations').handler(mkReq())
    expect(await res.json()).toEqual({ locations: [{ locationId: 'a' }] })
  })

  it('propagates an access rejection', async () => {
    vi.mocked(assertAccess).mockRejectedValueOnce(
      Object.assign(new Error('no'), { statusCode: 403 }),
    )
    const res = await find('/gbp/accounts').handler(mkReq())
    expect(res.status).toBe(403)
  })
})

describe('factory gating', () => {
  it('returns nothing when GBP is disabled', () => {
    expect(createGbpLocationsEndpoints(buildOptions(false))).toEqual([])
  })

  it('returns the three endpoints when enabled', () => {
    expect(createGbpLocationsEndpoints(options).map((e) => e.path)).toEqual([
      '/socials/gbp/accounts',
      '/socials/gbp/accounts/:accountId/locations',
      '/socials/gbp/locations',
    ])
  })
})
