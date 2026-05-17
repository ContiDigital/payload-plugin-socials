import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { buildSocialDraft } from '../socialDraft.js'

describe('buildSocialDraft', () => {
  it('normalizes source copy and ordered image/video assets without editor-specific data', () => {
    const ctx: SocialSourceContext = {
      baseDescription: 'Body',
      baseTitle: 'Title',
      images: [
        { alt: 'Front', height: 1200, role: 'main', url: 'https://cdn.test/a.jpg', width: 800 },
      ],
      link: 'https://example.test/item',
      sourceId: '42',
      sourceKind: 'product',
      videos: [
        {
          coverImageUrl: 'https://cdn.test/cover.jpg',
          durationSeconds: 12,
          url: 'https://cdn.test/a.mp4',
        },
      ],
    }

    expect(buildSocialDraft(ctx)).toEqual({
      content: { body: 'Body', link: 'https://example.test/item', title: 'Title' },
      media: [
        {
          type: 'image',
          altText: 'Front',
          height: 1200,
          role: 'main',
          url: 'https://cdn.test/a.jpg',
          width: 800,
        },
        {
          type: 'video',
          coverImageUrl: 'https://cdn.test/cover.jpg',
          durationSeconds: 12,
          height: undefined,
          url: 'https://cdn.test/a.mp4',
          width: undefined,
        },
      ],
      source: { id: '42', kind: 'product' },
      version: 1,
    })
  })
})
