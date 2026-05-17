import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'
import type * as PublishModule from '../publish.js'

import { ValidationError } from '../../../utilities/errors.js'

vi.mock('../../../services/connectionService.js', () => ({
  getCredentials: vi.fn(),
  recordConnectionError: vi.fn(),
}))
vi.mock('../oauth.js', () => ({
  buildAuthorizeUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth'),
  exchangeCodeForTokens: vi.fn(),
}))
vi.mock('../insights.js', () => ({ getGbpInsightsForRef: vi.fn() }))
vi.mock('../publish.js', async (importActual) => ({
  ...(await importActual<typeof PublishModule>()),
  deleteGbpLocalPost: vi.fn(),
  publishGbpLocalPost: vi.fn(),
}))

import { getCredentials, recordConnectionError } from '../../../services/connectionService.js'
import { createGbpAdapter } from '../adapter.js'
import { getGbpInsightsForRef } from '../insights.js'
import { deleteGbpLocalPost, publishGbpLocalPost } from '../publish.js'

const buildOptions = (serviceAccount?: { clientEmail: string }): NormalizedPluginOptions =>
  ({
    copyOverrides: {},
    platforms: { gbp: { enabled: true, serviceAccount } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const payload = {} as Payload
const adapter = createGbpAdapter(options)

const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'A hand-carved marble lion.',
  baseTitle: 'Marble Lion',
  images: [{ role: 'main', url: 'https://cdn/main.jpg' }],
  link: 'https://example.com/p',
  sourceId: '1',
  sourceKind: 'product',
  ...over,
})

const STANDARD = {
  locationResourceName: 'accounts/a/locations/l',
  summary: 'Hello world',
  topicType: 'STANDARD' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gbp adapter — validate', () => {
  it('passes a valid STANDARD post', async () => {
    const result = await adapter.validate({ ctx: ctx(), input: STANDARD, options })
    expect(result.ok).toBe(true)
  })

  it('requires a locationResourceName', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { ...STANDARD, locationResourceName: '' },
      options,
    })
    expect(result.issues.some((i) => i.field === 'locationResourceName')).toBe(true)
  })

  it('rejects an over-long summary', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { ...STANDARD, summary: 'x'.repeat(1600) },
      options,
    })
    expect(result.issues.some((i) => i.field === 'summary')).toBe(true)
  })

  it('requires an event for EVENT and OFFER, and an offer for OFFER', async () => {
    const event = await adapter.validate({
      ctx: ctx(),
      input: { ...STANDARD, topicType: 'EVENT' },
      options,
    })
    expect(event.ok).toBe(false)
    const offer = await adapter.validate({
      ctx: ctx(),
      input: {
        ...STANDARD,
        event: {
          schedule: {
            endDate: { day: 7, month: 6, year: 2026 },
            startDate: { day: 1, month: 6, year: 2026 },
          },
          title: 'Sale',
        },
        topicType: 'OFFER',
      },
      options,
    })
    expect(offer.issues.some((i) => /offer block/.test(i.message))).toBe(true)
  })

  it('requires alertType for ALERT', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { ...STANDARD, topicType: 'ALERT' },
      options,
    })
    expect(result.issues.some((i) => /alertType/.test(i.message))).toBe(true)
  })
})

describe('gbp adapter — isConnected', () => {
  it('is connected when a service account is configured', async () => {
    const state = await adapter.isConnected({
      options: buildOptions({ clientEmail: 'svc@x.iam.gserviceaccount.com' }),
      payload,
    })
    expect(state.connected).toBe(true)
    expect(state.accountLabel).toBe('svc@x.iam.gserviceaccount.com')
    expect(getCredentials).not.toHaveBeenCalled()
  })

  it('is disconnected without a refresh token', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    expect((await adapter.isConnected({ options, payload })).connected).toBe(false)
  })

  it('is connected with a stored refresh token', async () => {
    vi.mocked(getCredentials).mockResolvedValue({ refreshToken: 'rt' } as never)
    expect((await adapter.isConnected({ options, payload })).connected).toBe(true)
  })
})

describe('gbp adapter — publish + delete', () => {
  it('publishes a valid input', async () => {
    vi.mocked(publishGbpLocalPost).mockResolvedValue({
      alreadyExisted: false,
      postId: 'r',
      publishedRef: { externalId: 'lp_1', platform: 'gbp' },
      state: 'LIVE',
    })
    const ref = await adapter.publish({ ctx: ctx(), input: STANDARD, options, payload, postId: '' })
    expect(ref.externalId).toBe('lp_1')
  })

  it('throws on invalid input', async () => {
    await expect(
      adapter.publish({
        ctx: ctx(),
        input: { ...STANDARD, locationResourceName: '' },
        options,
        payload,
        postId: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(publishGbpLocalPost).not.toHaveBeenCalled()
  })

  it('records a connection error on upstream failure', async () => {
    vi.mocked(publishGbpLocalPost).mockRejectedValue(new Error('boom'))
    await expect(
      adapter.publish({ ctx: ctx(), input: STANDARD, options, payload, postId: '' }),
    ).rejects.toThrow('boom')
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'gbp', expect.any(Error))
  })

  it('delegates delete', async () => {
    const ref: PublishedRef = { externalId: 'lp_1', platform: 'gbp' }
    await adapter.delete?.({ options, payload, publishedRef: ref })
    expect(deleteGbpLocalPost).toHaveBeenCalledWith({ options, payload, publishedRef: ref })
  })

  it('delegates insights with the requested range', async () => {
    const ref: PublishedRef = {
      externalId: 'accounts/a/locations/l/localPosts/p',
      platform: 'gbp',
    }
    const range = { end: '2026-07-12T00:00:00Z', start: '2026-07-01T00:00:00Z' }
    vi.mocked(getGbpInsightsForRef).mockResolvedValue({ metrics: { views: 2 } } as never)
    await expect(
      adapter.getInsights?.({ options, payload, publishedRef: ref, range }),
    ).resolves.toEqual({ metrics: { views: 2 } })
    expect(getGbpInsightsForRef).toHaveBeenCalledWith({
      options,
      payload,
      publishedRef: ref,
      range,
    })
  })
})
