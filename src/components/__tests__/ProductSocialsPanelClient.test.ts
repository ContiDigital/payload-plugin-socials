import { describe, expect, it } from 'vitest'

import type { SocialDraft } from '../../types/index.js'
import type { ComposerState } from '../socialComposerModel.js'

import {
  buildInitialComposerState,
  compileComposerInput,
  getSelectedAssets,
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
    expect(compileComposerInput('facebook', state({ format }), draft)).toMatchObject(expected)
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
})
