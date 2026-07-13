import type {
  NormalizedPluginOptions,
  SocialCopyFieldKey,
  SocialSourceContext,
} from '../../types/index.js'

import { buildTemplateScope, renderTemplate } from '../templates/renderTemplate.js'
import { splitHashtags } from '../templates/resolveTemplateCopy.js'

/**
 * Resolve one of the six string copy fields with the full precedence chain:
 *
 *   1. `transformations[ctx.sourceKind][field]`  — kind-specific (highest)
 *   2. `transformations['*'][field]`              — wildcard fallback
 *   3. `copyOverrides[field]`                     — function-only legacy
 *   4. `buildDefault(ctx)`                        — plugin default (lowest)
 *
 * When the winning value from step 1 or 2 is a string, it is rendered through
 * the plugin's `{{ variable | filter }}` template engine. When it is a
 * function, it is called with the `SocialSourceContext` directly.
 *
 * When `transformations` is empty (the common case for un-configured hosts)
 * this collapses to the same `copyOverrides ?? buildDefault` logic that
 * existed before the feature was added — no observable behavioral change.
 */
export const resolveConfiguredText = (
  field: Exclude<SocialCopyFieldKey, 'pinterestHashtags'>,
  ctx: SocialSourceContext,
  options: NormalizedPluginOptions,
  buildDefault: (ctx: SocialSourceContext) => string,
): string => {
  const transforms = options.transformations

  if (transforms) {
    // Kind-specific entry first, then wildcard.
    const transform =
      (transforms[ctx.sourceKind] as Record<string, unknown> | undefined)?.[field] ??
      (transforms['*'] as Record<string, unknown> | undefined)?.[field]

    if (transform !== undefined) {
      if (typeof transform === 'string') {
        return renderTemplate(transform, buildTemplateScope(ctx))
      }
      if (typeof transform === 'function') {
        return (transform as (ctx: SocialSourceContext) => string)(ctx)
      }
    }
  }

  // Fall through to legacy copyOverrides, then built-in default.
  const override = (options.copyOverrides as Record<string, unknown>)[field]
  if (typeof override === 'function') {
    return (override as (ctx: SocialSourceContext) => string)(ctx)
  }

  return buildDefault(ctx)
}

/**
 * Resolve the `pinterestHashtags` field with the same four-level precedence
 * chain as `resolveConfiguredText`, but for the hashtag-specific union type:
 *
 *   - String transforms: rendered through the template engine, then split via
 *     `splitHashtags` into a `string[]` of `#tag` values.
 *   - Function transforms: called directly, expected to return `string[]`.
 *   - `copyOverrides.pinterestHashtags`: called when present.
 *   - `buildDefault(ctx)`: the plugin default.
 */
export const resolveConfiguredHashtags = (
  ctx: SocialSourceContext,
  options: NormalizedPluginOptions,
  buildDefault: (ctx: SocialSourceContext) => string[],
): string[] => {
  const transforms = options.transformations

  if (transforms) {
    // Kind-specific entry first, then wildcard.
    const transform =
      (transforms[ctx.sourceKind] as Record<string, unknown> | undefined)?.['pinterestHashtags'] ??
      (transforms['*'] as Record<string, unknown> | undefined)?.['pinterestHashtags']

    if (transform !== undefined) {
      if (typeof transform === 'string') {
        const rendered = renderTemplate(transform, buildTemplateScope(ctx))
        return splitHashtags(rendered)
      }
      if (typeof transform === 'function') {
        return (transform as (ctx: SocialSourceContext) => string[])(ctx)
      }
    }
  }

  // Fall through to legacy copyOverrides, then built-in default.
  if (typeof options.copyOverrides.pinterestHashtags === 'function') {
    return options.copyOverrides.pinterestHashtags(ctx)
  }

  return buildDefault(ctx)
}
