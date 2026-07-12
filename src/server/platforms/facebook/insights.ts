import type { Payload } from 'payload'

import type { NormalizedPluginOptions, PublishedRef } from '../../../types/index.js'

import { ValidationError } from '../../utilities/errors.js'
import { metaJson } from '../_meta/api.js'
import { getPageAccessToken } from './pages.js'

export const FACEBOOK_POST_INSIGHT_METRICS = [
  'post_impressions',
  'post_impressions_unique',
  'post_engaged_users',
  'post_clicks',
  'post_video_views',
  'post_reactions_by_type_total',
] as const

type FacebookInsight = {
  description?: string
  id?: string
  name: string
  period?: string
  title?: string
  total_value?: { value?: unknown }
  values?: Array<{ end_time?: string; value?: unknown }>
}

type FacebookInsightsResponse = {
  data?: FacebookInsight[]
  paging?: Record<string, unknown>
}

const resolvePageId = (publishedRef: PublishedRef): string => {
  const metaPageId = publishedRef.meta?.pageId
  if (typeof metaPageId === 'string' && metaPageId.trim()) {
    return metaPageId.trim()
  }
  const separator = publishedRef.externalId.indexOf('_')
  if (separator > 0) {
    return publishedRef.externalId.slice(0, separator)
  }
  throw new ValidationError(`Cannot resolve Facebook Page id for post "${publishedRef.externalId}"`)
}

const summarize = (data: FacebookInsight[]): Record<string, unknown> =>
  Object.fromEntries(
    data.map((metric) => {
      const values = metric.values ?? []
      const value = metric.total_value?.value ?? values.at(-1)?.value
      return [metric.name, value ?? null]
    }),
  )

export type FacebookPostInsightsSnapshot = {
  fetchedAt: string
  metrics: Record<string, unknown>
  pageId: string
  postId: string
  raw: FacebookInsightsResponse
}

export const getFacebookInsightsForRef = async (args: {
  metrics?: readonly string[]
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
}): Promise<FacebookPostInsightsSnapshot> => {
  const pageId = resolvePageId(args.publishedRef)
  const pageAccessToken = await getPageAccessToken(args.payload, args.options, pageId)
  const params = new URLSearchParams({
    metric: (args.metrics ?? FACEBOOK_POST_INSIGHT_METRICS).join(','),
    period: 'lifetime',
  })
  const raw = await metaJson<FacebookInsightsResponse>(
    args.payload,
    args.options,
    'facebook',
    `/${encodeURIComponent(args.publishedRef.externalId)}/insights?${params.toString()}`,
    undefined,
    { accessToken: pageAccessToken },
  )

  return {
    fetchedAt: new Date().toISOString(),
    metrics: summarize(raw.data ?? []),
    pageId,
    postId: args.publishedRef.externalId,
    raw,
  }
}
