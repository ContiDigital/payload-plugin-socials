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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPageAccessToken).mockResolvedValue('PAGE_TOKEN')
})

describe('getFacebookInsightsForRef', () => {
  it('uses current replacement metrics, a Page token, and normalizes values', async () => {
    vi.mocked(metaJson).mockResolvedValue({
      data: [
        { name: 'post_media_view', period: 'lifetime', values: [{ value: 42 }] },
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
      post_media_view: 42,
      post_reactions_by_type_total: { like: 3 },
    })
    const call = vi.mocked(metaJson).mock.calls[0]
    expect(decodeURIComponent(String(call?.[3]))).toContain(
      `metric=${FACEBOOK_POST_INSIGHT_METRICS.join(',')}`,
    )
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
