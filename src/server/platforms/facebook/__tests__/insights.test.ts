import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, PublishedRef } from '../../../../types/index.js'

vi.mock('../../_meta/api.js', () => ({ metaJson: vi.fn() }))
vi.mock('../pages.js', () => ({ getPageAccessToken: vi.fn() }))

import { metaJson } from '../../_meta/api.js'
import { FACEBOOK_POST_INSIGHT_METRICS, getFacebookInsightsForRef } from '../insights.js'
import { getPageAccessToken } from '../pages.js'

const options = {} as NormalizedPluginOptions
const payload = {} as Payload

/**
 * The exact documented Facebook Graph API lifetime post-insight metrics.
 * This test asserts that the implementation requests precisely these, not
 * invented names that would trigger error #100 on the Graph API.
 */
const EXPECTED_METRICS = [
  'post_impressions',
  'post_impressions_unique',
  'post_engaged_users',
  'post_clicks',
  'post_video_views',
  'post_reactions_by_type_total',
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPageAccessToken).mockResolvedValue('PAGE_TOKEN')
})

describe('FACEBOOK_POST_INSIGHT_METRICS constant', () => {
  it('contains exactly the documented Graph API lifetime post metrics', () => {
    expect([...FACEBOOK_POST_INSIGHT_METRICS]).toEqual(EXPECTED_METRICS)
  })
})

describe('getFacebookInsightsForRef', () => {
  it('requests the documented metric set on the wire and normalizes values', async () => {
    vi.mocked(metaJson).mockResolvedValue({
      data: [
        { name: 'post_impressions', period: 'lifetime', values: [{ value: 100 }] },
        { name: 'post_reactions_by_type_total', total_value: { value: { like: 3 } } },
      ],
    })
    const publishedRef: PublishedRef = {
      externalId: 'page_123_post_456',
      meta: { pageId: 'page_123' },
      platform: 'facebook',
    }
    const result = await getFacebookInsightsForRef({ options, payload, publishedRef })

    expect(getPageAccessToken).toHaveBeenCalledWith(payload, options, 'page_123')
    expect(result.metrics).toEqual({
      post_impressions: 100,
      post_reactions_by_type_total: { like: 3 },
    })

    // Assert the exact metric= parameter sent on the wire
    const call = vi.mocked(metaJson).mock.calls[0]
    const urlPath = String(call?.[3])
    const urlParams = new URLSearchParams(urlPath.split('?')[1] ?? '')
    const wireMetrics = urlParams.get('metric')?.split(',') ?? []
    expect(wireMetrics).toEqual(EXPECTED_METRICS)

    expect(call?.[5]).toEqual({ accessToken: 'PAGE_TOKEN' })
  })

  it('falls back to the compound external id when row metadata is absent', async () => {
    vi.mocked(metaJson).mockResolvedValue({ data: [] })
    await getFacebookInsightsForRef({
      options,
      payload,
      publishedRef: { externalId: '987_654', platform: 'facebook' },
    })
    expect(getPageAccessToken).toHaveBeenCalledWith(payload, options, '987')
  })

  it('rejects a non-compound id without a Page id', async () => {
    await expect(
      getFacebookInsightsForRef({
        options,
        payload,
        publishedRef: { externalId: 'video-only-id', platform: 'facebook' },
      }),
    ).rejects.toThrow(/Cannot resolve Facebook Page id/)
  })
})
