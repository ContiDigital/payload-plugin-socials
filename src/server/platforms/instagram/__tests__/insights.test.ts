import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions, PublishedRef } from '../../../../types/index.js'

vi.mock('../../_meta/api.js', () => ({ metaJson: vi.fn() }))

import { metaJson } from '../../_meta/api.js'
import {
  getInstagramInsightsForRef,
  INSTAGRAM_FEED_INSIGHT_METRICS,
  INSTAGRAM_REELS_INSIGHT_METRICS,
  INSTAGRAM_STORY_INSIGHT_METRICS,
} from '../insights.js'

const options = {} as NormalizedPluginOptions
const payload = {} as Payload

beforeEach(() => {
  vi.clearAllMocks()
})

const ref = (mediaType?: string): PublishedRef => ({
  externalId: 'ig_media_1',
  meta: mediaType ? { mediaType } : undefined,
  platform: 'instagram',
})

describe('getInstagramInsightsForRef', () => {
  it.each([
    ['IMAGE', 'FEED', INSTAGRAM_FEED_INSIGHT_METRICS],
    ['CAROUSEL', 'FEED', INSTAGRAM_FEED_INSIGHT_METRICS],
    ['REELS', 'REELS', INSTAGRAM_REELS_INSIGHT_METRICS],
    ['STORIES', 'STORY', INSTAGRAM_STORY_INSIGHT_METRICS],
  ] as const)('uses a media-safe metric set for %s', async (mediaType, productType, metrics) => {
    vi.mocked(metaJson).mockResolvedValue({ data: [] })
    const result = await getInstagramInsightsForRef({
      options,
      payload,
      publishedRef: ref(mediaType),
    })

    expect(result.mediaProductType).toBe(productType)
    expect(metaJson).toHaveBeenCalledTimes(1)
    expect(decodeURIComponent(String(vi.mocked(metaJson).mock.calls[0]?.[3]))).toContain(
      `metric=${metrics.join(',')}`,
    )
  })

  it('discovers media product type for legacy rows and normalizes values', async () => {
    vi.mocked(metaJson)
      .mockResolvedValueOnce({ media_product_type: 'REELS', media_type: 'VIDEO' })
      .mockResolvedValueOnce({
        data: [
          { name: 'views', values: [{ value: 20 }, { value: 30 }] },
          { name: 'reach', total_value: { value: 12 } },
        ],
      })

    const result = await getInstagramInsightsForRef({ options, payload, publishedRef: ref() })
    expect(result.mediaProductType).toBe('REELS')
    expect(result.metrics).toEqual({ reach: 12, views: 30 })
    expect(metaJson).toHaveBeenCalledTimes(2)
    expect(vi.mocked(metaJson).mock.calls[0]?.[3]).toContain('fields=media_product_type')
  })

  it('honors a custom metric list', async () => {
    vi.mocked(metaJson).mockResolvedValue({ data: [] })
    await getInstagramInsightsForRef({
      metrics: ['reach'],
      options,
      payload,
      publishedRef: ref('IMAGE'),
    })
    expect(decodeURIComponent(String(vi.mocked(metaJson).mock.calls[0]?.[3]))).toContain(
      'metric=reach',
    )
  })
})
