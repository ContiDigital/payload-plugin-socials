import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PayloadPluginSocialsConfig, SocialSourceContext } from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'
import {
  createResolvedTemplatesEndpoint,
  createTemplatePreviewEndpoint,
} from '../createTemplateEndpoints.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const authorize = vi.fn().mockResolvedValue(true)

const context: SocialSourceContext = {
  baseDescription: 'Polished bronze sculpture',
  baseTitle: 'Heron',
  images: [],
  link: 'https://example.test/heron',
  metadata: { categoryLabel: 'Sculptures', googleColor: 'bronze', googleMaterial: 'bronze' },
  modelLabel: 'HRN-01',
  sourceId: '7',
  sourceKind: 'product',
}

const options = normalizePluginOptions({
  authorize,
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: { pinterest: { enabled: false } },
  sources: { product: () => Promise.resolve(context) },
} as PayloadPluginSocialsConfig)

const run = (endpoint: Endpoint, req: PayloadRequest) =>
  (endpoint.handler as (request: PayloadRequest) => Promise<Response>)(req)

const makePostReq = (
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): PayloadRequest =>
  ({
    data: body,
    payload: {},
    user: { id: 1 },
    ...overrides,
  }) as unknown as PayloadRequest

beforeEach(() => {
  vi.clearAllMocks()
  authorize.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------
// createResolvedTemplatesEndpoint (existing endpoint, sanity guard)
// ---------------------------------------------------------------------------

describe('createResolvedTemplatesEndpoint', () => {
  it('returns enabled templates rendered against the resolved source', async () => {
    const find = vi.fn().mockResolvedValue({
      docs: [
        {
          id: 'tpl_1',
          name: 'Launch',
          appliesTo: ['instagram'],
          templates: { instagramCaption: '{{title}} — {{description}}' },
        },
      ],
    })
    const req = {
      payload: { find },
      routeParams: { sourceId: '7', sourceKind: 'product' },
      user: { id: 1 },
    } as unknown as PayloadRequest

    const response = await run(createResolvedTemplatesEndpoint(options), req)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      templates: [
        {
          id: 'tpl_1',
          name: 'Launch',
          resolved: { instagramCaption: 'Heron — Polished bronze sculpture' },
        },
      ],
    })
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ overrideAccess: true }))
  })
})

// ---------------------------------------------------------------------------
// createTemplatePreviewEndpoint
// ---------------------------------------------------------------------------

describe('createTemplatePreviewEndpoint', () => {
  it('resolves a fake registered resolver and returns resolved copy and scopeKeys', async () => {
    const req = makePostReq({
      fields: {
        instagramCaption: '{{ title }} — {{ description }}',
        pinterestTitle: '{{ title | upper }}',
      },
      sourceId: '7',
      sourceKind: 'product',
    })

    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      resolved: Record<string, string>
      scopeKeys: string[]
    }

    // Resolved copy is correct
    expect(body.resolved.pinterestTitle).toBe('HERON')
    expect(body.resolved.instagramCaption).toBe('Heron — Polished bronze sculpture')

    // scopeKeys includes the universal source-context tokens
    expect(body.scopeKeys).toContain('title')
    expect(body.scopeKeys).toContain('description')
    expect(body.scopeKeys).toContain('link')

    // scopeKeys includes discovered metadata.* leaf keys
    expect(body.scopeKeys).toContain('metadata.categoryLabel')
    expect(body.scopeKeys).toContain('metadata.googleColor')
    expect(body.scopeKeys).toContain('metadata.googleMaterial')
  })

  it('returns an empty resolved map when no fields are supplied', async () => {
    const req = makePostReq({ fields: {}, sourceId: '7', sourceKind: 'product' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resolved: Record<string, string>; scopeKeys: string[] }
    expect(body.resolved).toEqual({})
    expect(body.scopeKeys.length).toBeGreaterThan(0)
  })

  it('returns scopeKeys even when fields are omitted from the body', async () => {
    const req = makePostReq({ sourceId: '7', sourceKind: 'product' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resolved: Record<string, string>; scopeKeys: string[] }
    expect(body.scopeKeys).toContain('title')
  })

  it('returns 401 when the request has no user', async () => {
    const req = makePostReq({ fields: {}, sourceId: '7', sourceKind: 'product' }, { user: null })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(401)
  })

  it('returns 403 when the host denies access', async () => {
    authorize.mockResolvedValue(false)
    const req = makePostReq({ fields: {}, sourceId: '7', sourceKind: 'product' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(403)
  })

  it('returns 404 for an unknown sourceKind', async () => {
    // 'unknown-kind' has no registered resolver -> resolveSourceContext throws NotFoundError (404)
    const req = makePostReq({ fields: {}, sourceId: '7', sourceKind: 'unknown-kind' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(404)
  })

  it('returns 400 when sourceKind is missing from the body', async () => {
    const req = makePostReq({ fields: {}, sourceId: '7' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when sourceId is missing from the body', async () => {
    const req = makePostReq({ fields: {}, sourceKind: 'product' })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(400)
  })

  it('handles metadata-scoped tokens in the template', async () => {
    const req = makePostReq({
      fields: { pinterestDescription: '{{ metadata.googleMaterial }} sculpture' },
      sourceId: '7',
      sourceKind: 'product',
    })
    const res = await run(createTemplatePreviewEndpoint(options), req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resolved: Record<string, string> }
    expect(body.resolved.pinterestDescription).toBe('bronze sculpture')
  })
})
