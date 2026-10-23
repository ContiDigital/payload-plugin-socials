import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'

vi.mock('../../compose/composePublish.js', () => ({
  composeAndPublish: vi.fn(),
  validateComposeTargets: vi.fn(),
}))

import { composeAndPublish, validateComposeTargets } from '../../compose/composePublish.js'
import {
  createComposeEndpoint,
  createComposeEndpoints,
  createComposeValidateEndpoint,
} from '../createComposeEndpoints.js'

const mockedCompose = vi.mocked(composeAndPublish)

const authorize = vi.fn()

const options = normalizePluginOptions({
  authorize,
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: {
    pinterest: { clientId: 'c', clientSecret: 's', enabled: true, redirectUri: 'https://x/cb' },
  },
  sources: { product: () => Promise.reject(new Error('stub')) },
} as PayloadPluginSocialsConfig)

const makeReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, user: { id: 1 }, ...over }) as unknown as PayloadRequest

const run = (endpoint: Endpoint, req: PayloadRequest) =>
  (endpoint.handler as (r: PayloadRequest) => Promise<Response>)(req)

beforeEach(() => {
  vi.clearAllMocks()
  authorize.mockResolvedValue(true)
  mockedCompose.mockResolvedValue({
    anyPublished: true,
    results: [
      {
        ok: true,
        platform: 'pinterest',
        publishedRef: { externalId: 'p1', platform: 'pinterest' },
      },
    ],
  })
})

describe('createComposeEndpoint', () => {
  it('composes a standalone context and publishes to the targets', async () => {
    const res = await run(
      createComposeEndpoint(options),
      makeReq({
        data: {
          content: { body: 'Body', imageUrl: 'https://cdn/x.jpg', title: 'Spring Sale' },
          targets: [{ input: { boardId: 'b1' }, platform: 'pinterest' }],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.anyPublished).toBe(true)
    expect(body.source.kind).toBe('standalone')

    const call = mockedCompose.mock.calls[0][0]
    expect(call.ctx.baseTitle).toBe('Spring Sale')
    expect(call.ctx.sourceKind).toBe('standalone')
    expect(call.ctx.images).toEqual([{ role: 'main', url: 'https://cdn/x.jpg' }])
    expect(call.targets).toEqual([{ input: { boardId: 'b1' }, platform: 'pinterest' }])
  })

  it('returns 502 when every channel failed', async () => {
    mockedCompose.mockResolvedValue({
      anyPublished: false,
      results: [{ error: 'nope', ok: false, platform: 'pinterest' }],
    })
    const res = await run(
      createComposeEndpoint(options),
      makeReq({ data: { content: { title: 'T' }, targets: [{ platform: 'pinterest' }] } }),
    )
    expect(res.status).toBe(502)
  })

  it('returns 401 without a user', async () => {
    const res = await run(
      createComposeEndpoint(options),
      makeReq({
        data: { content: { title: 'T' }, targets: [{ platform: 'pinterest' }] },
        user: null,
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 when the host denies access', async () => {
    authorize.mockResolvedValue(false)
    const res = await run(
      createComposeEndpoint(options),
      makeReq({ data: { content: { title: 'T' }, targets: [{ platform: 'pinterest' }] } }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when the title is missing', async () => {
    const res = await run(
      createComposeEndpoint(options),
      makeReq({ data: { content: {}, targets: [{ platform: 'pinterest' }] } }),
    )
    expect(res.status).toBe(400)
    expect(mockedCompose).not.toHaveBeenCalled()
  })

  it('returns 400 when targets is empty', async () => {
    const res = await run(
      createComposeEndpoint(options),
      makeReq({ data: { content: { title: 'T' }, targets: [] } }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unknown target platform', async () => {
    const res = await run(
      createComposeEndpoint(options),
      makeReq({ data: { content: { title: 'T' }, targets: [{ platform: 'twitter' }] } }),
    )
    expect(res.status).toBe(400)
  })
})

describe('createComposeValidateEndpoint', () => {
  const body = {
    content: { body: 'Body', imageUrl: 'https://cdn/x.jpg', title: 'Spring Sale' },
    targets: [{ input: { boardId: 'b1' }, platform: 'pinterest' }],
  }

  it('is mounted beside compose/publish', () => {
    expect(createComposeEndpoints(options).map((e) => `${e.method} ${e.path}`)).toEqual([
      'post /socials/compose/publish',
      'post /socials/compose/validate',
    ])
  })

  it('validates the same standalone context the publish route would build, without publishing', async () => {
    vi.mocked(validateComposeTargets).mockResolvedValue({
      ok: false,
      results: [
        {
          platform: 'pinterest',
          validation: { issues: [{ message: 'Title too long', severity: 'error' }], ok: false },
        },
      ],
    })
    const res = await run(createComposeValidateEndpoint(options), makeReq({ data: body }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.results[0].validation.issues[0].message).toBe('Title too long')
    expect(json.source.kind).toBe('standalone')
    expect(mockedCompose).not.toHaveBeenCalled()
    const call = vi.mocked(validateComposeTargets).mock.calls[0]?.[0]
    expect(call?.ctx.baseTitle).toBe('Spring Sale')
    expect(call?.targets).toEqual([{ input: { boardId: 'b1' }, platform: 'pinterest' }])
  })

  it('gives the same source identity as the publish route for the same content', async () => {
    vi.mocked(validateComposeTargets).mockResolvedValue({ ok: true, results: [] })
    const validated = await (
      await run(createComposeValidateEndpoint(options), makeReq({ data: body }))
    ).json()
    const published = await (
      await run(createComposeEndpoint(options), makeReq({ data: body }))
    ).json()
    expect(validated.source).toEqual(published.source)
  })

  it('400s a body without targets and 403s a denied caller', async () => {
    const bad = await run(
      createComposeValidateEndpoint(options),
      makeReq({ data: { content: { title: 'T' }, targets: [] } }),
    )
    expect(bad.status).toBe(400)
    authorize.mockResolvedValueOnce(false)
    const denied = await run(createComposeValidateEndpoint(options), makeReq({ data: body }))
    expect(denied.status).toBe(403)
    expect(validateComposeTargets).not.toHaveBeenCalled()
  })
})
