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
vi.mock('../insights.js', () => ({ getFacebookInsightsForRef: vi.fn() }))
vi.mock('../publish.js', async (importActual) => ({
  ...(await importActual<typeof PublishModule>()),
  deleteFacebookPost: vi.fn(),
  publishFacebookPost: vi.fn(),
}))

import { getCredentials, recordConnectionError } from '../../../services/connectionService.js'
import { createFacebookAdapter } from '../adapter.js'
import { getFacebookInsightsForRef } from '../insights.js'
import { deleteFacebookPost, publishFacebookPost } from '../publish.js'

const buildOptions = (systemUserAccessToken = ''): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true },
    copyOverrides: {},
    platforms: { facebook: { apiVersion: 'v25.0', enabled: true, systemUserAccessToken } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const payload = {} as Payload
const adapter = createFacebookAdapter(options)

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

describe('facebook adapter — validate', () => {
  it('requires a pageId', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { format: 'LINK', pageId: '' },
      options,
    })
    expect(result.issues.some((i) => i.field === 'pageId')).toBe(true)
  })

  it('passes a LINK post with a link', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { format: 'LINK', link: 'https://x', pageId: 'p1' },
      options,
    })
    expect(result.ok).toBe(true)
  })

  it('requires imageUrl for PHOTO and a video for VIDEO', async () => {
    const photo = await adapter.validate({
      ctx: ctx(),
      input: { format: 'PHOTO', pageId: 'p1' },
      options,
    })
    expect(photo.issues.some((i) => i.field === 'imageUrl')).toBe(true)
    const video = await adapter.validate({
      ctx: ctx(),
      input: { format: 'VIDEO', pageId: 'p1' },
      options,
    })
    expect(video.issues.some((i) => i.field === 'videoUrl')).toBe(true)
  })

  it('enforces the 2 to 10 range for PHOTO_MULTI', async () => {
    const result = await adapter.validate({
      ctx: ctx(),
      input: { format: 'PHOTO_MULTI', imageUrls: ['only-one'], pageId: 'p1' },
      options,
    })
    expect(result.issues.some((i) => i.field === 'imageUrls')).toBe(true)
  })
})

describe('facebook adapter — isConnected', () => {
  it('is connected with a system-user token', async () => {
    const state = await adapter.isConnected({ options: buildOptions('sys'), payload })
    expect(state.connected).toBe(true)
    expect(getCredentials).not.toHaveBeenCalled()
  })

  it('is disconnected without a token', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    expect((await adapter.isConnected({ options, payload })).connected).toBe(false)
  })
})

describe('facebook adapter — publish + delete', () => {
  it('publishes a valid input', async () => {
    vi.mocked(publishFacebookPost).mockResolvedValue({
      alreadyExisted: false,
      postId: 'r',
      publishedRef: { externalId: 'p1_1', platform: 'facebook' },
    })
    const ref = await adapter.publish({
      ctx: ctx(),
      input: { format: 'LINK', link: 'https://x', pageId: 'p1' },
      options,
      payload,
      postId: '',
    })
    expect(ref.externalId).toBe('p1_1')
  })

  it('throws on invalid input', async () => {
    await expect(
      adapter.publish({ ctx: ctx(), input: { pageId: '' }, options, payload, postId: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(publishFacebookPost).not.toHaveBeenCalled()
  })

  it('records a connection error on upstream failure', async () => {
    vi.mocked(publishFacebookPost).mockRejectedValue(new Error('boom'))
    await expect(
      adapter.publish({
        ctx: ctx(),
        input: { format: 'LINK', link: 'https://x', pageId: 'p1' },
        options,
        payload,
        postId: '',
      }),
    ).rejects.toThrow('boom')
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'facebook', expect.any(Error))
  })

  it('delegates delete', async () => {
    const ref: PublishedRef = { externalId: 'p1_1', platform: 'facebook' }
    await adapter.delete?.({ options, payload, publishedRef: ref })
    expect(deleteFacebookPost).toHaveBeenCalledWith({ options, payload, publishedRef: ref })
  })

  it('delegates insights with the published ref', async () => {
    const ref: PublishedRef = { externalId: 'p1_1', platform: 'facebook' }
    vi.mocked(getFacebookInsightsForRef).mockResolvedValue({ metrics: { post_clicks: 2 } } as never)
    await expect(
      adapter.getInsights?.({ options, payload, publishedRef: ref, range: { end: '', start: '' } }),
    ).resolves.toEqual({ metrics: { post_clicks: 2 } })
    expect(getFacebookInsightsForRef).toHaveBeenCalledWith({
      options,
      payload,
      publishedRef: ref,
    })
  })
})
