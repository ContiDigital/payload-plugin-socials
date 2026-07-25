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
vi.mock('../../_meta/oauth.js', () => ({
  buildAuthorizeUrl: vi.fn(() => 'https://www.facebook.com/dialog/oauth'),
  exchangeCodeForTokens: vi.fn(),
}))
vi.mock('../insights.js', () => ({ getInstagramInsightsForRef: vi.fn() }))
vi.mock('../publish.js', async (importActual) => ({
  ...(await importActual<typeof PublishModule>()),
  publishInstagramMedia: vi.fn(),
}))

import { getCredentials, recordConnectionError } from '../../../services/connectionService.js'
import { createInstagramAdapter, INSTAGRAM_DELETE_UNSUPPORTED_MESSAGE } from '../adapter.js'
import { getInstagramInsightsForRef } from '../insights.js'
import { publishInstagramMedia } from '../publish.js'

const buildOptions = (systemUserAccessToken = ''): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true },
    copyOverrides: {},
    platforms: { instagram: { apiVersion: 'v25.0', enabled: true, systemUserAccessToken } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const payload = {} as Payload
const adapter = createInstagramAdapter(options)

const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'body',
  baseTitle: 'Marble Lion',
  images: [{ role: 'main', url: 'https://cdn/main.jpg' }],
  link: 'https://example.com/p',
  sourceId: '1',
  sourceKind: 'product',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('instagram adapter — validate', () => {
  it('requires igUserId and an image for an IMAGE post', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { igUserId: '', mediaType: 'IMAGE' },
      options,
    })
    expect(result.ok).toBe(false)
    const fields = result.issues.map((i) => i.field)
    expect(fields).toContain('igUserId')
    expect(fields).toContain('imageUrl')
  })

  it('passes a valid IMAGE post', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/x.jpg', mediaType: 'IMAGE' },
      options,
    })
    expect(result.ok).toBe(true)
  })

  it('requires videoUrl for REELS', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { igUserId: 'ig1', mediaType: 'REELS' },
      options,
    })
    expect(result.issues.some((i) => i.field === 'videoUrl')).toBe(true)
  })

  it('requires 2 to 10 children for a CAROUSEL', async () => {
    const tooFew = await adapter.validate({
      ctx: ctx(),
      input: { carouselChildren: [{ imageUrl: 'a' }], igUserId: 'ig1', mediaType: 'CAROUSEL' },
      options,
    })
    expect(tooFew.ok).toBe(false)
    const ok = await adapter.validate({
      ctx: ctx(),
      input: {
        carouselChildren: [{ imageUrl: 'a' }, { imageUrl: 'b' }],
        igUserId: 'ig1',
        mediaType: 'CAROUSEL',
      },
      options,
    })
    expect(ok.ok).toBe(true)
  })

  it('rejects an over-long caption', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: {
        caption: 'x'.repeat(2300),
        igUserId: 'ig1',
        imageUrl: 'https://cdn/x.jpg',
        mediaType: 'IMAGE',
      },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.field === 'caption')).toBe(true)
  })
})

describe('instagram adapter — isConnected', () => {
  it('is connected when a system-user token is configured', async () => {
    const state = await adapter.isConnected({ options: buildOptions('sys_tok'), payload })
    expect(state.connected).toBe(true)
    expect(getCredentials).not.toHaveBeenCalled()
  })

  it('is disconnected without a token', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    const state = await adapter.isConnected({ options, payload })
    expect(state.connected).toBe(false)
  })

  it('is connected when a stored access token exists', async () => {
    vi.mocked(getCredentials).mockResolvedValue({ accessToken: 'AT' } as never)
    expect((await adapter.isConnected({ options, payload })).connected).toBe(true)
  })
})

describe('instagram adapter — publish', () => {
  it('publishes a valid input', async () => {
    vi.mocked(publishInstagramMedia).mockResolvedValue({
      alreadyExisted: false,
      postId: 'r',
      publishedRef: { externalId: 'media_1', platform: 'instagram' },
    })
    const ref = await adapter.publish({
      ctx: ctx(),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/x.jpg', mediaType: 'IMAGE' },
      options,
      payload,
      postId: '',
    })
    expect(ref.externalId).toBe('media_1')
  })

  it('throws on invalid input without publishing', async () => {
    await expect(
      adapter.publish({ ctx: ctx(), input: { igUserId: '' }, options, payload, postId: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(publishInstagramMedia).not.toHaveBeenCalled()
  })

  it('records a connection error on upstream failure', async () => {
    vi.mocked(publishInstagramMedia).mockRejectedValue(new Error('boom'))
    await expect(
      adapter.publish({
        ctx: ctx(),
        input: { igUserId: 'ig1', imageUrl: 'https://cdn/x.jpg' },
        options,
        payload,
        postId: '',
      }),
    ).rejects.toThrow('boom')
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'instagram', expect.any(Error))
  })
})

describe('instagram adapter — delete (unsupported)', () => {
  it('throws the clear unsupported message immediately, without any network call', () => {
    const ref: PublishedRef = { externalId: 'media_1', platform: 'instagram' }
    // The method must throw synchronously (it's typed as never).
    expect(() => adapter.delete?.({ options, payload, publishedRef: ref })).toThrow(
      INSTAGRAM_DELETE_UNSUPPORTED_MESSAGE,
    )
  })

  it('throws a ValidationError (not a generic Error)', () => {
    const ref: PublishedRef = { externalId: 'media_1', platform: 'instagram' }
    expect(() => adapter.delete?.({ options, payload, publishedRef: ref })).toThrow(ValidationError)
  })

  it('does not invoke any fetch or Meta API call', () => {
    const ref: PublishedRef = { externalId: 'media_1', platform: 'instagram' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(() => adapter.delete?.({ options, payload, publishedRef: ref })).toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('message contains actionable reconcile instruction', () => {
    const ref: PublishedRef = { externalId: 'media_1', platform: 'instagram' }
    expect(() => adapter.delete?.({ options, payload, publishedRef: ref })).toThrow(
      /localOnly=true/,
    )
  })
})

describe('instagram adapter — getInsights', () => {
  it('delegates insights with the published ref', async () => {
    const ref: PublishedRef = { externalId: 'media_1', platform: 'instagram' }
    vi.mocked(getInstagramInsightsForRef).mockResolvedValue({ metrics: { views: 7 } } as never)
    await expect(
      adapter.getInsights?.({ options, payload, publishedRef: ref, range: { end: '', start: '' } }),
    ).resolves.toEqual({ metrics: { views: 7 } })
    expect(getInstagramInsightsForRef).toHaveBeenCalledWith({
      options,
      payload,
      publishedRef: ref,
    })
  })
})
