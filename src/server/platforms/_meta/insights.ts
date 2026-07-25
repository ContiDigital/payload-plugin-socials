import { PlatformApiError } from '../../utilities/errors.js'

type InsightMetric = {
  name: string
}

type InsightsResponse<TMetric extends InsightMetric> = {
  data?: TMetric[]
  paging?: Record<string, unknown>
}

const isUnavailableMetricError = (error: unknown): boolean =>
  error instanceof PlatformApiError && (error.upstreamCode === 100 || error.upstreamCode === '100')

export const fetchMetaInsightsWithFallback = async <TMetric extends InsightMetric>(args: {
  fetch: (metrics: readonly string[]) => Promise<InsightsResponse<TMetric>>
  metrics: readonly string[]
}): Promise<{
  raw: InsightsResponse<TMetric>
  unavailableMetrics: string[]
}> => {
  const metrics = [...new Set(args.metrics.map((metric) => metric.trim()).filter(Boolean))]
  if (metrics.length === 0) {
    return { raw: { data: [] }, unavailableMetrics: [] }
  }

  try {
    return {
      raw: await args.fetch(metrics),
      unavailableMetrics: [],
    }
  } catch (error) {
    if (!isUnavailableMetricError(error)) {
      throw error
    }
  }

  const data: TMetric[] = []
  const unavailableMetrics: string[] = []
  for (const metric of metrics) {
    try {
      const response = await args.fetch([metric])
      data.push(...(response.data ?? []))
    } catch (error) {
      if (!isUnavailableMetricError(error)) {
        throw error
      }
      unavailableMetrics.push(metric)
    }
  }

  return {
    raw: { data },
    unavailableMetrics,
  }
}
