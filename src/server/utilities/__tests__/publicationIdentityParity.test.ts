import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { deriveFacebookIdentity } from '../../platforms/facebook/publish.js'
import { deriveGbpIdentity } from '../../platforms/gbp/publish.js'
import { deriveInstagramIdentity } from '../../platforms/instagram/publish.js'
import { derivePinterestIdentity } from '../../platforms/pinterest/publish.js'
import { buildPublicationIdentity } from '../publicationIdentity.js'

/**
 * Parity tests: assert that `buildPublicationIdentity` (endpoint-side
 * idempotency key derivation) produces byte-for-byte identical keys to
 * each adapter's own derivation for every supported platform × media-type
 * combination.
 *
 * A mismatch means reservation rows orphan in `status='publishing'` and
 * duplicate audit rows are created.
 */

const baseCtx: SocialSourceContext = {
  baseDescription: 'A test product',
  baseTitle: 'Test Product',
  images: [
    { role: 'main', url: 'https://cdn.example/main.jpg' },
    { role: 'detail', url: 'https://cdn.example/detail.jpg' },
  ],
  link: 'https://example.com/product/1',
  sourceId: 'product_42',
  sourceKind: 'product',
  videos: [
    {
      coverImageUrl: 'https://cdn.example/cover.jpg',
      url: 'https://cdn.example/video.mp4',
    },
  ],
}

describe('publicationIdentity parity — Pinterest', () => {
  it('IMAGE with explicit imageUrl', () => {
    const input = { boardId: 'board_1', imageUrl: 'https://cdn.example/custom.jpg' }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe(adapter.primaryAssetUrl)
  })

  it('IMAGE falls back to ctx default image', () => {
    const input = { boardId: 'board_1' }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/main.jpg')
  })

  it('IMAGE trims whitespace-padded imageUrl', () => {
    const input = { boardId: 'board_1', imageUrl: '  https://cdn.example/padded.jpg  ' }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/padded.jpg')
  })

  it('VIDEO with explicit videoUrl', () => {
    const input = {
      boardId: 'board_1',
      mediaType: 'VIDEO' as const,
      videoUrl: 'https://cdn.example/explicit.mp4',
    }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/explicit.mp4')
  })

  it('VIDEO falls back to ctx.videos[0].url', () => {
    const input = { boardId: 'board_1', mediaType: 'VIDEO' as const }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/video.mp4')
  })

  it('VIDEO with mediaId only (no videoUrl, no ctx.videos)', () => {
    const ctxNoVideos: SocialSourceContext = { ...baseCtx, videos: [] }
    const input = {
      boardId: 'board_1',
      mediaId: 'media_abc123',
      mediaType: 'VIDEO' as const,
    }
    const adapter = derivePinterestIdentity(ctxNoVideos, input)
    const identity = buildPublicationIdentity({
      ctx: ctxNoVideos,
      input,
      platform: 'pinterest',
      sourceId: ctxNoVideos.sourceId,
      sourceKind: ctxNoVideos.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('media_abc123')
  })

  it('VIDEO trims whitespace-padded videoUrl', () => {
    const input = {
      boardId: 'board_1',
      mediaType: 'VIDEO' as const,
      videoUrl: '  https://cdn.example/padded.mp4  ',
    }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/padded.mp4')
  })

  it('VIDEO with empty-string videoUrl falls through to ctx.videos', () => {
    const input = { boardId: 'board_1', mediaType: 'VIDEO' as const, videoUrl: '' }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/video.mp4')
  })

  it('VIDEO with whitespace-only videoUrl falls through to ctx.videos', () => {
    const input = { boardId: 'board_1', mediaType: 'VIDEO' as const, videoUrl: '   ' }
    const adapter = derivePinterestIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'pinterest',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/video.mp4')
  })
})

describe('publicationIdentity parity — Facebook', () => {
  it('LINK format', () => {
    const input = { format: 'LINK' as const, link: 'https://example.com', pageId: 'page_1' }
    const adapter = deriveFacebookIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'facebook',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe(adapter.primaryAssetUrl)
  })

  it('PHOTO format', () => {
    const input = {
      format: 'PHOTO' as const,
      imageUrl: 'https://cdn.example/fb.jpg',
      pageId: 'page_1',
    }
    const adapter = deriveFacebookIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'facebook',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/fb.jpg')
  })

  it('PHOTO_MULTI format', () => {
    const input = {
      format: 'PHOTO_MULTI' as const,
      imageUrls: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
      pageId: 'page_1',
    }
    const adapter = deriveFacebookIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'facebook',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/1.jpg')
  })

  it('VIDEO format', () => {
    const input = {
      format: 'VIDEO' as const,
      pageId: 'page_1',
      videoUrl: 'https://cdn.example/fb.mp4',
    }
    const adapter = deriveFacebookIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'facebook',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/fb.mp4')
  })
})

describe('publicationIdentity parity — Instagram', () => {
  it('IMAGE media type', () => {
    const input = {
      igUserId: 'ig_1',
      imageUrl: 'https://cdn.example/ig.jpg',
      mediaType: 'IMAGE' as const,
    }
    const adapter = deriveInstagramIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'instagram',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe(adapter.primaryAssetUrl)
  })

  it('REELS media type', () => {
    const input = {
      igUserId: 'ig_1',
      mediaType: 'REELS' as const,
      videoUrl: 'https://cdn.example/reel.mp4',
    }
    const adapter = deriveInstagramIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'instagram',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/reel.mp4')
  })

  it('STORIES media type', () => {
    const input = {
      igUserId: 'ig_1',
      imageUrl: 'https://cdn.example/story.jpg',
      mediaType: 'STORIES' as const,
    }
    const adapter = deriveInstagramIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'instagram',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/story.jpg')
  })

  it('CAROUSEL media type', () => {
    const input = {
      carouselChildren: [
        { imageUrl: 'https://cdn.example/c1.jpg' },
        { videoUrl: 'https://cdn.example/c2.mp4' },
      ],
      igUserId: 'ig_1',
      mediaType: 'CAROUSEL' as const,
    }
    const adapter = deriveInstagramIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'instagram',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
    expect(identity.primaryAssetUrl).toBe('https://cdn.example/c1.jpg')
  })
})

describe('publicationIdentity parity — GBP', () => {
  it('STANDARD topic type', () => {
    const input = {
      locationResourceName: 'accounts/acc1/locations/loc1',
      topicType: 'STANDARD' as const,
    }
    const adapter = deriveGbpIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'gbp',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
  })

  it('EVENT topic type', () => {
    const input = {
      event: {
        schedule: {
          endDate: { day: 15, month: 6, year: 2025 },
          startDate: { day: 10, month: 6, year: 2025 },
        },
        title: 'Sale',
      },
      locationResourceName: 'accounts/acc1/locations/loc1',
      topicType: 'EVENT' as const,
    }
    const adapter = deriveGbpIdentity(baseCtx, input)
    const identity = buildPublicationIdentity({
      ctx: baseCtx,
      input,
      platform: 'gbp',
      sourceId: baseCtx.sourceId,
      sourceKind: baseCtx.sourceKind,
    })
    expect(identity.idempotencyKey).toBe(adapter.idempotencyKey)
  })
})
