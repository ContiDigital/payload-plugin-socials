import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../api.js', () => ({ pinterestJson: vi.fn() }))

import { pinterestJson } from '../api.js'
import { fetchPinAnalytics, getPinterestInsightsForRef } from '../insights.js'

const options = {} as NormalizedPluginOptions
const payload = {} as Payload

const calledUrl = (): string => vi.mocked(pinterestJson).mock.calls[0]?.[2]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchPinAnalytics', () => {
  it('builds the analytics request and normalizes the response', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({
      all: {
        daily_metrics: [{ data_status: 'READY', date: '2026-05-01', metrics: { IMPRESSION: 30 } }],
        summary_metrics: { IMPRESSION: 1820, SAVE: 14 },
      },
    })
    const snap = await fetchPinAnalytics({
      options,
      payload,
      pinId: 'pin_1',
      range: { end: '2026-05-15', start: '2026-05-01' },
    })
    expect(snap).toMatchObject({
      daily: [{ data_status: 'READY', date: '2026-05-01', metrics: { IMPRESSION: 30 } }],
      endDate: '2026-05-15',
      pinId: 'pin_1',
      startDate: '2026-05-01',
      summary: { IMPRESSION: 1820, SAVE: 14 },
    })
    expect(snap.fetchedAt).toBeTypeOf('string')
    expect(snap.raw).toBeDefined()

    const url = calledUrl()
    expect(url).toContain('/v5/pins/pin_1/analytics')
    expect(url).toContain('app_types=ALL')
    expect(url).toContain('start_date=2026-05-01')
    expect(url).toContain('end_date=2026-05-15')
    expect(decodeURIComponent(url)).toContain('metric_types=IMPRESSION,OUTBOUND_CLICK')
  })

  it('clamps the window to Pinterest 90-day cap', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({})
    await fetchPinAnalytics({
      options,
      payload,
      pinId: 'p',
      range: { end: '2026-06-01', start: '2026-01-01' },
    })
    const url = calledUrl()
    expect(url).toContain('end_date=2026-06-01')
    expect(url).toContain('start_date=2026-03-03') // 90 days before the end
  })

  it('forces the end to be at least the start', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({})
    await fetchPinAnalytics({
      options,
      payload,
      pinId: 'p',
      range: { end: '2026-01-01', start: '2026-05-01' },
    })
    const url = calledUrl()
    expect(url).toContain('end_date=2026-05-01')
    expect(url).toContain('start_date=2026-05-01')
  })

  it('falls back to a valid 90-day window for unparseable dates', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({})
    await fetchPinAnalytics({ options, payload, pinId: 'p', range: { end: 'nope', start: 'bad' } })
    const url = calledUrl()
    const start = url.match(/start_date=([0-9-]+)/)?.[1]
    const end = url.match(/end_date=([0-9-]+)/)?.[1]
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Date.parse(end ?? '') - Date.parse(start ?? '')).toBeGreaterThan(0)
  })

  it('honors a custom metric set', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({})
    await fetchPinAnalytics({
      metrics: ['IMPRESSION', 'SAVE'],
      options,
      payload,
      pinId: 'p',
      range: { end: '2026-05-15', start: '2026-05-01' },
    })
    expect(decodeURIComponent(calledUrl())).toContain('metric_types=IMPRESSION,SAVE')
  })
})

describe('getPinterestInsightsForRef', () => {
  it('delegates to fetchPinAnalytics with the externalId as the pin id', async () => {
    vi.mocked(pinterestJson).mockResolvedValue({ all: { summary_metrics: { IMPRESSION: 5 } } })
    const result = await getPinterestInsightsForRef({
      externalId: 'pin_9',
      options,
      payload,
      range: { end: '2026-05-15', start: '2026-05-01' },
    })
    expect(result.pinId).toBe('pin_9')
    expect(result.summary).toEqual({ IMPRESSION: 5 })
  })
})
