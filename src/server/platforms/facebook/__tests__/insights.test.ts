import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, PublishedRef } from '../../../../types/index.js'

import { PlatformApiError } from '../../../utilities/errors.js'

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
  'post_media_view',
  'post_total_media_view_unique',
  'post_clicks',
  'post_reactions_by_type_total',
]

const unavailableMetricError = (): PlatformApiError =>
  new PlatformApiError({
    message: 'Invalid insights metric',
    platform: 'facebook',
    statusCode: 400,
    upstreamCode: 100,
  })

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
        { name: 'post_media_view', period: 'lifetime', values: [{ value: 100 }] },
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
      post_media_view: 100,
      post_reactions_by_type_total: { like: 3 },
    })
    expect(result.unavailableMetrics).toEqual([])

    // Assert the exact metric= parameter sent on the wire
    const call = vi.mocked(metaJson).mock.calls[0]
    const urlPath = String(call?.[3])
    const urlParams = new URLSearchParams(urlPath.split('?')[1] ?? '')
    const wireMetrics = urlParams.get('metric')?.split(',') ?? []
    expect(wireMetrics).toEqual(EXPECTED_METRICS)

    expect(call?.[5]).toEqual({ accessToken: 'PAGE_TOKEN' })
  })

  it('retries code-100 failures per metric and returns the available partial snapshot', async () => {
    vi.mocked(metaJson)
      .mockRejectedValueOnce(unavailableMetricError())
      .mockResolvedValueOnce({
        data: [{ name: 'post_media_view', total_value: { value: 100 } }],
      })
      .mockRejectedValueOnce(unavailableMetricError())
      .mockResolvedValueOnce({
        data: [{ name: 'post_clicks', total_value: { value: 7 } }],
      })
      .mockResolvedValueOnce({
        data: [{ name: 'post_reactions_by_type_total', total_value: { value: { like: 3 } } }],
      })

    const result = await getFacebookInsightsForRef({
      options,
      payload,
      publishedRef: {
        externalId: 'page_123_post_456',
        meta: { pageId: 'page_123' },
        platform: 'facebook',
      },
    })

    expect(result.metrics).toEqual({
      post_clicks: 7,
      post_media_view: 100,
      post_reactions_by_type_total: { like: 3 },
    })
    expect(result.unavailableMetrics).toEqual(['post_total_media_view_unique'])
    expect(metaJson).toHaveBeenCalledTimes(1 + EXPECTED_METRICS.length)
  })

  it('returns an empty successful snapshot when every requested metric is unavailable', async () => {
    vi.mocked(metaJson).mockRejectedValue(unavailableMetricError())

    const result = await getFacebookInsightsForRef({
      options,
      payload,
      publishedRef: {
        externalId: 'page_123_post_456',
        meta: { pageId: 'page_123' },
        platform: 'facebook',
      },
    })

    expect(result.metrics).toEqual({})
    expect(result.raw).toEqual({ data: [] })
    expect(result.unavailableMetrics).toEqual(EXPECTED_METRICS)
    expect(metaJson).toHaveBeenCalledTimes(1 + EXPECTED_METRICS.length)
  })

  it('rethrows missing-post code-100 errors without per-metric fallback', async () => {
    for (const graphError of [
      { error_subcode: 33, message: 'Unsupported get request' },
      { message: 'Object does not exist or cannot be loaded due to missing permissions' },
    ]) {
      const missingPostError = new PlatformApiError({
        message: 'Meta insights failed',
        platform: 'facebook',
        raw: { error: { code: 100, ...graphError } },
        statusCode: 400,
        upstreamCode: 100,
      })
      vi.mocked(metaJson).mockReset().mockRejectedValue(missingPostError)

      await expect(
        getFacebookInsightsForRef({
          options,
          payload,
          publishedRef: {
            externalId: 'page_123_deleted_post',
            meta: { pageId: 'page_123' },
            platform: 'facebook',
          },
        }),
      ).rejects.toBe(missingPostError)
      expect(metaJson).toHaveBeenCalledTimes(1)
    }
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
