import type { SocialSourceContext } from '../../../types/index.js'

import { INSTAGRAM_CAPTION_MAX_CHARS, INSTAGRAM_CAPTION_MAX_HASHTAGS } from '../../../constants.js'

/**
 * Instagram caption builder + limit-counting helpers.
 *
 * Hard limits (CLAUDE.md §4.4):
 *   - 2200 chars total
 *   - 30 hashtags
 *   - 20 @mentions
 *
 * Exceeding any of these fails container creation with error code 100.
 *
 * The default builder is intentionally conservative: title + body + optional
 * trailing link, no hashtag salad. Hosts that want a richer caption supply
 * their own via `options.copyOverrides.instagramCaption`.
 */

const truncate = (value: string, max: number): string => {
  if (value.length <= max) {
    return value
  }
  if (max <= 1) {
    return '…'
  }
  return `${value.slice(0, max - 1).trimEnd()}…`
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

export const countHashtags = (caption: string): number => (caption.match(/#\w+/g) ?? []).length

export const countMentions = (caption: string): number => (caption.match(/@[\w.]+/g) ?? []).length

export const buildDefaultInstagramCaption = (ctx: SocialSourceContext): string => {
  const title = ctx.baseTitle.trim()
  const body = normalizeWhitespace(ctx.baseDescription ?? '')
  const hashtags = (ctx.hints?.instagramHashtags ?? [])
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/\W/g, '')}`))
    .filter((tag) => tag.length > 1)
    .slice(0, INSTAGRAM_CAPTION_MAX_HASHTAGS)
    .join(' ')
  const link = ctx.link?.trim() ?? ''

  const composed = [title, body, hashtags, link].filter(Boolean).join('\n\n')
  return truncate(composed, INSTAGRAM_CAPTION_MAX_CHARS)
}
