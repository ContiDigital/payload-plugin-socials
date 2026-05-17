import type { Payload } from 'payload'

import type { NormalizedPluginOptions, PublishedRef } from '../../../types/index.js'

import { ValidationError } from '../../utilities/errors.js'
import { GBP_HOSTS, gbpJson } from './api.js'

type GbpMetricValue = {
  metric?: string
  totalValue?: { value?: string }
}

type GbpInsightsResponse = {
  localPostMetrics?: Array<{
    localPostName?: string
    metricValues?: GbpMetricValue[]
  }>
  name?: string
  timeZone?: string
}

const locationNameForPost = (postName: string): string => {
  const marker = '/localPosts/'
  const index = postName.indexOf(marker)
  if (index <= 0) {
    throw new ValidationError(
      `GBP externalId must be a full local-post resource name; got "${postName}"`,
    )
  }
  return postName.slice(0, index)
}

export type GbpLocalPostInsightsSnapshot = {
  endTime: string
  fetchedAt: string
  localPostName: string
  metrics: Record<string, number | string>
  raw: GbpInsightsResponse
  startTime: string
  timeZone?: string
}

export const getGbpInsightsForRef = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  publishedRef: PublishedRef
  range: { end: string; start: string }
}): Promise<GbpLocalPostInsightsSnapshot> => {
  const localPostName = args.publishedRef.externalId
  const locationName = locationNameForPost(localPostName)
  const url = `${GBP_HOSTS.legacyV4}/v4/${locationName}/localPosts:reportInsights`
  const raw = await gbpJson<GbpInsightsResponse>(args.payload, args.options, url, {
    body: JSON.stringify({
      basicRequest: {
        metricRequests: [{ metric: 'ALL' }],
        timeRange: {
          endTime: args.range.end,
          startTime: args.range.start,
        },
      },
      localPostNames: [localPostName],
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const entry =
    raw.localPostMetrics?.find((candidate) => candidate.localPostName === localPostName) ??
    raw.localPostMetrics?.[0]
  const metrics = Object.fromEntries(
    (entry?.metricValues ?? []).flatMap((metric) => {
      if (!metric.metric || metric.totalValue?.value === undefined) {
        return []
      }
      const numeric = Number(metric.totalValue.value)
      return [[metric.metric, Number.isFinite(numeric) ? numeric : metric.totalValue.value]]
    }),
  )
  return {
    endTime: args.range.end,
    fetchedAt: new Date().toISOString(),
    localPostName,
    metrics,
    raw,
    startTime: args.range.start,
    timeZone: raw.timeZone,
  }
}
