import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

import { PlatformApiError } from '../../../utilities/errors.js'

vi.mock('../../_meta/api.js', () => ({ metaJson: vi.fn() }))

import { metaJson } from '../../_meta/api.js'
import { getPageAccessToken, listManagedPages } from '../pages.js'

const mockedMetaJson = vi.mocked(metaJson)

const options = {
  platforms: { facebook: { apiVersion: 'v25.0', enabled: true } },
} as unknown as NormalizedPluginOptions
const payload = {} as Payload

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPageAccessToken', () => {
  it('returns the Page-scoped access token', async () => {
    mockedMetaJson.mockResolvedValue({ id: 'p1', access_token: 'PAGE_TOKEN' })
    expect(await getPageAccessToken(payload, options, 'p1')).toBe('PAGE_TOKEN')
  })

  it('throws a 403 when the credential cannot derive a Page token', async () => {
    mockedMetaJson.mockResolvedValue({ id: 'p1' })
    await expect(getPageAccessToken(payload, options, 'p1')).rejects.toMatchObject({
      platform: 'facebook',
      statusCode: 403,
    })
    await expect(getPageAccessToken(payload, options, 'p1')).rejects.toBeInstanceOf(
      PlatformApiError,
    )
  })
})

describe('listManagedPages', () => {
  it('maps entries and drops any without a name', async () => {
    mockedMetaJson.mockResolvedValue({
      data: [
        {
          id: 'p1',
          name: 'Page One',
          access_token: 't1',
          category: 'Retail',
          tasks: ['CREATE_CONTENT'],
        },
        { id: 'p2' },
      ],
      paging: {},
    })
    const pages = await listManagedPages(payload, options)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ id: 'p1', name: 'Page One', accessToken: 't1' })
  })

  it('follows pagination cursors until exhausted', async () => {
    let call = 0
    mockedMetaJson.mockImplementation(() => {
      call += 1
      if (call === 1) {
        return Promise.resolve({
          data: [{ id: 'p1', name: 'Page One', access_token: 't1' }],
          paging: { cursors: { after: 'cur' }, next: 'https://graph/next' },
        })
      }
      return Promise.resolve({
        data: [{ id: 'p2', name: 'Page Two', access_token: 't2' }],
        paging: {},
      })
    })
    const pages = await listManagedPages(payload, options)
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(mockedMetaJson).toHaveBeenCalledTimes(2)
  })
})
