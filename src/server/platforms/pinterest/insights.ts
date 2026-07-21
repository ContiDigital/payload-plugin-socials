import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { pinterestJson } from './api.js'

/**
 * Pinterest analytics — `GET /v5/pins/{pin_id}/analytics`.
 *
 * The endpoint accepts a 90-day rolling window with
 * `start_date` / `end_date` (YYYY-MM-DD), a `metric_types` csv, and an
 * optional `split_field`. We always pull the canonical impression / click
 * / save / engagement set + the rate derivatives Pinterest is willing to
 * surface for organic pins, and clamp the window to Pinterest's 90-day
 * cap defensively.
 *
 * Analytics lag ~24–72h for finalized values; pin must have ≥1 impression
 * before any non-empty data is returned. The insights-refresh task is the
 * primary caller — it iterates `social-posts` rows in the recent window
 * and snapshots whatever Pinterest will hand us into
 * `socialPosts.insightsSnapshot`.
 */

const DEFAULT_METRICS = [
  'IMPRESSION',
  'OUTBOUND_CLICK',
  'PIN_CLICK',
  'SAVE',
  'ENGAGEMENT',
  'IMPRESSION_RATE',
  'PIN_CLICK_RATE',
  'OUTBOUND_CLICK_RATE',
  'SAVE_RATE',
  'TOTAL_REACTIONS',
  'TOTAL_COMMENTS',
  'VIDEO_MRC_VIEW',
  'VIDEO_AVG_WATCH_TIME',
] as const

const MAX_WINDOW_DAYS = 90

const clampRange = (start: string, end: string): { endDate: string; startDate: string } => {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    // Defensive fallback: last 90 days ending today.
    const now = new Date()
    const past = new Date(now.getTime() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    return {
      endDate: now.toISOString().slice(0, 10),
      startDate: past.toISOString().slice(0, 10),
    }
  }
  // Force end >= start.
  const safeEnd = Math.max(startMs, endMs)
  // Clamp to Pinterest's 90-day window.
  const oldestAllowed = safeEnd - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const clampedStart = Math.max(startMs, oldestAllowed)
  return {
    endDate: new Date(safeEnd).toISOString().slice(0, 10),
    startDate: new Date(clampedStart).toISOString().slice(0, 10),
  }
}

export type PinterestPinAnalyticsSnapshot = {
  daily?: Array<{ data_status?: string; date: string; metrics?: Record<string, number> }>
  endDate: string
  fetchedAt: string
  pinId: string
  raw: unknown
  startDate: string
  summary?: Record<string, number>
}

type PinAnalyticsResponse = {
  all?: {
    daily_metrics?: Array<{
      data_status?: string
      date: string
      metrics?: Record<string, number>
    }>
    summary_metrics?: Record<string, number>
  }
}

/**
 * Fetch analytics for a single pin. Returns a normalized snapshot the
 * adapter can persist verbatim onto the `social-posts` row.
 */
export const fetchPinAnalytics = async (args: {
  metrics?: readonly string[]
  options: NormalizedPluginOptions
  payload: Payload
  pinId: string
  range: { end: string; start: string }
}): Promise<PinterestPinAnalyticsSnapshot> => {
  const { options, payload, pinId } = args
  const { endDate, startDate } = clampRange(args.range.start, args.range.end)
  const params = new URLSearchParams({
    app_types: 'ALL',
    end_date: endDate,
    metric_types: (args.metrics ?? DEFAULT_METRICS).join(','),
    start_date: startDate,
  })
  const response = await pinterestJson<PinAnalyticsResponse>(
    payload,
    options,
    `/v5/pins/${encodeURIComponent(pinId)}/analytics?${params.toString()}`,
  )

  return {
    daily: response.all?.daily_metrics,
    endDate,
    fetchedAt: new Date().toISOString(),
    pinId,
    raw: response,
    startDate,
    summary: response.all?.summary_metrics,
  }
}

/**
 * Convenience for the adapter's `getInsights` method — takes the canonical
 * PublishedRef shape the plugin's task handlers use.
 */
export const getPinterestInsightsForRef = async (args: {
  externalId: string
  options: NormalizedPluginOptions
  payload: Payload
  range: { end: string; start: string }
}): Promise<Record<string, unknown>> => {
  const snapshot = await fetchPinAnalytics({
    options: args.options,
    payload: args.payload,
    pinId: args.externalId,
    range: args.range,
  })
  return snapshot as unknown as Record<string, unknown>
}
