import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, PublishedRef } from '../../../../types/index.js'

vi.mock('../api.js', () => ({
  GBP_HOSTS: { legacyV4: 'https://mybusiness.googleapis.com' },
  gbpJson: vi.fn(),
}))

import { gbpJson } from '../api.js'
import { getGbpInsightsForRef } from '../insights.js'

const options = {} as NormalizedPluginOptions
const payload = {} as Payload
const publishedRef: PublishedRef = {
  externalId: 'accounts/a1/locations/l1/localPosts/p1',
  platform: 'gbp',
}

beforeEach(() => vi.clearAllMocks())

describe('getGbpInsightsForRef', () => {
  it('calls reportInsights and normalizes aggregate totals', async () => {
    vi.mocked(gbpJson).mockResolvedValue({
      localPostMetrics: [
        {
          localPostName: publishedRef.externalId,
          metricValues: [
            { metric: 'LOCAL_POST_VIEWS_SEARCH', totalValue: { value: '127' } },
            { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION', totalValue: { value: '3' } },
          ],
        },
      ],
      timeZone: 'America/New_York',
    })
    const result = await getGbpInsightsForRef({
      options,
      payload,
      publishedRef,
      range: { end: '2026-07-12T00:00:00Z', start: '2026-07-01T00:00:00Z' },
    })
    expect(result.metrics).toEqual({
      LOCAL_POST_ACTIONS_CALL_TO_ACTION: 3,
      LOCAL_POST_VIEWS_SEARCH: 127,
    })
    expect(result.timeZone).toBe('America/New_York')
    const [, , url, init] = vi.mocked(gbpJson).mock.calls[0] ?? []
    expect(url).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/a1/locations/l1/localPosts:reportInsights',
    )
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toMatchObject({
      localPostNames: [publishedRef.externalId],
    })
  })

  it('rejects a non-resource external id', async () => {
    await expect(
      getGbpInsightsForRef({
        options,
        payload,
        publishedRef: { externalId: 'p1', platform: 'gbp' },
        range: { end: '', start: '' },
      }),
    ).rejects.toThrow(/full local-post resource name/)
  })
})
