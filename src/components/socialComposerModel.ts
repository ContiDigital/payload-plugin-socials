import type { PlatformId } from '../constants.js'
import type { PreviewResult, SocialDraft, SocialDraftMedia } from '../types/index.js'

export type ComposerState = {
  alertType: '' | 'COVID_19'
  altText: string
  callToAction: '' | 'BOOK' | 'CALL' | 'LEARN_MORE' | 'ORDER' | 'SHOP' | 'SIGN_UP'
  callToActionUrl: string
  copy: string
  destinationId: string
  eventEnd: string
  eventStart: string
  eventTitle: string
  format: string
  languageCode: string
  link: string
  offerCode: string
  offerTerms: string
  selectedMedia: string[]
  shareToFeed: boolean
  title: string
  videoTitle: string
}

type DraftEnvelope = { draft: SocialDraft; preview: PreviewResult }

const formatDefaults: Record<PlatformId, string> = {
  facebook: 'LINK',
  gbp: 'STANDARD',
  instagram: 'IMAGE',
  pinterest: 'IMAGE',
}

export const buildInitialComposerState = (
  platform: PlatformId,
  envelope: DraftEnvelope,
): ComposerState => {
  const image = envelope.draft.media.find((asset) => asset.type === 'image')
  const video = envelope.draft.media.find((asset) => asset.type === 'video')
  const format = platform === 'pinterest' && !image && video ? 'VIDEO' : formatDefaults[platform]
  return {
    alertType: '',
    altText: envelope.preview.altText ?? image?.altText ?? '',
    callToAction: '',
    callToActionUrl: envelope.preview.link ?? envelope.draft.content.link,
    copy: envelope.preview.body ?? envelope.draft.content.body,
    destinationId: '',
    eventEnd: '',
    eventStart: '',
    eventTitle: envelope.draft.content.title,
    format,
    languageCode: '',
    link: envelope.preview.link ?? envelope.draft.content.link,
    offerCode: '',
    offerTerms: '',
    selectedMedia: [format === 'VIDEO' ? video?.url : image?.url].filter((url): url is string =>
      Boolean(url),
    ),
    shareToFeed: true,
    title: envelope.preview.title ?? envelope.draft.content.title,
    videoTitle: envelope.draft.content.title,
  }
}

export const getSelectedAssets = (state: ComposerState, draft: SocialDraft): SocialDraftMedia[] =>
  state.selectedMedia.flatMap((url) => {
    const asset = draft.media.find((candidate) => candidate.url === url)
    return asset ? [asset] : []
  })

const dateTimeParts = (value: string) => {
  const [dateValue, timeValue] = value.split('T')
  const [year, month, day] = dateValue.split('-').map(Number)
  const [hours, minutes] = (timeValue ?? '').split(':').map(Number)
  return {
    date: { day, month, year },
    time: Number.isFinite(hours)
      ? { hours, minutes: Number.isFinite(minutes) ? minutes : 0 }
      : undefined,
  }
}

export const compileComposerInput = (
  platform: PlatformId,
  state: ComposerState,
  draft: SocialDraft,
): Record<string, unknown> => {
  const assets = getSelectedAssets(state, draft)
  const firstImage =
    assets.find((asset) => asset.type === 'image') ??
    draft.media.find((asset) => asset.type === 'image')
  const firstVideo =
    assets.find((asset) => asset.type === 'video') ??
    draft.media.find((asset) => asset.type === 'video')

  if (platform === 'pinterest') {
    return {
      altText: state.altText,
      boardId: state.destinationId,
      coverImageUrl: firstVideo?.coverImageUrl ?? firstImage?.url,
      description: state.copy,
      imageUrl: firstImage?.url,
      link: state.link,
      mediaType: state.format,
      title: state.title,
      videoUrl: firstVideo?.url,
    }
  }
  if (platform === 'instagram') {
    const input: Record<string, unknown> = {
      altText: state.altText,
      caption: state.copy,
      igUserId: state.destinationId,
      mediaType: state.format,
      shareToFeed: state.shareToFeed,
    }
    if (state.format === 'IMAGE') {
      input.imageUrl = firstImage?.url
    }
    if (state.format === 'REELS') {
      input.coverUrl = firstVideo?.coverImageUrl ?? firstImage?.url
      input.videoUrl = firstVideo?.url
    }
    if (state.format === 'STORIES') {
      if (firstVideo) {
        input.videoUrl = firstVideo.url
      } else {
        input.imageUrl = firstImage?.url
      }
    }
    if (state.format === 'CAROUSEL') {
      input.carouselChildren = assets.map((asset) =>
        asset.type === 'video' ? { videoUrl: asset.url } : { imageUrl: asset.url },
      )
    }
    return input
  }
  if (platform === 'facebook') {
    const input: Record<string, unknown> = {
      altText: state.altText,
      format: state.format,
      link: state.link,
      message: state.copy,
      pageId: state.destinationId,
    }
    if (state.format === 'PHOTO') {
      input.imageUrl = firstImage?.url
    }
    if (state.format === 'PHOTO_MULTI') {
      input.imageUrls = assets.filter((asset) => asset.type === 'image').map((asset) => asset.url)
    }
    if (state.format === 'VIDEO') {
      input.videoTitle = state.videoTitle
      input.videoUrl = firstVideo?.url
    }
    return input
  }

  const input: Record<string, unknown> = {
    imageUrl: state.format === 'ALERT' ? undefined : firstImage?.url,
    languageCode: state.languageCode || undefined,
    locationResourceName: state.destinationId,
    summary: state.copy,
    topicType: state.format,
  }
  if (state.callToAction && state.format !== 'OFFER') {
    input.callToAction = {
      actionType: state.callToAction,
      url: state.callToAction === 'CALL' ? undefined : state.callToActionUrl,
    }
  }
  if (state.format === 'EVENT' || state.format === 'OFFER') {
    if (state.eventStart && state.eventEnd) {
      const start = dateTimeParts(state.eventStart)
      const end = dateTimeParts(state.eventEnd)
      input.event = {
        schedule: {
          endDate: end.date,
          endTime: end.time,
          startDate: start.date,
          startTime: start.time,
        },
        title: state.eventTitle,
      }
    }
  }
  if (state.format === 'OFFER') {
    input.offer = {
      couponCode: state.offerCode || undefined,
      redeemOnlineUrl: state.callToActionUrl || undefined,
      termsConditions: state.offerTerms || undefined,
    }
  }
  if (state.format === 'ALERT') {
    input.alertType = state.alertType
  }
  return input
}

export const supportsMultipleMedia = (platform: PlatformId, format: string): boolean =>
  (platform === 'instagram' && format === 'CAROUSEL') ||
  (platform === 'facebook' && format === 'PHOTO_MULTI')
