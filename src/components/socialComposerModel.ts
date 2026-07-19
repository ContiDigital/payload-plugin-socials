import type { PlatformId } from '../constants.js'
import type { PreviewResult, SocialDraft, SocialDraftMedia } from '../types/index.js'

export type MediaType = 'image' | 'video'

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

/**
 * Returns the accepted media types for a given platform and format combination.
 * Used to filter which assets are selectable in the composer and to validate
 * that selected media matches the format requirements.
 */
export const acceptedMediaTypes = (platform: PlatformId, format: string): MediaType[] => {
  if (platform === 'pinterest') {
    if (format === 'VIDEO') {
      return ['video']
    }
    return ['image']
  }
  if (platform === 'instagram') {
    if (format === 'IMAGE') {
      return ['image']
    }
    if (format === 'REELS') {
      return ['video']
    }
    return ['image', 'video'] // STORIES, CAROUSEL
  }
  if (platform === 'facebook') {
    if (format === 'LINK') {
      return ['image']
    } // optional, but only image when present
    if (format === 'PHOTO' || format === 'PHOTO_MULTI') {
      return ['image']
    }
    if (format === 'VIDEO') {
      return ['video']
    }
    return ['image']
  }
  // GBP: all formats use images only
  return ['image']
}

/**
 * Prune selected media URLs whose asset type is no longer accepted for the
 * current format. Returns the pruned list and any removed URLs.
 */
export const pruneSelectedMedia = (
  selectedMedia: string[],
  draftMedia: SocialDraftMedia[],
  platform: PlatformId,
  format: string,
): { pruned: string[]; removed: string[] } => {
  const accepted = acceptedMediaTypes(platform, format)
  const pruned: string[] = []
  const removed: string[] = []
  for (const url of selectedMedia) {
    const asset = draftMedia.find((m) => m.url === url)
    if (asset && accepted.includes(asset.type)) {
      pruned.push(url)
    } else {
      removed.push(url)
    }
  }
  return { pruned, removed }
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

/**
 * Format a Date into the `YYYY-MM-DDTHH:MM` string that
 * `<input type="datetime-local">` expects as its `min` attribute.
 *
 * `new Date().toISOString().slice(0, 16)` returns UTC wall-clock time.
 * A `datetime-local` input interprets the `min` value in the browser's LOCAL
 * timezone, so UTC-offset machines see the wrong boundary. This helper reads
 * the local date-time components from the Date object directly to produce a
 * string that matches the browser's interpretation of `min`.
 *
 * Passing a fixed Date in tests makes the output fully deterministic.
 */
export const formatLocalDateTimeMin = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

/**
 * Compile the composer state into a platform-specific publish input.
 *
 * Media selection rules (strict, no silent fallback):
 * - Only assets whose type matches `acceptedMediaTypes(platform, format)` are used.
 * - If the user has selected accepted assets, use those only.
 * - If no assets are selected and the draft has exactly one accepted asset,
 *   auto-use that one for convenience.
 * - Otherwise no media is populated; validation will report it missing.
 *
 * Title prepend: when `state.title` is set and the platform is instagram or
 * facebook, it becomes the first line of the caption/message.
 */
export const compileComposerInput = (
  platform: PlatformId,
  state: ComposerState,
  draft: SocialDraft,
): Record<string, unknown> => {
  const accepted = acceptedMediaTypes(platform, state.format)
  const selectedAssets = getSelectedAssets(state, draft).filter((a) => accepted.includes(a.type))

  // Auto-select: when nothing explicitly selected, use the single accepted asset if one exists
  const draftAccepted = draft.media.filter((a) => accepted.includes(a.type))
  const effectiveAssets =
    selectedAssets.length > 0 ? selectedAssets : draftAccepted.length === 1 ? draftAccepted : []

  const firstImage = effectiveAssets.find((a) => a.type === 'image')
  const firstVideo = effectiveAssets.find((a) => a.type === 'video')

  // Title prepend for instagram and facebook (not pinterest, which has its own title field)
  const buildCopy = (): string => {
    if ((platform === 'instagram' || platform === 'facebook') && state.title) {
      return `${state.title}\n\n${state.copy}`
    }
    return state.copy
  }

  if (platform === 'pinterest') {
    return {
      altText: state.altText,
      boardId: state.destinationId,
      coverImageUrl: firstVideo?.coverImageUrl ?? firstImage?.url,
      description: state.copy,
      format: firstImage?.format ?? firstVideo?.format,
      imageUrl: firstImage?.url,
      link: state.link,
      mediaType: state.format,
      title: state.title,
      videoUrl: firstVideo?.url,
    }
  }
  if (platform === 'instagram') {
    const copy = buildCopy()
    const input: Record<string, unknown> = {
      altText: state.altText,
      caption: copy,
      format: firstImage?.format ?? firstVideo?.format,
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
      input.carouselChildren = effectiveAssets.map((asset) =>
        asset.type === 'video'
          ? { format: asset.format, videoUrl: asset.url }
          : { format: asset.format, imageUrl: asset.url },
      )
    }
    return input
  }
  if (platform === 'facebook') {
    const copy = buildCopy()
    const input: Record<string, unknown> = {
      altText: state.altText,
      format: state.format,
      link: state.link,
      message: copy,
      pageId: state.destinationId,
    }
    if (state.format === 'PHOTO') {
      input.imageUrl = firstImage?.url
      input.imageFormat = firstImage?.format
    }
    if (state.format === 'PHOTO_MULTI') {
      input.imageUrls = effectiveAssets
        .filter((asset) => asset.type === 'image')
        .map((asset) => asset.url)
    }
    if (state.format === 'VIDEO') {
      input.videoTitle = state.videoTitle
      input.videoUrl = firstVideo?.url
      input.videoFormat = firstVideo?.format
    }
    return input
  }

  // GBP
  const input: Record<string, unknown> = {
    imageFormat: state.format === 'ALERT' ? undefined : firstImage?.format,
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

// ---------------------------------------------------------------------------
// Standalone composer model
// ---------------------------------------------------------------------------

export type StandaloneComposerState = {
  body: string
  channels: PlatformId[]
  destinations: Partial<Record<PlatformId, string>>
  link: string
  media: SocialDraftMedia[]
  title: string
}

export const buildStandaloneInitialState = (
  _enabledPlatforms: PlatformId[],
): StandaloneComposerState => ({
  body: '',
  channels: [],
  destinations: {},
  link: '',
  media: [],
  title: '',
})

/**
 * Compile standalone composer state into the request body for
 * POST {basePath}/compose/publish.
 */
export const compileStandalonePublishBody = (
  state: StandaloneComposerState,
  perChannelFormat: Partial<Record<PlatformId, string>>,
): {
  content: {
    body?: string
    images?: Array<{ format?: string; height?: number; url: string; width?: number }>
    link?: string
    title: string
  }
  targets: Array<{ input: Record<string, unknown>; platform: PlatformId }>
} => {
  const images = state.media
    .filter((m) => m.type === 'image')
    .map((m) => ({ format: m.format, height: m.height, url: m.url, width: m.width }))

  const targets = state.channels.map((platform) => {
    const format = perChannelFormat[platform] ?? formatDefaults[platform]
    const destinationId = state.destinations[platform] ?? ''
    const accepted = acceptedMediaTypes(platform, format)
    const acceptedAssets = state.media.filter((m) => accepted.includes(m.type))
    const firstImage = acceptedAssets.find((a) => a.type === 'image')
    const firstVideo = acceptedAssets.find((a) => a.type === 'video')

    const input: Record<string, unknown> = {}

    if (platform === 'pinterest') {
      input.boardId = destinationId
      input.imageUrl = firstImage?.url
      input.videoUrl = firstVideo?.url
      input.mediaType = format
    } else if (platform === 'instagram') {
      input.igUserId = destinationId
      input.mediaType = format
      if (format === 'IMAGE') {
        input.imageUrl = firstImage?.url
      }
      if (format === 'REELS') {
        input.videoUrl = firstVideo?.url
      }
      if (format === 'STORIES') {
        input.imageUrl = firstImage?.url
        input.videoUrl = firstVideo?.url
      }
      if (format === 'CAROUSEL') {
        input.carouselChildren = acceptedAssets.map((a) =>
          a.type === 'video' ? { videoUrl: a.url } : { imageUrl: a.url },
        )
      }
    } else if (platform === 'facebook') {
      input.pageId = destinationId
      input.format = format
      if (format === 'PHOTO') {
        input.imageUrl = firstImage?.url
      }
      if (format === 'PHOTO_MULTI') {
        input.imageUrls = acceptedAssets.filter((a) => a.type === 'image').map((a) => a.url)
      }
      if (format === 'VIDEO') {
        input.videoUrl = firstVideo?.url
      }
    } else {
      // GBP
      input.locationResourceName = destinationId
      input.topicType = format
      input.imageUrl = firstImage?.url
    }

    return { input, platform }
  })

  return {
    content: {
      body: state.body || undefined,
      images: images.length > 0 ? images : undefined,
      link: state.link || undefined,
      title: state.title,
    },
    targets,
  }
}

// ---------------------------------------------------------------------------
// Compose response guard (Fix 3: standalone composer crash on error response)
// ---------------------------------------------------------------------------

export type ComposeResult = {
  anyPublished: boolean
  results: Array<{
    error?: string
    ok: boolean
    platform: PlatformId
    publishedRef?: {
      externalId: string
      externalUrl?: string
      meta?: Record<string, unknown>
      platform: PlatformId
    }
  }>
}

/**
 * Parse and validate a response from the standalone compose endpoint.
 *
 * On a non-ok HTTP response OR a body that does not have an array `results`
 * property, returns `{ ok: false, error }` with the server's error message (or
 * a generic fallback). Only when the body looks like a valid ComposeResult is
 * `{ ok: true, data }` returned.
 *
 * Extracting this decision keeps the component thin and the guard fully
 * testable without a DOM/browser environment.
 */
export const parseComposeResponse = (
  httpOk: boolean,
  body: unknown,
): { data: ComposeResult; ok: true } | { error: string; ok: false } => {
  const rec =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined

  if (!httpOk || !rec || !Array.isArray(rec.results)) {
    const errorMsg =
      typeof rec?.error === 'string' && rec.error
        ? rec.error
        : `Publish failed${httpOk ? '' : ' (server error)'}`
    return { error: errorMsg, ok: false }
  }

  return { data: body as ComposeResult, ok: true }
}

// ---------------------------------------------------------------------------
// Envelope cache helper (Fix 4: media preserved on tab switch)
// ---------------------------------------------------------------------------

/**
 * Return true when the source composer should fetch a fresh preview envelope
 * for the given platform.
 *
 * Cache-first: if an envelope already exists in state (because the user has
 * visited this platform tab before), we do NOT refetch — that would wipe any
 * media the user added via Add URL or the Media library. The initial fetch
 * per platform still happens when no envelope exists.
 */
export const shouldFetchEnvelope = (
  envelopes: Partial<Record<string, unknown>>,
  platform: string,
): boolean => !(platform in envelopes)
