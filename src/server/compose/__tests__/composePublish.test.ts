import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PlatformAdapter,
  SocialSourceContext,
} from '../../../types/index.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))

import { getPlatformAdapter } from '../../platforms/registry.js'
import { NotFoundError } from '../../utilities/errors.js'
import { composeAndPublish, validateComposeTargets } from '../composePublish.js'

const mockedGetAdapter = vi.mocked(getPlatformAdapter)

const options = {} as NormalizedPluginOptions
let nextPostId = 0
const createPost = vi.fn().mockImplementation(() => Promise.resolve({ id: `post_${++nextPostId}` }))
const findPosts = vi.fn().mockResolvedValue({ docs: [], totalDocs: 0 })
const updatePost = vi.fn().mockResolvedValue({ id: 'post_1' })
const payload = {
  create: createPost,
  find: findPosts,
  update: updatePost,
} as unknown as Payload

const ctx: SocialSourceContext = {
  baseDescription: 'body',
  baseTitle: 'title',
  images: [],
  link: 'https://example.com',
  sourceId: 'sid',
  sourceKind: 'standalone',
}

const fakeAdapter = (over: Partial<PlatformAdapter> = {}): PlatformAdapter =>
  ({
    publish: vi.fn().mockResolvedValue({ externalId: 'ext_1', platform: 'pinterest' }),
    validate: vi.fn().mockResolvedValue({ issues: [], ok: true }),
    ...over,
  }) as unknown as PlatformAdapter

beforeEach(() => {
  vi.clearAllMocks()
  nextPostId = 0
  findPosts.mockResolvedValue({ docs: [], totalDocs: 0 })
  createPost.mockImplementation(() => Promise.resolve({ id: `post_${++nextPostId}` }) as never)
  updatePost.mockResolvedValue({ id: 'post_1' })
})

describe('composeAndPublish', () => {
  it('publishes every target and reports anyPublished', async () => {
    mockedGetAdapter.mockReturnValue(fakeAdapter())
    const result = await composeAndPublish({
      ctx,
      options,
      payload,
      targets: [
        { input: { boardId: 'b1' }, platform: 'pinterest' },
        { input: { igUserId: 'ig1' }, platform: 'instagram' },
      ],
    })
    expect(result.anyPublished).toBe(true)
    expect(result.results.every((r) => r.ok)).toBe(true)
    expect(result.results.map((r) => r.platform)).toEqual(['pinterest', 'instagram'])
  })

  it('isolates a validation failure to its own channel', async () => {
    mockedGetAdapter.mockImplementation((platform) =>
      platform === 'instagram'
        ? fakeAdapter({
            validate: vi.fn().mockResolvedValue({
              issues: [{ message: 'igUserId required', severity: 'error' }],
              ok: false,
            }),
          })
        : fakeAdapter(),
    )
    const result = await composeAndPublish({
      ctx,
      options,
      payload,
      targets: [
        { input: {}, platform: 'pinterest' },
        { input: {}, platform: 'instagram' },
      ],
    })
    expect(result.anyPublished).toBe(true)
    const ig = result.results.find((r) => r.platform === 'instagram')
    expect(ig?.ok).toBe(false)
    expect(ig?.error).toContain('igUserId required')
    expect(result.results.find((r) => r.platform === 'pinterest')?.ok).toBe(true)
  })

  it('isolates a publish error to its own channel', async () => {
    mockedGetAdapter.mockImplementation((platform) =>
      platform === 'facebook'
        ? fakeAdapter({ publish: vi.fn().mockRejectedValue(new Error('upstream 500')) })
        : fakeAdapter(),
    )
    const result = await composeAndPublish({
      ctx,
      options,
      payload,
      targets: [
        { input: {}, platform: 'pinterest' },
        { input: {}, platform: 'facebook' },
      ],
    })
    expect(result.results.find((r) => r.platform === 'facebook')?.error).toBe(
      'Internal server error',
    )
    expect(result.results.find((r) => r.platform === 'pinterest')?.ok).toBe(true)
  })

  it('reports a disabled platform as a failed channel', async () => {
    mockedGetAdapter.mockImplementation((platform) => {
      if (platform === 'gbp') {
        throw new NotFoundError('platform "gbp" is not enabled')
      }
      return fakeAdapter()
    })
    const result = await composeAndPublish({
      ctx,
      options,
      payload,
      targets: [
        { input: {}, platform: 'pinterest' },
        { input: {}, platform: 'gbp' },
      ],
    })
    expect(result.results.find((r) => r.platform === 'gbp')?.ok).toBe(false)
    expect(result.anyPublished).toBe(true)
  })

  it('returns anyPublished=false when every channel fails', async () => {
    mockedGetAdapter.mockImplementation(() => {
      throw new NotFoundError('not enabled')
    })
    const result = await composeAndPublish({
      ctx,
      options,
      payload,
      targets: [{ input: {}, platform: 'pinterest' }],
    })
    expect(result.anyPublished).toBe(false)
    expect(result.results[0].ok).toBe(false)
  })

  it('returns an empty result set for no targets', async () => {
    const result = await composeAndPublish({ ctx, options, payload, targets: [] })
    expect(result).toEqual({ anyPublished: false, results: [] })
  })
})

describe('validateComposeTargets', () => {
  it('validates every target without reserving or publishing', async () => {
    const validateOk = vi.fn().mockResolvedValue({ issues: [], ok: true })
    const publishOk = vi.fn()
    const ok = fakeAdapter({ publish: publishOk, validate: validateOk })
    const bad = fakeAdapter({
      validate: vi.fn().mockResolvedValue({
        issues: [{ field: 'summary', message: 'Summary too long', severity: 'error' }],
        ok: false,
      }),
    })
    mockedGetAdapter.mockImplementation((platform) => (platform === 'gbp' ? bad : ok))
    const result = await validateComposeTargets({
      ctx,
      options,
      targets: [
        { input: { boardId: 'b' }, platform: 'pinterest' },
        { input: { summary: 'x' }, platform: 'gbp' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.results.map((item) => [item.platform, item.validation.ok])).toEqual([
      ['pinterest', true],
      ['gbp', false],
    ])
    expect(validateOk).toHaveBeenCalledWith({ ctx, input: { boardId: 'b' }, options })
    expect(publishOk).not.toHaveBeenCalled()
    expect(createPost).not.toHaveBeenCalled()
    expect(updatePost).not.toHaveBeenCalled()
  })

  it('reports a disabled platform as an error issue for that target', async () => {
    mockedGetAdapter.mockImplementation(() => {
      throw new NotFoundError('platform "facebook" is not enabled in plugin options')
    })
    const result = await validateComposeTargets({
      ctx,
      options,
      targets: [{ input: {}, platform: 'facebook' }],
    })
    expect(result).toEqual({
      ok: false,
      results: [
        {
          platform: 'facebook',
          validation: {
            issues: [
              {
                message:
                  'payload-plugin-socials: platform "facebook" is not enabled in plugin options',
                severity: 'error',
              },
            ],
            ok: false,
          },
        },
      ],
    })
  })
})
