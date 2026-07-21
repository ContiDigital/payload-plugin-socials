import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PayloadPluginSocialsConfig, SocialSourceContext } from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'
import { createResolvedTemplatesEndpoint } from '../createTemplateEndpoints.js'

const authorize = vi.fn().mockResolvedValue(true)
const context: SocialSourceContext = {
  baseDescription: 'Polished bronze sculpture',
  baseTitle: 'Heron',
  images: [],
  link: 'https://example.test/heron',
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

beforeEach(() => {
  vi.clearAllMocks()
  authorize.mockResolvedValue(true)
})

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

  it('exposes sourceKind and isDefault per template and filters the find by kind', async () => {
    const find = vi.fn().mockResolvedValue({
      docs: [
        {
          id: 'tpl_1',
          name: 'Launch',
          appliesTo: ['instagram'],
          isDefault: true,
          sourceKind: 'product',
          templates: { instagramCaption: '{{title}}' },
        },
      ],
    })
    const req = {
      payload: { find },
      routeParams: { sourceId: '7', sourceKind: 'product' },
      user: { id: 1 },
    } as unknown as PayloadRequest

    const response = await run(createResolvedTemplatesEndpoint(options), req)
    const body = (await response.json()) as {
      templates: Array<{ isDefault?: boolean; sourceKind?: string }>
    }
    expect(body.templates[0]).toMatchObject({ isDefault: true, sourceKind: 'product' })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { and: [{ enabled: { equals: true } }, { sourceKind: { equals: 'product' } }] },
      }),
    )
  })

  it('defaults isDefault to false and backfills sourceKind for legacy rows', async () => {
    const find = vi.fn().mockResolvedValue({
      docs: [{ id: 'tpl_legacy', name: 'Legacy', templates: { instagramCaption: '{{title}}' } }],
    })
    const req = {
      payload: { find },
      routeParams: { sourceId: '7', sourceKind: 'product' },
      user: { id: 1 },
    } as unknown as PayloadRequest

    const response = await run(createResolvedTemplatesEndpoint(options), req)
    const body = (await response.json()) as {
      templates: Array<{ isDefault?: boolean; sourceKind?: string }>
    }
    expect(body.templates[0]).toMatchObject({ isDefault: false, sourceKind: 'product' })
  })
})
