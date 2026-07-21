import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { sha256Hex } from '../hash.js'
import { buildPublicationIdentity } from '../publicationIdentity.js'

const ctx: SocialSourceContext = {
  baseDescription: 'Description',
  baseTitle: 'Title',
  images: [{ role: 'main', url: 'https://cdn.example/main.jpg' }],
  link: 'https://example.com',
  sourceId: 'product_1',
  sourceKind: 'product',
}

describe('buildPublicationIdentity', () => {
  it('uses Pinterest default source imagery when imageUrl is omitted', () => {
    const identity = buildPublicationIdentity({
      ctx,
      input: { boardId: 'board_1' },
      platform: 'pinterest',
      sourceId: ctx.sourceId,
      sourceKind: ctx.sourceKind,
    })
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/main.jpg')
    expect(identity.idempotencyKey).toBe(
      sha256Hex('manual:product:product_1:board_1:https://cdn.example/main.jpg'),
    )
  })

  it('uses an explicit publication key as a stable cross-edit identity', () => {
    const first = buildPublicationIdentity({
      ctx,
      input: {
        boardId: 'board_1',
        imageUrl: 'https://cdn.example/first.jpg',
        publicationKey: 'launch',
      },
      platform: 'pinterest',
      sourceId: ctx.sourceId,
      sourceKind: ctx.sourceKind,
    })
    const second = buildPublicationIdentity({
      ctx,
      input: {
        boardId: 'board_2',
        imageUrl: 'https://cdn.example/second.jpg',
        publicationKey: 'launch',
      },
      platform: 'pinterest',
      sourceId: ctx.sourceId,
      sourceKind: ctx.sourceKind,
    })

    expect(first.idempotencyKey).toBe(sha256Hex('pinterest:publication:launch'))
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
  })

  it('accepts an exact legacy hash override and rejects malformed overrides', () => {
    const legacy = sha256Hex('legacy-key')
    const identity = buildPublicationIdentity({
      ctx,
      input: { boardId: 'board_1', idempotencyKeyOverride: legacy },
      platform: 'pinterest',
      sourceId: ctx.sourceId,
      sourceKind: ctx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(legacy)

    expect(() =>
      buildPublicationIdentity({
        ctx,
        input: { boardId: 'board_1', idempotencyKeyOverride: 'not-a-hash' },
        platform: 'pinterest',
        sourceId: ctx.sourceId,
        sourceKind: ctx.sourceKind,
      }),
    ).toThrow(/64-character SHA-256/)
  })

  it('includes GBP media in the default publication identity', () => {
    const base = {
      ctx,
      platform: 'gbp' as const,
      sourceId: ctx.sourceId,
      sourceKind: ctx.sourceKind,
    }
    const first = buildPublicationIdentity({
      ...base,
      input: {
        imageUrl: 'https://cdn.example/first.jpg',
        locationResourceName: 'accounts/1/locations/2',
      },
    })
    const second = buildPublicationIdentity({
      ...base,
      input: {
        imageUrl: 'https://cdn.example/second.jpg',
        locationResourceName: 'accounts/1/locations/2',
      },
    })
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
  })
})
