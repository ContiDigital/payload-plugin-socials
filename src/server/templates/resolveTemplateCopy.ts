import type { SocialSourceContext } from '../../types/index.js'

import { buildTemplateScope, renderTemplate } from './renderTemplate.js'

/**
 * The raw template strings stored on a `social-templates` row's `templates`
 * group. Every field is optional — a template only fills the channels it
 * cares about.
 */
export type SocialTemplateFields = {
  facebookMessage?: null | string
  gbpSummary?: null | string
  instagramCaption?: null | string
  pinterestAltText?: null | string
  pinterestDescription?: null | string
  pinterestHashtags?: null | string
  pinterestTitle?: null | string
}

/**
 * The resolved copy after a template's placeholders are filled against a
 * source context. `pinterestHashtags` is split into a normalized `#tag` array;
 * every other field is a plain string. Empty results are omitted entirely so
 * callers can spread this over their defaults without clobbering them.
 */
export type ResolvedTemplateCopy = {
  facebookMessage?: string
  gbpSummary?: string
  instagramCaption?: string
  pinterestAltText?: string
  pinterestDescription?: string
  pinterestHashtags?: string[]
  pinterestTitle?: string
}

const splitHashtags = (rendered: string): string[] =>
  rendered
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (token.startsWith('#') ? token : `#${token}`))

/**
 * Render a stored template's fields against a `SocialSourceContext`. Returns
 * only the channels the template actually populates (empty renders are
 * dropped), so the result is safe to spread over the default copy.
 */
export const resolveTemplateCopy = (
  fields: SocialTemplateFields,
  ctx: SocialSourceContext,
  extra: Record<string, unknown> = {},
): ResolvedTemplateCopy => {
  const scope = buildTemplateScope(ctx, extra)
  const render = (template: null | string | undefined): string | undefined => {
    if (!template || template.trim().length === 0) {
      return undefined
    }
    const out = renderTemplate(template, scope).trim()
    return out.length > 0 ? out : undefined
  }

  const hashtagsRendered = render(fields.pinterestHashtags)
  const resolved: ResolvedTemplateCopy = {}

  const facebookMessage = render(fields.facebookMessage)
  if (facebookMessage) {
    resolved.facebookMessage = facebookMessage
  }
  const gbpSummary = render(fields.gbpSummary)
  if (gbpSummary) {
    resolved.gbpSummary = gbpSummary
  }
  const instagramCaption = render(fields.instagramCaption)
  if (instagramCaption) {
    resolved.instagramCaption = instagramCaption
  }
  const pinterestAltText = render(fields.pinterestAltText)
  if (pinterestAltText) {
    resolved.pinterestAltText = pinterestAltText
  }
  const pinterestDescription = render(fields.pinterestDescription)
  if (pinterestDescription) {
    resolved.pinterestDescription = pinterestDescription
  }
  const pinterestTitle = render(fields.pinterestTitle)
  if (pinterestTitle) {
    resolved.pinterestTitle = pinterestTitle
  }
  if (hashtagsRendered) {
    const tags = splitHashtags(hashtagsRendered)
    if (tags.length > 0) {
      resolved.pinterestHashtags = tags
    }
  }

  return resolved
}
