import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/gbp/locations.js', () => ({
  listAccounts: vi.fn(),
  listAllLocations: vi.fn(),
  listLocations: vi.fn(),
  listPostablesLocations: vi.fn(),
}))
vi.mock('../../platforms/gbp/locationProfile.js', () => ({
  deleteLocation: vi.fn(),
  getLocation: vi.fn(),
  setOpenStatus: vi.fn(),
  updateLocation: vi.fn(),
}))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))

import {
  deleteLocation,
  getLocation,
  setOpenStatus,
  updateLocation,
} from '../../platforms/gbp/locationProfile.js'
import {
  listAccounts,
  listAllLocations,
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

const find = (path: string, method = 'get'): Endpoint => {
  const e = createGbpLocationsEndpoints(options).find(
    (x) => x.path === `/socials${path}` && x.method === method,
  )
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

  it('returns the discovery and listing endpoints when enabled', () => {
    expect(createGbpLocationsEndpoints(options).map((e) => `${e.method} ${e.path}`)).toEqual([
      'get /socials/gbp/accounts',
      'get /socials/gbp/accounts/:accountId/locations',
      'get /socials/gbp/locations',
      'get /socials/gbp/locations/:locationId',
      'patch /socials/gbp/locations/:locationId',
      'post /socials/gbp/locations/:locationId/open-status',
      'delete /socials/gbp/locations/:locationId',
    ])
  })
})

const LOCATION = '/gbp/locations/:locationId'
const scopes = () => vi.mocked(assertAccess).mock.calls.map((call) => call[2])

describe('gbp listing endpoints', () => {
  it('lists every listing with include=all and refuses an unknown include', async () => {
    vi.mocked(listAllLocations).mockResolvedValue([
      { locationId: 'a' },
      { locationId: 'b' },
    ] as never)
    const res = await find('/gbp/locations').handler(mkReq({ query: { include: 'all' } }))
    expect(await res.json()).toEqual({ locations: [{ locationId: 'a' }, { locationId: 'b' }] })
    expect(listPostablesLocations).not.toHaveBeenCalled()
    const bad = await find('/gbp/locations').handler(mkReq({ query: { include: 'stale' } }))
    expect(bad.status).toBe(400)
  })

  it('reads one listing with publisher access', async () => {
    vi.mocked(getLocation).mockResolvedValue({ locationId: '123', title: 'T' } as never)
    const res = await find(LOCATION).handler(mkReq({ routeParams: { locationId: '123' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ location: { locationId: '123', title: 'T' } })
    expect(getLocation).toHaveBeenCalledWith(expect.anything(), options, '123')
    expect(scopes()).toEqual(['publisher'])
  })

  it.each(['abc', 'locations/1', '1'.repeat(31)])('400s location id %j', async (locationId) => {
    const res = await find(LOCATION).handler(mkReq({ routeParams: { locationId } }))
    expect(res.status).toBe(400)
    expect(getLocation).not.toHaveBeenCalled()
  })

  it('updates the profile with admin access and passes validateOnly', async () => {
    vi.mocked(updateLocation).mockResolvedValue({
      updateMask: ['websiteUri'],
      validateOnly: true,
    } as never)
    const patch = { websiteUri: 'https://example.com/' }
    const res = await find(LOCATION, 'patch').handler(
      mkReq({ data: { patch, validateOnly: true }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updateMask: ['websiteUri'], validateOnly: true })
    expect(updateLocation).toHaveBeenCalledWith(expect.anything(), options, '123', patch, {
      validateOnly: true,
    })
    expect(scopes()).toEqual(['admin'])
  })

  it('400s a non-boolean validateOnly', async () => {
    const res = await find(LOCATION, 'patch').handler(
      mkReq({ data: { patch: {}, validateOnly: 'yes' }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(400)
    expect(updateLocation).not.toHaveBeenCalled()
  })

  it("surfaces Google's field violations on a rejected update", async () => {
    vi.mocked(updateLocation).mockRejectedValue(
      Object.assign(new Error('Google rejected the location update: bad phone'), {
        fieldViolations: [{ field: 'phoneNumbers.primaryPhone', message: 'bad phone' }],
        statusCode: 400,
      }),
    )
    const res = await find(LOCATION, 'patch').handler(
      mkReq({ data: { patch: {} }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Google rejected the location update: bad phone',
      fieldViolations: [{ field: 'phoneNumbers.primaryPhone', message: 'bad phone' }],
    })
  })

  it('changes the open status with admin access and the expected title', async () => {
    vi.mocked(setOpenStatus).mockResolvedValue({ updateMask: ['openInfo.status'] } as never)
    const res = await find(`${LOCATION}/open-status`, 'post').handler(
      mkReq({
        data: { expectedTitle: 'Old Listing', status: 'CLOSED_PERMANENTLY' },
        routeParams: { locationId: '123' },
      }),
    )
    expect(res.status).toBe(200)
    expect(setOpenStatus).toHaveBeenCalledWith(
      expect.anything(),
      options,
      '123',
      'CLOSED_PERMANENTLY',
      { expectedTitle: 'Old Listing', validateOnly: false },
    )
    expect(scopes()).toEqual(['admin'])
  })

  it('400s an unknown open status', async () => {
    const res = await find(`${LOCATION}/open-status`, 'post').handler(
      mkReq({ data: { status: 'GONE' }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(400)
    expect(setOpenStatus).not.toHaveBeenCalled()
  })

  it('deletes with admin access and the expected title from the query', async () => {
    vi.mocked(deleteLocation).mockResolvedValue({ deleted: true } as never)
    const res = await find(LOCATION, 'delete').handler(
      mkReq({ query: { expectedTitle: 'Old Listing' }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(200)
    expect(deleteLocation).toHaveBeenCalledWith(expect.anything(), options, '123', {
      expectedTitle: 'Old Listing',
    })
    expect(scopes()).toEqual(['admin'])
  })

  it('reports a 409 refusal from the delete guard', async () => {
    vi.mocked(deleteLocation).mockRejectedValue(
      Object.assign(new Error('A verified listing is closed, not deleted.'), { statusCode: 409 }),
    )
    const res = await find(LOCATION, 'delete').handler(
      mkReq({ routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(409)
  })

  it('denies the writes when the host refuses admin', async () => {
    vi.mocked(assertAccess).mockRejectedValue(Object.assign(new Error('no'), { statusCode: 403 }))
    const res = await find(LOCATION, 'patch').handler(
      mkReq({ data: { patch: {} }, routeParams: { locationId: '123' } }),
    )
    expect(res.status).toBe(403)
    expect(updateLocation).not.toHaveBeenCalled()
  })
})
