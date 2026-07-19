import { describe, expect, it } from 'vitest'

import type { SocialDraft, SocialDraftMedia } from '../../types/index.js'
import type { ComposerState, StandaloneComposerState } from '../socialComposerModel.js'

import {
  acceptedMediaTypes,
  buildInitialComposerState,
  buildStandaloneInitialState,
  compileComposerInput,
  compileStandalonePublishBody,
  formatLocalDateTimeMin,
  getSelectedAssets,
  parseComposeResponse,
  pruneSelectedMedia,
  shouldFetchEnvelope,
  supportsMultipleMedia,
} from '../socialComposerModel.js'

const draft: SocialDraft = {
  content: { body: 'Body', link: 'https://example.test/item', title: 'Title' },
  media: [
    { type: 'image', altText: 'Front', url: 'https://cdn.test/front.jpg' },
    {
      type: 'video',
      coverImageUrl: 'https://cdn.test/cover.jpg',
      url: 'https://cdn.test/video.mp4',
    },
    { type: 'image', altText: 'Detail', url: 'https://cdn.test/detail.jpg' },
  ],
  source: { id: '1', kind: 'product' },
  version: 1,
}

const state = (over: Partial<ComposerState> = {}): ComposerState => ({
  alertType: '',
  altText: 'Accessible',
  callToAction: '',
  callToActionUrl: 'https://example.test/cta',
  copy: 'Composed copy',
  destinationId: 'destination',
  eventEnd: '',
  eventStart: '',
  eventTitle: 'Event',
  format: 'IMAGE',
  languageCode: '',
  link: 'https://example.test/item',
  offerCode: '',
  offerTerms: '',
  selectedMedia: ['https://cdn.test/front.jpg'],
  shareToFeed: true,
  title: 'Pin title',
  videoTitle: 'Video title',
  ...over,
})

// ---------------------------------------------------------------------------
// Fix 1: formatLocalDateTimeMin — local-time picker boundary
// ---------------------------------------------------------------------------

describe('formatLocalDateTimeMin', () => {
  it('formats a fixed Date using local getters (not UTC)', () => {
    // Construct a date with known local components.
    // We use a Date constructed from local-time parts so the test is
    // timezone-independent: new Date(year, month-1, day, hours, minutes).
    const local = new Date(2025, 2, 15, 9, 5) // 2025-03-15 09:05 local
    expect(formatLocalDateTimeMin(local)).toBe('2025-03-15T09:05')
  })

  it('zero-pads month, day, hours, and minutes', () => {
    const local = new Date(2024, 0, 3, 8, 4) // 2024-01-03 08:04 local
    expect(formatLocalDateTimeMin(local)).toBe('2024-01-03T08:04')
  })

  it('handles December and double-digit components', () => {
    const local = new Date(2026, 11, 31, 23, 59) // 2026-12-31 23:59 local
    expect(formatLocalDateTimeMin(local)).toBe('2026-12-31T23:59')
  })

  it('produces YYYY-MM-DDTHH:MM format matching datetime-local expectations', () => {
    const local = new Date(2027, 5, 10, 14, 30) // 2027-06-10 14:30 local
    const result = formatLocalDateTimeMin(local)
    // Must match the exact pattern a datetime-local input expects for min.
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(result).toBe('2027-06-10T14:30')
  })
})

// ---------------------------------------------------------------------------
// acceptedMediaTypes
// ---------------------------------------------------------------------------

describe('acceptedMediaTypes', () => {
  it('pinterest IMAGE accepts only image', () => {
    expect(acceptedMediaTypes('pinterest', 'IMAGE')).toEqual(['image'])
  })

  it('pinterest VIDEO accepts only video', () => {
    expect(acceptedMediaTypes('pinterest', 'VIDEO')).toEqual(['video'])
  })

  it('instagram IMAGE accepts only image', () => {
    expect(acceptedMediaTypes('instagram', 'IMAGE')).toEqual(['image'])
  })

  it('instagram REELS accepts only video', () => {
    expect(acceptedMediaTypes('instagram', 'REELS')).toEqual(['video'])
  })

  it('instagram STORIES accepts image and video', () => {
    expect(acceptedMediaTypes('instagram', 'STORIES')).toEqual(['image', 'video'])
  })

  it('instagram CAROUSEL accepts image and video', () => {
    expect(acceptedMediaTypes('instagram', 'CAROUSEL')).toEqual(['image', 'video'])
  })

  it('facebook LINK accepts only image', () => {
    expect(acceptedMediaTypes('facebook', 'LINK')).toEqual(['image'])
  })

  it('facebook PHOTO accepts only image', () => {
    expect(acceptedMediaTypes('facebook', 'PHOTO')).toEqual(['image'])
  })

  it('facebook PHOTO_MULTI accepts only image', () => {
    expect(acceptedMediaTypes('facebook', 'PHOTO_MULTI')).toEqual(['image'])
  })

  it('facebook VIDEO accepts only video', () => {
    expect(acceptedMediaTypes('facebook', 'VIDEO')).toEqual(['video'])
  })

  it('gbp STANDARD accepts only image', () => {
    expect(acceptedMediaTypes('gbp', 'STANDARD')).toEqual(['image'])
  })

  it('gbp EVENT accepts only image', () => {
    expect(acceptedMediaTypes('gbp', 'EVENT')).toEqual(['image'])
  })

  it('gbp OFFER accepts only image', () => {
    expect(acceptedMediaTypes('gbp', 'OFFER')).toEqual(['image'])
  })

  it('gbp ALERT accepts only image', () => {
    expect(acceptedMediaTypes('gbp', 'ALERT')).toEqual(['image'])
  })
})

// ---------------------------------------------------------------------------
// pruneSelectedMedia
// ---------------------------------------------------------------------------

describe('pruneSelectedMedia', () => {
  it('keeps valid image selections when changing to IMAGE format', () => {
    const { pruned, removed } = pruneSelectedMedia(
      ['https://cdn.test/front.jpg', 'https://cdn.test/video.mp4'],
      draft.media,
      'pinterest',
      'IMAGE',
    )
    expect(pruned).toEqual(['https://cdn.test/front.jpg'])
    expect(removed).toEqual(['https://cdn.test/video.mp4'])
  })

  it('keeps valid video selections when changing to VIDEO format', () => {
    const { pruned, removed } = pruneSelectedMedia(
      ['https://cdn.test/front.jpg', 'https://cdn.test/video.mp4'],
      draft.media,
      'pinterest',
      'VIDEO',
    )
    expect(pruned).toEqual(['https://cdn.test/video.mp4'])
    expect(removed).toEqual(['https://cdn.test/front.jpg'])
  })

  it('keeps both image and video for CAROUSEL', () => {
    const { pruned, removed } = pruneSelectedMedia(
      ['https://cdn.test/front.jpg', 'https://cdn.test/video.mp4'],
      draft.media,
      'instagram',
      'CAROUSEL',
    )
    expect(pruned).toEqual(['https://cdn.test/front.jpg', 'https://cdn.test/video.mp4'])
    expect(removed).toEqual([])
  })

  it('removes all when switching to REELS and only images selected', () => {
    const { pruned, removed } = pruneSelectedMedia(
      ['https://cdn.test/front.jpg', 'https://cdn.test/detail.jpg'],
      draft.media,
      'instagram',
      'REELS',
    )
    expect(pruned).toEqual([])
    expect(removed).toEqual(['https://cdn.test/front.jpg', 'https://cdn.test/detail.jpg'])
  })
})

// ---------------------------------------------------------------------------
// compileComposerInput (updated behavior)
// ---------------------------------------------------------------------------

describe('compileComposerInput', () => {
  it('initializes copy and chooses video when Pinterest has no image', () => {
    const videoDraft: SocialDraft = { ...draft, media: [draft.media[1]] }
    expect(
      buildInitialComposerState('pinterest', {
        draft: videoDraft,
        preview: { body: 'Preview body', link: 'https://preview.test', title: 'Preview title' },
      }),
    ).toMatchObject({
      copy: 'Preview body',
      format: 'VIDEO',
      link: 'https://preview.test',
      selectedMedia: ['https://cdn.test/video.mp4'],
      title: 'Preview title',
    })
  })

  it('drops selected URLs that are no longer in the source draft', () => {
    expect(
      getSelectedAssets(state({ selectedMedia: ['missing', draft.media[0].url] }), draft),
    ).toEqual([draft.media[0]])
  })

  it('compiles a Pinterest video Pin from canonical media', () => {
    expect(
      compileComposerInput(
        'pinterest',
        state({
          format: 'VIDEO',
          selectedMedia: ['https://cdn.test/video.mp4'],
        }),
        draft,
      ),
    ).toMatchObject({
      boardId: 'destination',
      coverImageUrl: 'https://cdn.test/cover.jpg',
      mediaType: 'VIDEO',
      videoUrl: 'https://cdn.test/video.mp4',
    })
  })

  it('preserves ordered Instagram carousel children', () => {
    expect(
      compileComposerInput(
        'instagram',
        state({
          format: 'CAROUSEL',
          selectedMedia: ['https://cdn.test/detail.jpg', 'https://cdn.test/video.mp4'],
        }),
        draft,
      ),
    ).toMatchObject({
      carouselChildren: [
        { imageUrl: 'https://cdn.test/detail.jpg' },
        { videoUrl: 'https://cdn.test/video.mp4' },
      ],
      mediaType: 'CAROUSEL',
    })
  })

  it.each([
    ['IMAGE', { imageUrl: 'https://cdn.test/front.jpg' }],
    ['REELS', { coverUrl: 'https://cdn.test/cover.jpg', videoUrl: 'https://cdn.test/video.mp4' }],
    ['STORIES', { videoUrl: 'https://cdn.test/video.mp4' }],
  ])('compiles Instagram %s media', (format, expected) => {
    expect(
      compileComposerInput(
        'instagram',
        state({
          format,
          selectedMedia:
            format === 'IMAGE' ? ['https://cdn.test/front.jpg'] : ['https://cdn.test/video.mp4'],
        }),
        draft,
      ),
    ).toMatchObject(expected)
  })

  it('compiles an image Story when no video exists', () => {
    expect(
      compileComposerInput('instagram', state({ format: 'STORIES' }), {
        ...draft,
        media: [draft.media[0]],
      }),
    ).toMatchObject({ imageUrl: 'https://cdn.test/front.jpg' })
  })

  it('compiles Facebook multi-photo URLs without video assets', () => {
    expect(
      compileComposerInput(
        'facebook',
        state({
          format: 'PHOTO_MULTI',
          selectedMedia: [
            'https://cdn.test/front.jpg',
            'https://cdn.test/video.mp4',
            'https://cdn.test/detail.jpg',
          ],
        }),
        draft,
      ),
    ).toMatchObject({
      format: 'PHOTO_MULTI',
      imageUrls: ['https://cdn.test/front.jpg', 'https://cdn.test/detail.jpg'],
      pageId: 'destination',
    })
  })

  it.each([
    ['PHOTO', { imageUrl: 'https://cdn.test/front.jpg' }],
    ['VIDEO', { videoTitle: 'Video title', videoUrl: 'https://cdn.test/video.mp4' }],
  ])('compiles Facebook %s media', (format, expected) => {
    expect(
      compileComposerInput(
        'facebook',
        state({
          format,
          selectedMedia:
            format === 'VIDEO' ? ['https://cdn.test/video.mp4'] : ['https://cdn.test/front.jpg'],
        }),
        draft,
      ),
    ).toMatchObject(expected)
  })

  it('compiles GBP event dates and times into the LocalPosts shape', () => {
    expect(
      compileComposerInput(
        'gbp',
        state({
          eventEnd: '2027-06-02T17:30',
          eventStart: '2027-06-01T09:15',
          format: 'EVENT',
        }),
        draft,
      ),
    ).toMatchObject({
      event: {
        schedule: {
          endDate: { day: 2, month: 6, year: 2027 },
          endTime: { hours: 17, minutes: 30 },
          startDate: { day: 1, month: 6, year: 2027 },
          startTime: { hours: 9, minutes: 15 },
        },
        title: 'Event',
      },
      topicType: 'EVENT',
    })
  })

  it('compiles GBP offer, alert, and call CTA variants', () => {
    expect(
      compileComposerInput(
        'gbp',
        state({
          callToActionUrl: 'https://example.test/redeem',
          eventEnd: '2027-06-02T17:30',
          eventStart: '2027-06-01T09:15',
          format: 'OFFER',
          offerCode: 'SAVE20',
          offerTerms: 'Terms',
        }),
        draft,
      ),
    ).toMatchObject({
      offer: {
        couponCode: 'SAVE20',
        redeemOnlineUrl: 'https://example.test/redeem',
        termsConditions: 'Terms',
      },
    })
    expect(
      compileComposerInput('gbp', state({ alertType: 'COVID_19', format: 'ALERT' }), draft),
    ).toMatchObject({ alertType: 'COVID_19', imageUrl: undefined })
    expect(
      compileComposerInput('gbp', state({ callToAction: 'CALL', format: 'STANDARD' }), draft),
    ).toMatchObject({ callToAction: { actionType: 'CALL', url: undefined } })
  })

  it('identifies only the two multi-media formats', () => {
    expect(supportsMultipleMedia('instagram', 'CAROUSEL')).toBe(true)
    expect(supportsMultipleMedia('facebook', 'PHOTO_MULTI')).toBe(true)
    expect(supportsMultipleMedia('pinterest', 'IMAGE')).toBe(false)
  })

  // --- New tests: strict media selection ---

  it('does not fall back to draft media when no selected asset matches the format', () => {
    // Selecting only images, but format requires video
    const result = compileComposerInput(
      'pinterest',
      state({ format: 'VIDEO', selectedMedia: ['https://cdn.test/front.jpg'] }),
      draft,
    )
    // No video is selected and the draft has other video assets, but the model
    // should NOT silently fall back. Since 'front.jpg' is an image and format is
    // VIDEO, the selected asset is not accepted. It should auto-select only if
    // there is exactly one accepted asset in the draft.
    expect(result.videoUrl).toBe('https://cdn.test/video.mp4')
  })

  it('auto-selects the single accepted draft asset when nothing is selected', () => {
    const singleImageDraft: SocialDraft = {
      ...draft,
      media: [{ type: 'image', url: 'https://cdn.test/only.jpg' }],
    }
    const result = compileComposerInput(
      'pinterest',
      state({ format: 'IMAGE', selectedMedia: [] }),
      singleImageDraft,
    )
    expect(result.imageUrl).toBe('https://cdn.test/only.jpg')
  })

  it('does not auto-select when multiple accepted assets exist and nothing is selected', () => {
    // Two images available, nothing selected - should not auto-select
    const result = compileComposerInput(
      'pinterest',
      state({ format: 'IMAGE', selectedMedia: [] }),
      draft,
    )
    // Both 'front.jpg' and 'detail.jpg' are images, so auto-select does not kick in
    expect(result.imageUrl).toBeUndefined()
  })

  // --- New tests: title prepend ---

  it('prepends title to instagram caption when title is set', () => {
    const result = compileComposerInput(
      'instagram',
      state({ format: 'IMAGE', title: 'My Title' }),
      draft,
    )
    expect(result.caption).toBe('My Title\n\nComposed copy')
  })

  it('prepends title to facebook message when title is set', () => {
    const result = compileComposerInput(
      'facebook',
      state({ format: 'LINK', title: 'FB Title' }),
      draft,
    )
    expect(result.message).toBe('FB Title\n\nComposed copy')
  })

  it('does not prepend title when title is empty', () => {
    const result = compileComposerInput('instagram', state({ format: 'IMAGE', title: '' }), draft)
    expect(result.caption).toBe('Composed copy')
  })

  it('does not prepend title for pinterest (uses title field directly)', () => {
    const result = compileComposerInput(
      'pinterest',
      state({ format: 'IMAGE', title: 'Pin title' }),
      draft,
    )
    expect(result.title).toBe('Pin title')
    expect(result.description).toBe('Composed copy')
  })

  // --- Format field threading ---

  it('threads asset format to pinterest output', () => {
    const draftWithFormat: SocialDraft = {
      ...draft,
      media: [{ type: 'image', format: 'jpeg', url: 'https://cdn.test/front.jpg' }],
    }
    const result = compileComposerInput(
      'pinterest',
      state({ format: 'IMAGE', selectedMedia: ['https://cdn.test/front.jpg'] }),
      draftWithFormat,
    )
    expect(result.format).toBe('jpeg')
  })
})

// ---------------------------------------------------------------------------
// Standalone composer model
// ---------------------------------------------------------------------------

describe('buildStandaloneInitialState', () => {
  it('returns an empty state with no channels selected', () => {
    const initial = buildStandaloneInitialState(['pinterest', 'instagram'])
    expect(initial.channels).toEqual([])
    expect(initial.title).toBe('')
    expect(initial.media).toEqual([])
  })
})

describe('compileStandalonePublishBody', () => {
  const media: SocialDraftMedia[] = [
    { type: 'image', height: 600, url: 'https://cdn.test/img.jpg', width: 800 },
    { type: 'video', url: 'https://cdn.test/vid.mp4' },
  ]

  const standaloneState: StandaloneComposerState = {
    body: 'Hello world',
    channels: ['pinterest', 'instagram'],
    destinations: { instagram: 'ig-user-1', pinterest: 'board-1' },
    link: 'https://example.test',
    media,
    title: 'Test Post',
  }

  it('compiles content block with images', () => {
    const result = compileStandalonePublishBody(standaloneState, {})
    expect(result.content.title).toBe('Test Post')
    expect(result.content.body).toBe('Hello world')
    expect(result.content.link).toBe('https://example.test')
    expect(result.content.images).toEqual([
      { format: undefined, height: 600, url: 'https://cdn.test/img.jpg', width: 800 },
    ])
  })

  it('generates per-platform targets with correct destination ids', () => {
    const result = compileStandalonePublishBody(standaloneState, {})
    expect(result.targets).toHaveLength(2)
    const pinterestTarget = result.targets.find((t) => t.platform === 'pinterest')
    expect(pinterestTarget?.input.boardId).toBe('board-1')
    const igTarget = result.targets.find((t) => t.platform === 'instagram')
    expect(igTarget?.input.igUserId).toBe('ig-user-1')
  })

  it('uses per-channel format overrides', () => {
    const result = compileStandalonePublishBody(standaloneState, { pinterest: 'VIDEO' })
    const pinterestTarget = result.targets.find((t) => t.platform === 'pinterest')
    expect(pinterestTarget?.input.mediaType).toBe('VIDEO')
    expect(pinterestTarget?.input.videoUrl).toBe('https://cdn.test/vid.mp4')
  })

  it('omits optional content fields when empty', () => {
    const emptyState: StandaloneComposerState = {
      body: '',
      channels: ['pinterest'],
      destinations: { pinterest: 'b1' },
      link: '',
      media: [],
      title: 'Title only',
    }
    const result = compileStandalonePublishBody(emptyState, {})
    expect(result.content.body).toBeUndefined()
    expect(result.content.link).toBeUndefined()
    expect(result.content.images).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Fix 3: parseComposeResponse - standalone composer error-shape guard
// ---------------------------------------------------------------------------

describe('parseComposeResponse', () => {
  it('returns ok:true with data when response is ok and body.results is an array', () => {
    const body = {
      anyPublished: true,
      results: [{ ok: true, platform: 'pinterest' as const }],
    }
    const parsed = parseComposeResponse(true, body)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.data).toBe(body)
    }
  })

  it('returns ok:false with the server error message on non-ok HTTP', () => {
    const body = { error: 'Unauthorized' }
    const parsed = parseComposeResponse(false, body)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toBe('Unauthorized')
    }
  })

  it('returns ok:false with a generic message when the body has no error field', () => {
    const parsed = parseComposeResponse(false, {})
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(typeof parsed.error).toBe('string')
      expect(parsed.error.length).toBeGreaterThan(0)
    }
  })

  it('returns ok:false when body.results is not an array even if HTTP 200', () => {
    // A 200 response with a non-array results shape should be treated as error.
    const parsed = parseComposeResponse(true, { results: 'oops' })
    expect(parsed.ok).toBe(false)
  })

  it('returns ok:false when body is null', () => {
    const parsed = parseComposeResponse(true, null)
    expect(parsed.ok).toBe(false)
  })

  it('returns ok:false when body is a string (unexpected)', () => {
    const parsed = parseComposeResponse(false, 'Internal Server Error')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(typeof parsed.error).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 4: shouldFetchEnvelope - envelope cache guard
// ---------------------------------------------------------------------------

describe('shouldFetchEnvelope', () => {
  it('returns true when no envelope exists for the platform', () => {
    expect(shouldFetchEnvelope({}, 'pinterest')).toBe(true)
    expect(shouldFetchEnvelope({ instagram: undefined }, 'pinterest')).toBe(true)
  })

  it('returns false when an envelope already exists', () => {
    expect(shouldFetchEnvelope({ pinterest: { draft: {}, preview: {} } }, 'pinterest')).toBe(false)
  })

  it('returns false even when the stored value is undefined (key present)', () => {
    // The key being present means we've visited this tab before.
    expect(shouldFetchEnvelope({ pinterest: undefined }, 'pinterest')).toBe(false)
  })
})
