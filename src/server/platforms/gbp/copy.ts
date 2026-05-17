import type { SocialSourceContext } from '../../../types/index.js'

import { GBP_SUMMARY_MAX_CHARS } from '../../../constants.js'

/**
 * Plugin-default GBP LocalPost summary builder.
 *
 * The summary is the only piece of LocalPost copy under our control —
 * everything else (CTA actionType, offer details, event schedule) is
 * structural and host-supplied per-publish.
 *
 * Algorithm: lead with the channel-agnostic title, follow with the
 * normalized description body, cap at 1500 chars. Google moderation
 * down-ranks descriptions that read as brand fluff and rejects ones
 * containing phone numbers / explicit URLs / promotional language —
 * the default builder stays factual on purpose. Hosts override via
 * `options.copyOverrides.gbpSummary` if they want more flair.
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

export const buildDefaultGbpSummary = (ctx: SocialSourceContext): string => {
  const title = ctx.baseTitle.trim()
  const body = normalizeWhitespace(ctx.baseDescription ?? '')
  const composed = [title, body].filter(Boolean).join(' — ')
  return truncate(composed, GBP_SUMMARY_MAX_CHARS)
}
