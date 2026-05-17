import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'
import type * as ApiModule from '../api.js'

vi.mock('../api.js', async (importActual) => ({
  ...(await importActual<typeof ApiModule>()),
  gbpJson: vi.fn(),
}))

import { gbpJson } from '../api.js'
import { listAccounts, listLocations, listPostablesLocations } from '../locations.js'

const payload = {} as Payload
const options = {} as NormalizedPluginOptions

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listAccounts', () => {
  it('extracts the account id and skips malformed names', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce({
      accounts: [
        { name: 'accounts/123', type: 'LOCATION_GROUP', accountName: 'Acme', role: 'MANAGER' },
        { name: 'not-an-account', accountName: 'X' },
      ],
      nextPageToken: null,
    } as never)
    const accounts = await listAccounts(payload, options)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ accountId: '123', accountName: 'Acme' })
  })

  it('follows the page token', async () => {
    vi.mocked(gbpJson)
      .mockResolvedValueOnce({ accounts: [{ name: 'accounts/1' }], nextPageToken: 'TOK' } as never)
      .mockResolvedValueOnce({ accounts: [{ name: 'accounts/2' }], nextPageToken: null } as never)
    const accounts = await listAccounts(payload, options)
    expect(accounts).toHaveLength(2)
    expect(vi.mocked(gbpJson).mock.calls[1]?.[2]).toContain('pageToken=TOK')
  })
})

describe('listLocations', () => {
  it('normalizes locations and builds the fully-qualified resource name', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce({
      locations: [
        {
          name: 'locations/loc1',
          categories: { primaryCategory: { displayName: 'Art gallery' } },
          metadata: { canOperateLocalPost: true, placeId: 'pid' },
          storeCode: 'SC',
          title: 'Store',
        },
        {
          name: 'accounts/123/locations/loc2',
          metadata: { canOperateLocalPost: false },
          title: 'Two',
        },
        { name: 'malformed', title: 'skip' },
      ],
      nextPageToken: null,
    } as never)
    const locations = await listLocations(payload, options, '123')
    expect(locations).toHaveLength(2)
    expect(locations[0]).toMatchObject({
      canOperateLocalPost: true,
      locationId: 'loc1',
      placeId: 'pid',
      primaryCategoryDisplay: 'Art gallery',
      resourceName: 'accounts/123/locations/loc1',
    })
    expect(locations[1]).toMatchObject({ canOperateLocalPost: false, locationId: 'loc2' })
  })
})

describe('listPostablesLocations', () => {
  it('flattens across accounts and keeps only postable locations', async () => {
    vi.mocked(gbpJson)
      .mockResolvedValueOnce({ accounts: [{ name: 'accounts/123' }], nextPageToken: null } as never)
      .mockResolvedValueOnce({
        locations: [
          { name: 'locations/a', metadata: { canOperateLocalPost: true }, title: 'A' },
          { name: 'locations/b', metadata: { canOperateLocalPost: false }, title: 'B' },
        ],
        nextPageToken: null,
      } as never)
    const postable = await listPostablesLocations(payload, options)
    expect(postable).toHaveLength(1)
    expect(postable[0]?.locationId).toBe('a')
  })
})
