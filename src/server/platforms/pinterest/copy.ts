import type { SocialSourceContext } from '../../../types/index.js'

import {
  PINTEREST_ALT_TEXT_MAX,
  PINTEREST_DESCRIPTION_MAX,
  PINTEREST_HASHTAGS_MAX,
  PINTEREST_TITLE_MAX,
} from '../../../constants.js'

/**
 * Plugin-default Pinterest copy builders. Operate purely on
 * `SocialSourceContext` — every host-specific concept (segments,
 * material taxonomy, brand tag) is driven by `ctx.metadata` /
 * `ctx.hints` so the plugin makes no assumptions about the host.
 *
 * Algorithm rationale and structure are extracted verbatim from Fine's
 * Gallery `src/lib/pinterest/pinAutomation.ts` (see CLAUDE.md §2.5):
 *
 *   Title       : "<base title>[ | <model>]" — capped at 100
 *   Description : "<lead>. <product copy> <attributes> <hashtags>" — capped at 500
 *                 (lead = "category crafted from material in color")
 *   Alt text    : tangible visual description, capped at 500
 *   Hashtags    : brand + segment + material + color, capped at 5
 *
 * Hosts override these via `options.copyOverrides.*`. The adapter calls the
 * default builders only when no override is supplied.
 */

const PINTEREST_ELLIPSIS = '…'

export const truncate = (value: string, max: number): string => {
  if (value.length <= max) {
    return value
  }
  if (max <= 1) {
    return PINTEREST_ELLIPSIS
  }
  return `${value.slice(0, max - 1).trimEnd()}${PINTEREST_ELLIPSIS}`
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const optionalString = (input: unknown): string | undefined => {
  if (typeof input !== 'string') {
    return undefined
  }
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const titleCase = (input: string): string =>
  input.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())

const toHashtagToken = (input: string): string => input.replace(/[^a-z0-9]/gi, '')

// ---------------------------------------------------------------------------
// Public default builders
// ---------------------------------------------------------------------------

export const buildDefaultPinterestTitle = (ctx: SocialSourceContext): string => {
  const base = ctx.baseTitle.trim()
  const model = ctx.modelLabel?.trim()
  const composed = model ? `${base} | ${model}` : base
  return truncate(composed, PINTEREST_TITLE_MAX)
}

export const buildDefaultPinterestDescription = (ctx: SocialSourceContext): string => {
  const metadata = ctx.metadata ?? {}
  const categoryLabel = optionalString(metadata.categoryLabel)
  const material = optionalString(metadata.googleMaterial)
  const color = optionalString(metadata.googleColor)
  const dimensions = optionalString(metadata.dimensions)
  const model = optionalString(ctx.modelLabel ?? undefined)

  const lead = [
    categoryLabel,
    material ? `crafted from ${material}` : undefined,
    color ? `in ${color}` : undefined,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' ')

  const productDesc = normalizeWhitespace(ctx.baseDescription ?? '')
  const attributes = [
    dimensions ? `Dimensions ${dimensions}.` : undefined,
    model ? `Model ${model}.` : undefined,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' ')

  const hashtags = buildDefaultPinterestHashtags(ctx).join(' ')

  const composed = [lead ? `${lead}.` : '', productDesc, attributes, hashtags]
    .filter(Boolean)
    .join(' ')

  return truncate(normalizeWhitespace(composed), PINTEREST_DESCRIPTION_MAX)
}

export const buildDefaultPinterestAltText = (ctx: SocialSourceContext): string => {
  const metadata = ctx.metadata ?? {}
  const material = optionalString(metadata.googleMaterial)
  const color = optionalString(metadata.googleColor)
  const dimensions = optionalString(metadata.dimensions)
  const categoryLabel = optionalString(metadata.categoryLabel)

  const baseTitle = ctx.baseTitle.trim() || 'Item'
  const parts: string[] = [baseTitle]
  if (material) {
    parts.push(`crafted from ${material.toLowerCase()}`)
  }
  if (color) {
    parts.push(`in ${color.toLowerCase()}`)
  }
  if (dimensions) {
    parts.push(`measuring ${dimensions}`)
  }
  if (categoryLabel && !baseTitle.toLowerCase().includes(categoryLabel.toLowerCase())) {
    parts.push(`from the ${categoryLabel} collection`)
  }
  return truncate(`${parts.join(', ')}.`, PINTEREST_ALT_TEXT_MAX)
}

/**
 * Default hashtag builder.
 *
 * Sources hashtags from (in order):
 *   1. `ctx.hints.pinterestSegments` — explicit per-source segment tags
 *   2. `ctx.metadata.googleMaterial` — material name
 *   3. `ctx.metadata.googleColor` — color (unless "multi"/empty)
 *
 * Result is deduped and capped at 5 (`PINTEREST_HASHTAGS_MAX`) per
 * Pinterest's algorithm tolerance. No dynamic per-item tags — those
 * degrade quickly into junk. Hosts that want a brand tag (e.g.
 * `#FinesGallery`) supply their own builder via `copyOverrides.pinterestHashtags`.
 */
export const buildDefaultPinterestHashtags = (ctx: SocialSourceContext): string[] => {
  const tags = new Set<string>()
  const hints = ctx.hints?.pinterestSegments
  if (Array.isArray(hints)) {
    for (const segment of hints) {
      const token = toHashtagToken(String(segment))
      if (token) {
        tags.add(titleCase(token))
      }
    }
  }
  const metadata = ctx.metadata ?? {}
  const material = optionalString(metadata.googleMaterial)
  if (material) {
    const token = toHashtagToken(material)
    if (token) {
      tags.add(token)
    }
  }
  const color = optionalString(metadata.googleColor)
  if (color && !/(?:^|\s)multi(?:\s|$)/i.test(color)) {
    const token = toHashtagToken(color)
    if (token) {
      tags.add(token)
    }
  }
  return Array.from(tags)
    .filter((token) => token.length > 0)
    .slice(0, PINTEREST_HASHTAGS_MAX)
    .map((token) => `#${token}`)
}
