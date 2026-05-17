import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../_meta/api.js', () => ({ metaJson: vi.fn() }))

import { metaJson } from '../../_meta/api.js'
import { discoverIgAccountFromPage, listIgAccounts } from '../discovery.js'

const payload = {} as Payload
const options = {} as NormalizedPluginOptions

beforeEach(() => {
  vi.clearAllMocks()
})

describe('discoverIgAccountFromPage', () => {
  it('returns the linked IG account', async () => {
    vi.mocked(metaJson).mockResolvedValueOnce({
      id: 'p1',
      name: 'Fine Gallery',
      instagram_business_account: { id: 'ig1' },
    } as never)
    expect(await discoverIgAccountFromPage(payload, options, 'p1')).toEqual({
      igUserId: 'ig1',
      pageId: 'p1',
      pageName: 'Fine Gallery',
    })
  })

  it('returns null when the page has no linked IG account', async () => {
    vi.mocked(metaJson).mockResolvedValueOnce({
      id: 'p1',
      instagram_business_account: null,
    } as never)
    expect(await discoverIgAccountFromPage(payload, options, 'p1')).toBeNull()
  })
})

describe('listIgAccounts', () => {
  it('emits one entry per page that has a linked IG account', async () => {
    vi.mocked(metaJson).mockResolvedValueOnce({
      data: [
        { id: 'p1', name: 'A', instagram_business_account: { id: 'ig1' } },
        { id: 'p2', name: 'B', instagram_business_account: null },
      ],
      paging: {},
    } as never)
    expect(await listIgAccounts(payload, options)).toEqual([
      { igUserId: 'ig1', pageId: 'p1', pageName: 'A' },
    ])
  })

  it('walks the paging cursor across pages', async () => {
    vi.mocked(metaJson)
      .mockResolvedValueOnce({
        data: [{ id: 'p1', instagram_business_account: { id: 'ig1' } }],
        paging: { cursors: { after: 'CUR' }, next: 'https://next' },
      } as never)
      .mockResolvedValueOnce({
        data: [{ id: 'p2', instagram_business_account: { id: 'ig2' } }],
        paging: {},
      } as never)
    const accounts = await listIgAccounts(payload, options)
    expect(accounts).toHaveLength(2)
    expect(metaJson).toHaveBeenCalledTimes(2)
    expect(vi.mocked(metaJson).mock.calls[1]?.[3]).toContain('after=CUR')
  })
})
