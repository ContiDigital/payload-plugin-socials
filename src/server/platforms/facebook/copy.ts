import type { SocialSourceContext } from '../../../types/index.js'

/**
 * Facebook Page message builder.
 *
 * Facebook has no hard character cap on Page posts (the practical max is
 * around 63,206 chars; nobody hits it). The default builder keeps it
 * concise: title + body + optional trailing link, mirroring how Pages
 * staff manually compose posts.
 *
 * Hosts override via `options.copyOverrides.facebookMessage`.
 */

const FACEBOOK_SOFT_MAX = 5000

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

export const buildDefaultFacebookMessage = (ctx: SocialSourceContext): string => {
  const title = ctx.baseTitle.trim()
  const body = normalizeWhitespace(ctx.baseDescription ?? '')
  // No appended link — `/feed` posts attach the link separately as a
  // first-class field which auto-renders a preview card. Adding it to
  // `message` would double-stuff the post.
  const composed = [title, body].filter(Boolean).join('\n\n')
  return truncate(composed, FACEBOOK_SOFT_MAX)
}
