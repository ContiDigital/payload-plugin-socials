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
      sha256Hex('pinterest:product:product_1:board_1:https://cdn.example/main.jpg'),
    )
  })
})
