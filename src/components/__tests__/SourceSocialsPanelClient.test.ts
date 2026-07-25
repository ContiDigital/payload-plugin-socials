import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@payloadcms/ui', () => ({
  Button: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
  useConfig: vi.fn(() => {
    throw new Error('useConfig must not run without sourceKind')
  }),
  useDocumentInfo: vi.fn(),
  useListDrawer: vi.fn(),
}))

import type { SocialDraft, SocialDraftMedia } from '../../types/index.js'
import type {
  ComposerState,
  ComposerTemplateSummary,
  StandaloneComposerState,
} from '../socialComposerModel.js'

import {
  acceptedMediaTypes,
  buildInitialComposerState,
  buildStandaloneInitialState,
  compileComposerInput,
  compileStandalonePublishBody,
  filenameFromUrl,
  filterTemplatesForContext,
  formatFromMime,
  formatLocalDateTimeMin,
  getSelectedAssets,
  isVideoAsset,
  mediaTypeFromMime,
  mergeDraftMedia,
  normalizeSelectedUploadMedia,
  parseComposeResponse,
  pickDefaultTemplate,
  pruneSelectedMedia,
  reorderSelectedMedia,
  resolveUploadFileUrl,
  shouldFetchEnvelope,
  stripLeadingTitle,
  supportsMultipleMedia,
} from '../socialComposerModel.js'
import { SocialPublishPanelClient } from '../SourceSocialsPanelClient.js'

describe('SocialPublishPanelClient', () => {
  it('reports a missing sourceKind without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const html = renderToStaticMarkup(React.createElement(SocialPublishPanelClient, {}))

    expect(html).toContain('Socials source is not configured.')
    expect(html).toContain('sourceKind')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

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
// Local-time picker boundary
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
// Standalone composer response guard
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
// Envelope cache guard
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

// ---------------------------------------------------------------------------
// Title / message deduplication (Instagram + Facebook)
// ---------------------------------------------------------------------------

describe('stripLeadingTitle', () => {
  it('removes the title and separating blank line from the body', () => {
    expect(stripLeadingTitle('Product 1\n\nA marble lion.', 'Product 1')).toBe('A marble lion.')
  })

  it('leaves a body that does not start with the title untouched', () => {
    expect(stripLeadingTitle('A marble lion.', 'Product 1')).toBe('A marble lion.')
  })

  it('is a no-op for an empty title', () => {
    expect(stripLeadingTitle('Product 1\n\nBody', '')).toBe('Product 1\n\nBody')
  })
})

describe('title prepend deduplication', () => {
  it('initializes instagram copy without the leading title', () => {
    const initialized = buildInitialComposerState('instagram', {
      draft,
      preview: {
        body: 'Preview title\n\nThe body.',
        link: 'https://l.test',
        title: 'Preview title',
      },
    })
    expect(initialized.title).toBe('Preview title')
    expect(initialized.copy).toBe('The body.')
  })

  it('keeps pinterest copy intact (dedicated title field)', () => {
    const initialized = buildInitialComposerState('pinterest', {
      draft,
      preview: {
        body: 'Preview title\n\nThe body.',
        link: 'https://l.test',
        title: 'Preview title',
      },
    })
    expect(initialized.copy).toBe('Preview title\n\nThe body.')
  })

  it('compiles facebook message as title + body exactly once', () => {
    const input = compileComposerInput(
      'facebook',
      state({ copy: 'The body.', format: 'PHOTO', title: 'Product 1' }),
      draft,
    )
    expect(input.message).toBe('Product 1\n\nThe body.')
  })

  it('does not double the title when the message already starts with it', () => {
    const input = compileComposerInput(
      'facebook',
      state({ copy: 'Product 1\n\nThe body.', format: 'PHOTO', title: 'Product 1' }),
      draft,
    )
    expect(input.message).toBe('Product 1\n\nThe body.')
  })
})

// ---------------------------------------------------------------------------
// Kind-scoped template selection
// ---------------------------------------------------------------------------

describe('filterTemplatesForContext', () => {
  const tpl = (
    over: { id: string } & Partial<ComposerTemplateSummary>,
  ): ComposerTemplateSummary => ({
    appliesTo: [],
    sourceKind: 'product',
    ...over,
  })

  it('excludes templates authored for a different source kind', () => {
    const templates = [
      tpl({ id: 'p', sourceKind: 'product' }),
      tpl({ id: 'b', sourceKind: 'blogPost' }),
    ]
    expect(filterTemplatesForContext(templates, 'product', 'pinterest').map((t) => t.id)).toEqual([
      'p',
    ])
  })

  it('treats an empty appliesTo as every platform', () => {
    const templates = [tpl({ id: 'all', appliesTo: [] })]
    expect(filterTemplatesForContext(templates, 'product', 'instagram').map((t) => t.id)).toEqual([
      'all',
    ])
    expect(filterTemplatesForContext(templates, 'product', 'facebook').map((t) => t.id)).toEqual([
      'all',
    ])
  })

  it('filters by platform when appliesTo is populated', () => {
    const templates = [
      tpl({ id: 'pin', appliesTo: ['pinterest'] }),
      tpl({ id: 'ig', appliesTo: ['instagram'] }),
    ]
    expect(filterTemplatesForContext(templates, 'product', 'pinterest').map((t) => t.id)).toEqual([
      'pin',
    ])
  })

  it('combines kind and platform filters', () => {
    const templates = [
      tpl({ id: 'a', appliesTo: ['pinterest'], sourceKind: 'product' }),
      tpl({ id: 'b', appliesTo: ['pinterest'], sourceKind: 'blogPost' }),
      tpl({ id: 'c', appliesTo: ['instagram'], sourceKind: 'product' }),
    ]
    expect(filterTemplatesForContext(templates, 'product', 'pinterest').map((t) => t.id)).toEqual([
      'a',
    ])
  })
})

describe('pickDefaultTemplate', () => {
  it('returns the first template flagged isDefault', () => {
    const templates = [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
      { id: 'c', isDefault: true },
    ]
    expect(pickDefaultTemplate(templates)?.id).toBe('b')
  })

  it('returns undefined when no template is a default', () => {
    expect(pickDefaultTemplate([{ id: 'a' }, { id: 'b', isDefault: false }])).toBeUndefined()
  })

  it('picks the default from a context-filtered list', () => {
    const templates: ComposerTemplateSummary[] = [
      { id: 'wrong-kind', appliesTo: [], isDefault: true, sourceKind: 'blogPost' },
      { id: 'right', appliesTo: ['pinterest'], isDefault: true, sourceKind: 'product' },
    ]
    const scoped = filterTemplatesForContext(templates, 'product', 'pinterest')
    expect(pickDefaultTemplate(scoped)?.id).toBe('right')
  })
})

// ---------------------------------------------------------------------------
// Media-library upload URL normalization
// ---------------------------------------------------------------------------

const uploadCtx = { apiRoute: '/api', collectionSlug: 'media', origin: 'https://host.test' }

describe('mediaTypeFromMime', () => {
  it('maps video/* to video and everything else to image', () => {
    expect(mediaTypeFromMime('video/mp4')).toBe('video')
    expect(mediaTypeFromMime('video/webm')).toBe('video')
    expect(mediaTypeFromMime('image/jpeg')).toBe('image')
    expect(mediaTypeFromMime(undefined)).toBe('image')
  })
})

describe('formatFromMime', () => {
  it('extracts the subtype token, dropping codec params', () => {
    expect(formatFromMime('video/mp4')).toBe('mp4')
    expect(formatFromMime('video/webm;codecs=vp9')).toBe('webm')
    expect(formatFromMime('image/png')).toBe('png')
    expect(formatFromMime(undefined)).toBeUndefined()
  })
})

describe('resolveUploadFileUrl', () => {
  it('passes an absolute url through unchanged', () => {
    expect(resolveUploadFileUrl({ url: 'https://cdn.test/clip.mp4' }, uploadCtx)).toBe(
      'https://cdn.test/clip.mp4',
    )
  })

  it('prefixes a relative url with the origin', () => {
    expect(resolveUploadFileUrl({ url: '/api/media/file/clip.mp4' }, uploadCtx)).toBe(
      'https://host.test/api/media/file/clip.mp4',
    )
  })

  it('falls back to the file endpoint when only filename is present', () => {
    expect(resolveUploadFileUrl({ filename: 'clip.mp4' }, uploadCtx)).toBe(
      'https://host.test/api/media/file/clip.mp4',
    )
  })

  it('encodes filename characters in the fallback path', () => {
    expect(resolveUploadFileUrl({ filename: 'my clip.mp4' }, uploadCtx)).toBe(
      'https://host.test/api/media/file/my%20clip.mp4',
    )
  })

  it('returns empty string when neither url nor filename is usable', () => {
    expect(resolveUploadFileUrl({}, uploadCtx)).toBe('')
    expect(resolveUploadFileUrl({ url: '   ' }, uploadCtx)).toBe('')
  })
})

describe('normalizeSelectedUploadMedia', () => {
  it('normalizes a relative video upload doc into a playable video asset', () => {
    // Empirical Payload 3.86 shape: relative url, video/mp4 mime, null dimensions.
    expect(
      normalizeSelectedUploadMedia(
        { height: null, mimeType: 'video/mp4', url: '/api/media/file/clip.mp4', width: null },
        uploadCtx,
      ),
    ).toEqual({
      type: 'video',
      altText: undefined,
      format: 'mp4',
      height: undefined,
      url: 'https://host.test/api/media/file/clip.mp4',
      width: undefined,
    })
  })

  it('types an image doc as image and carries alt/dimensions', () => {
    expect(
      normalizeSelectedUploadMedia(
        {
          alt: 'A statue',
          height: 1500,
          mimeType: 'image/jpeg',
          url: 'https://cdn.test/statue.jpg',
          width: 1000,
        },
        uploadCtx,
      ),
    ).toEqual({
      type: 'image',
      altText: 'A statue',
      format: 'jpeg',
      height: 1500,
      url: 'https://cdn.test/statue.jpg',
      width: 1000,
    })
  })

  it('uses the filename fallback when the doc has no url', () => {
    const asset = normalizeSelectedUploadMedia(
      { filename: 'clip.mp4', mimeType: 'video/mp4' },
      uploadCtx,
    )
    expect(asset?.url).toBe('https://host.test/api/media/file/clip.mp4')
    expect(asset?.type).toBe('video')
  })

  it('prefers the largest jpeg size for webp/avif images', () => {
    const asset = normalizeSelectedUploadMedia(
      {
        mimeType: 'image/webp',
        sizes: {
          large: { mimeType: 'image/jpeg', url: '/api/media/file/pic-1200.jpg', width: 1200 },
          small: { mimeType: 'image/jpeg', url: '/api/media/file/pic-400.jpg', width: 400 },
          webp: { mimeType: 'image/webp', url: '/api/media/file/pic-1600.webp', width: 1600 },
        },
        url: '/api/media/file/pic.webp',
      },
      uploadCtx,
    )
    expect(asset?.url).toBe('https://host.test/api/media/file/pic-1200.jpg')
  })

  it('returns undefined when no usable url can be resolved', () => {
    expect(normalizeSelectedUploadMedia({ mimeType: 'video/mp4' }, uploadCtx)).toBeUndefined()
  })

  it('carries a flat posterUrl for a video doc, absolutized from origin', () => {
    const asset = normalizeSelectedUploadMedia(
      {
        mimeType: 'video/mp4',
        posterUrl: '/api/media/file/poster.jpg',
        url: '/api/media/file/clip.mp4',
      },
      uploadCtx,
    )
    expect(asset?.posterUrl).toBe('https://host.test/api/media/file/poster.jpg')
  })

  it('reads a nested poster.url for a video doc and passes an absolute value through', () => {
    const asset = normalizeSelectedUploadMedia(
      {
        mimeType: 'video/mp4',
        poster: { url: 'https://cdn.test/poster.jpg' },
        url: 'https://cdn.test/clip.mp4',
      },
      uploadCtx,
    )
    expect(asset?.posterUrl).toBe('https://cdn.test/poster.jpg')
  })

  it('leaves posterUrl undefined for a video doc with no poster field', () => {
    const asset = normalizeSelectedUploadMedia(
      { mimeType: 'video/mp4', url: 'https://cdn.test/clip.mp4' },
      uploadCtx,
    )
    expect(asset?.posterUrl).toBeUndefined()
  })

  it('never sets posterUrl on an image doc even when a poster field is present', () => {
    const asset = normalizeSelectedUploadMedia(
      {
        mimeType: 'image/jpeg',
        posterUrl: '/api/media/file/poster.jpg',
        url: 'https://cdn.test/pic.jpg',
      },
      uploadCtx,
    )
    expect(asset?.type).toBe('image')
    expect(asset?.posterUrl).toBeUndefined()
  })
})

describe('filenameFromUrl', () => {
  it('returns the last path segment', () => {
    expect(filenameFromUrl('https://cdn.test/videos/clip.mp4')).toBe('clip.mp4')
  })

  it('strips the query string and fragment', () => {
    expect(filenameFromUrl('https://cdn.test/videos/clip.mp4?v=2#t=0.1')).toBe('clip.mp4')
  })

  it('decodes percent-encoding', () => {
    expect(filenameFromUrl('https://cdn.test/my%20clip.mp4')).toBe('my clip.mp4')
  })

  it('ignores a trailing slash', () => {
    expect(filenameFromUrl('https://cdn.test/videos/clip.mp4/')).toBe('clip.mp4')
  })

  it('falls back to the raw url when there is no usable segment', () => {
    expect(filenameFromUrl('')).toBe('')
  })

  it('falls back to the raw segment when decoding fails', () => {
    // A lone percent sign is not valid percent-encoding and throws in decodeURIComponent.
    expect(filenameFromUrl('https://cdn.test/bad%.mp4')).toBe('bad%.mp4')
  })
})

describe('isVideoAsset', () => {
  it('is true for a video asset', () => {
    expect(isVideoAsset({ type: 'video' })).toBe(true)
  })

  it('is false for an image asset', () => {
    expect(isVideoAsset({ type: 'image' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shared media pool across platform tabs
// ---------------------------------------------------------------------------

describe('mergeDraftMedia', () => {
  const img = (url: string): SocialDraftMedia => ({ type: 'image', url })

  it('lists resolver media first, then extras in insertion order', () => {
    expect(mergeDraftMedia([img('a'), img('b')], [img('c'), img('d')])).toEqual([
      img('a'),
      img('b'),
      img('c'),
      img('d'),
    ])
  })

  it('dedupes by url, keeping the first occurrence', () => {
    expect(mergeDraftMedia([img('a')], [img('a'), img('b')])).toEqual([img('a'), img('b')])
  })

  it('makes an asset added on one tab present in another tab pool', () => {
    // Simulates: extraMedia collected while on the facebook tab, then the
    // instagram tab merges its own resolver media with the same shared pool.
    const facebookAdded = img('https://cdn.test/added.jpg')
    const instagramResolver = [img('https://cdn.test/ig.jpg')]
    const instagramPool = mergeDraftMedia(instagramResolver, [facebookAdded])
    expect(instagramPool.map((m) => m.url)).toContain('https://cdn.test/added.jpg')
  })

  it('returns an empty array when both inputs are empty', () => {
    expect(mergeDraftMedia([], [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Selected-media ordering
// ---------------------------------------------------------------------------

describe('reorderSelectedMedia', () => {
  const list = ['a', 'b', 'c', 'd']

  it('moves an item forward', () => {
    expect(reorderSelectedMedia(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item backward', () => {
    expect(reorderSelectedMedia(list, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('clamps a target past the end to the last position', () => {
    expect(reorderSelectedMedia(list, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('clamps a negative target to the first position', () => {
    expect(reorderSelectedMedia(list, 2, -5)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('returns the same reference on an identity move', () => {
    expect(reorderSelectedMedia(list, 1, 1)).toBe(list)
  })

  it('returns the same reference when from is out of range', () => {
    expect(reorderSelectedMedia(list, 9, 0)).toBe(list)
    expect(reorderSelectedMedia(list, -1, 0)).toBe(list)
  })

  it('drives carousel child order through compileComposerInput', () => {
    const reordered = reorderSelectedMedia(
      ['https://cdn.test/front.jpg', 'https://cdn.test/detail.jpg'],
      0,
      1,
    )
    const input = compileComposerInput(
      'instagram',
      state({ format: 'CAROUSEL', selectedMedia: reordered }),
      draft,
    )
    expect(input.carouselChildren).toEqual([
      { format: undefined, imageUrl: 'https://cdn.test/detail.jpg' },
      { format: undefined, imageUrl: 'https://cdn.test/front.jpg' },
    ])
  })
})
