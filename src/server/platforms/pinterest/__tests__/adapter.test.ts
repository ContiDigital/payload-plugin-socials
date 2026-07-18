import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import { ValidationError } from '../../../utilities/errors.js'

vi.mock('../../../services/connectionService.js', () => ({
  getCredentials: vi.fn(),
  recordConnectionError: vi.fn(),
}))
vi.mock('../oauth.js', () => ({
  buildAuthorizeUrl: vi.fn(() => 'https://www.pinterest.com/oauth/?x=1'),
  exchangeCodeForTokens: vi.fn(),
}))
vi.mock('../publish.js', () => ({
  buildPinterestPreview: vi.fn(),
  deletePinterestPin: vi.fn(),
  publishPinterestPin: vi.fn(),
}))
vi.mock('../insights.js', () => ({
  getPinterestInsightsForRef: vi.fn(),
}))

import { getCredentials, recordConnectionError } from '../../../services/connectionService.js'
import { createPinterestAdapter } from '../adapter.js'
import { getPinterestInsightsForRef } from '../insights.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../oauth.js'
import { deletePinterestPin, publishPinterestPin } from '../publish.js'

const options = {
  assets: { autoConvert: false, jpegQuality: 82, preflight: true },
  copyOverrides: {},
  platforms: { pinterest: { environment: 'production' } },
} as unknown as NormalizedPluginOptions

const payload = {} as Payload
const adapter = createPinterestAdapter(options)

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

describe('pinterest adapter — static surface', () => {
  it('exposes id, label, and capabilities', () => {
    expect(adapter.id).toBe('pinterest')
    expect(adapter.label).toBe('Pinterest')
    expect(adapter.capabilities).toMatchObject({
      carousel: false,
      image: true,
      oauth: true,
      scheduling: false,
      video: true,
    })
  })

  it('delegates buildAuthorizeUrl to the oauth module', () => {
    expect(adapter.buildAuthorizeUrl?.({ options, payload, state: 's' })).toBe(
      'https://www.pinterest.com/oauth/?x=1',
    )
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(options, { state: 's' })
  })
})

describe('pinterest adapter — validate', () => {
  it('passes a complete input', async () => {
    const result = await adapter.validate({ ctx: ctx(), input: { boardId: 'b1' }, options })
    expect(result.ok).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('errors without an image or a boardId', async () => {
    const result = await adapter.validate({
      ctx: ctx({ images: [] }),
      input: { boardId: '' },
      options,
    })
    expect(result.ok).toBe(false)
    const messages = result.issues.map((i) => i.message).join(' ')
    expect(messages).toMatch(/at least one image/)
    expect(messages).toMatch(/boardId is required/)
  })

  it('errors when the chosen image is below the minimum width', async () => {
    const result = await adapter.validate({
      ctx: ctx({ images: [{ belowMinWidth: true, role: 'main', url: 'https://cdn/small.jpg' }] }),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.field === 'image')).toBe(true)
  })

  it('warns (without failing) when there is no outbound link', async () => {
    const result = await adapter.validate({
      ctx: ctx({ link: '' }),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true)
  })
})

describe('pinterest adapter — isConnected', () => {
  it('reports disconnected when no refresh token is stored', async () => {
    vi.mocked(getCredentials).mockResolvedValue(null)
    const state = await adapter.isConnected({ options, payload })
    expect(state.connected).toBe(false)
    expect(state.lastError).toMatch(/start OAuth/)
  })

  it('reports connected with account metadata when a token exists', async () => {
    vi.mocked(getCredentials).mockResolvedValue({
      accountLabel: 'Fine Gallery',
      refreshToken: 'pinr_x',
      scopes: ['pins:write'],
    } as never)
    const state = await adapter.isConnected({ options, payload })
    expect(state.connected).toBe(true)
    expect(state.accountLabel).toBe('Fine Gallery')
    expect(state.scopes).toEqual(['pins:write'])
  })
})

describe('pinterest adapter — publish', () => {
  it('publishes a valid input and returns the published ref', async () => {
    vi.mocked(publishPinterestPin).mockResolvedValue({
      alreadyExisted: false,
      postId: 'row_1',
      publishedRef: { externalId: 'pin_1', platform: 'pinterest' },
    })
    const ref = await adapter.publish({
      ctx: ctx(),
      input: { boardId: 'b1' },
      options,
      payload,
      postId: '',
    })
    expect(ref.externalId).toBe('pin_1')
  })

  it('throws a ValidationError and never calls the publish path on invalid input', async () => {
    await expect(
      adapter.publish({ ctx: ctx(), input: { boardId: '' }, options, payload, postId: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(publishPinterestPin).not.toHaveBeenCalled()
  })

  it('records a connection error and rethrows when the publish path fails', async () => {
    vi.mocked(publishPinterestPin).mockRejectedValue(new Error('upstream 500'))
    await expect(
      adapter.publish({ ctx: ctx(), input: { boardId: 'b1' }, options, payload, postId: '' }),
    ).rejects.toThrow('upstream 500')
    expect(recordConnectionError).toHaveBeenCalledWith(payload, 'pinterest', expect.any(Error))
  })
})

describe('pinterest adapter — delete + insights + exchange', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'pin_1',
    platform: 'pinterest',
    ...over,
  })

  it('delegates delete to the publish module', async () => {
    await adapter.delete?.({ options, payload, publishedRef: ref() })
    expect(deletePinterestPin).toHaveBeenCalledWith({ options, payload, publishedRef: ref() })
  })

  it('returns empty insights for a foreign or id-less ref', async () => {
    expect(
      await adapter.getInsights?.({
        options,
        payload,
        publishedRef: ref({ platform: 'facebook' }),
        range: { end: 'b', start: 'a' },
      }),
    ).toEqual({})
    expect(
      await adapter.getInsights?.({
        options,
        payload,
        publishedRef: ref({ externalId: '' }),
        range: { end: 'b', start: 'a' },
      }),
    ).toEqual({})
    expect(getPinterestInsightsForRef).not.toHaveBeenCalled()
  })

  it('fetches insights for a valid pinterest ref', async () => {
    vi.mocked(getPinterestInsightsForRef).mockResolvedValue({ impressions: 10 })
    const result = await adapter.getInsights?.({
      options,
      payload,
      publishedRef: ref(),
      range: { end: 'b', start: 'a' },
    })
    expect(result).toEqual({ impressions: 10 })
  })

  it('assembles exchangeCallback from the token exchange + stored credentials', async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({
      accountId: 'acc1',
      accountLabel: 'Fine',
      scopes: ['pins:write'],
    } as never)
    vi.mocked(getCredentials).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' } as never)
    const result = await adapter.exchangeCallback?.({
      code: 'c',
      options,
      payload,
      req: {} as never,
    })
    expect(result).toMatchObject({
      accessToken: 'AT',
      accountId: 'acc1',
      accountLabel: 'Fine',
      refreshToken: 'RT',
      scopes: ['pins:write'],
    })
  })
})
