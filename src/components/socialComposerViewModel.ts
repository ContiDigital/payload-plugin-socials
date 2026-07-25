import type { PlatformId } from '../constants.js'

export type ComposerDestination = { id: string; label: string }

export const platformFormats: Record<PlatformId, Array<{ label: string; value: string }>> = {
  facebook: [
    { label: 'Link or text', value: 'LINK' },
    { label: 'Single photo', value: 'PHOTO' },
    { label: 'Photo gallery', value: 'PHOTO_MULTI' },
    { label: 'Video', value: 'VIDEO' },
  ],
  gbp: [
    { label: 'Update', value: 'STANDARD' },
    { label: 'Event', value: 'EVENT' },
    { label: 'Offer', value: 'OFFER' },
    { label: 'Alert', value: 'ALERT' },
  ],
  instagram: [
    { label: 'Image', value: 'IMAGE' },
    { label: 'Reel', value: 'REELS' },
    { label: 'Story', value: 'STORIES' },
    { label: 'Carousel', value: 'CAROUSEL' },
  ],
  pinterest: [
    { label: 'Image Pin', value: 'IMAGE' },
    { label: 'Video Pin', value: 'VIDEO' },
  ],
}

export const destinationPath: Record<PlatformId, string> = {
  facebook: '/facebook/pages',
  gbp: '/gbp/locations',
  instagram: '/instagram/accounts',
  pinterest: '/pinterest/boards',
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const inferMediaFormat = (url: string, mimeType?: string): string | undefined => {
  if (mimeType) {
    const subtype = mimeType.split('/')[1]
    if (subtype) {
      return subtype.split(';')[0]?.trim().toLowerCase() || undefined
    }
  }
  try {
    const filename = new URL(url, 'https://payload-plugin-socials.invalid').pathname
      .split('/')
      .pop()
    const extensionIndex = filename?.lastIndexOf('.') ?? -1
    return extensionIndex > 0 ? filename?.slice(extensionIndex + 1).toLowerCase() : undefined
  } catch {
    return undefined
  }
}
