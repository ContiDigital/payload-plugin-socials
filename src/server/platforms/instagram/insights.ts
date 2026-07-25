import type { Payload } from 'payload'

import type { NormalizedPluginOptions, PublishedRef } from '../../../types/index.js'

import { metaJson } from '../_meta/api.js'
import { fetchMetaInsightsWithFallback } from '../_meta/insights.js'

export const INSTAGRAM_FEED_INSIGHT_METRICS = [
  'comments',
  'likes',
  'reach',
  'reposts',
  'saved',
  'shares',
  'total_interactions',
  'views',
] as const

export const INSTAGRAM_REELS_INSIGHT_METRICS = [
  ...INSTAGRAM_FEED_INSIGHT_METRICS,
  'ig_reels_avg_watch_time',
  'ig_reels_video_view_total_time',
  'reels_skip_rate',
] as const

export const INSTAGRAM_STORY_INSIGHT_METRICS = [
  'follows',
  'profile_visits',
  'reach',
  'replies',
  'reposts',
  'shares',
  'total_interactions',
  'views',
] as const

type InstagramMediaProductType = 'FEED' | 'REELS' | 'STORY'

type InstagramMediaInfo = {
  media_product_type?: InstagramMediaProductType
  media_type?: 'CAROUSEL_ALBUM' | 'IMAGE' | 'VIDEO'
}

type InstagramInsight = {
  description?: string
  id?: string
  name: string
  period?: string
  title?: string
  total_value?: { value?: unknown }
  values?: Array<{ end_time?: string; value?: unknown }>
}

type InstagramInsightsResponse = { data?: InstagramInsight[] }

const productTypeFromPublishedRef = (
  publishedRef: PublishedRef,
): InstagramMediaProductType | undefined => {
  const value = publishedRef.meta?.mediaType
  if (value === 'REELS') {
    return 'REELS'
  }
  if (value === 'STORIES') {
    return 'STORY'
  }
  if (value === 'IMAGE' || value === 'CAROUSEL' || value === 'VIDEO') {
    return 'FEED'
  }
  return undefined
}

const metricsFor = (productType: InstagramMediaProductType): readonly string[] => {
  if (productType === 'REELS') {
    return INSTAGRAM_REELS_INSIGHT_METRICS
  }
  if (productType === 'STORY') {
    return INSTAGRAM_STORY_INSIGHT_METRICS
  }
  return INSTAGRAM_FEED_INSIGHT_METRICS
}

const summarize = (data: InstagramInsight[]): Record<string, unknown> =>
  Object.fromEntries(
    data.map((metric) => {
      const values = metric.values ?? []
      const value = metric.total_value?.value ?? values.at(-1)?.value
      return [metric.name, value ?? null]
    }),
  )

export type InstagramMediaInsightsSnapshot = {
  fetchedAt: string
  mediaId: string
  mediaProductType: InstagramMediaProductType
  metrics: Record<string, unknown>
  raw: InstagramInsightsResponse
  unavailableMetrics: string[]
}

export const getInstagramInsightsForRef = async (args: {
  metrics?: readonly string[]
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<InstagramMediaInsightsSnapshot> => {
  let mediaProductType = productTypeFromPublishedRef(args.publishedRef)
  if (!mediaProductType) {
    const media = await metaJson<InstagramMediaInfo>(
      args.payload,
      args.options,
      'instagram',
      `/${encodeURIComponent(args.publishedRef.externalId)}?fields=media_product_type,media_type`,
    )
    mediaProductType = media.media_product_type ?? 'FEED'
  }

  const { raw, unavailableMetrics } = await fetchMetaInsightsWithFallback<InstagramInsight>({
    fetch: (metrics) => {
      const params = new URLSearchParams({ metric: metrics.join(',') })
      return metaJson<InstagramInsightsResponse>(
        args.payload,
        args.options,
        'instagram',
        `/${encodeURIComponent(args.publishedRef.externalId)}/insights?${params.toString()}`,
      )
    },
    metrics: args.metrics ?? metricsFor(mediaProductType),
  })

  return {
    fetchedAt: new Date().toISOString(),
    mediaId: args.publishedRef.externalId,
    mediaProductType,
    metrics: summarize(raw.data ?? []),
    raw,
    unavailableMetrics,
  }
}
