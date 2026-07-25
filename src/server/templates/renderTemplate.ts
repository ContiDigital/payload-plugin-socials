import type { SocialSourceContext } from '../../types/index.js'

/**
 * A tiny, safe template interpolation engine for reusable post templates.
 *
 * Syntax: `{{ path | filter:arg | filter }}`
 *
 *   - `path` is a dot path resolved against the scope object. Universal
 *     source-context fields are top level (`{{ title }}`, `{{ description }}`,
 *     `{{ link }}`); host-specific fields live under `metadata`
 *     (`{{ metadata.anyKeyYourResolverExposes }}`).
 *   - filters run left to right over the stringified value:
 *       `upper`, `lower`, `trim`,
 *       `truncate:N`  (cap at N chars with a trailing ellipsis),
 *       `default:txt` (substitute `txt` when the value is empty).
 *
 * Design constraints:
 *   - No `eval`, no function execution — pure string substitution.
 *   - Prototype-pollution safe: `__proto__`, `prototype`, `constructor`
 *     short-circuit to undefined, so a template can never reach the
 *     prototype chain.
 *   - A missing path renders to an empty string (or the `default` filter
 *     value), never `undefined` or `[object Object]`.
 *
 * This is intentionally NOT a general-purpose template language. It covers
 * the "fill a sentence with product fields" use case and nothing more.
 */

type FilterFn = (value: string, arg?: string) => string

const FILTERS: Record<string, FilterFn> = {
  default: (value, arg) => (value.length === 0 ? (arg ?? '') : value),
  lower: (value) => value.toLowerCase(),
  trim: (value) => value.trim(),
  truncate: (value, arg) => {
    const max = Number(arg)
    if (!Number.isFinite(max) || max <= 0 || value.length <= max) {
      return value
    }
    return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  },
  upper: (value) => value.toUpperCase(),
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const resolvePath = (scope: Record<string, unknown>, path: string): unknown => {
  const keys = path
    .split('.')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
  let current: unknown = scope
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return undefined
    }
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const stringifyValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  // Objects and arrays are intentionally not rendered — a template that
  // references a non-scalar produces an empty string rather than noise.
  return ''
}

export const renderTemplate = (template: string, scope: Record<string, unknown>): string => {
  if (typeof template !== 'string' || template.length === 0) {
    return ''
  }
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const segments = raw.split('|').map((segment) => segment.trim())
    const path = segments[0]
    if (!path) {
      return ''
    }
    let value = stringifyValue(resolvePath(scope, path))
    for (let i = 1; i < segments.length; i += 1) {
      const spec = segments[i]
      const colon = spec.indexOf(':')
      const name = colon === -1 ? spec : spec.slice(0, colon)
      const arg = colon === -1 ? undefined : spec.slice(colon + 1).trim()
      const filter = FILTERS[name]
      if (filter) {
        value = filter(value, arg)
      }
    }
    return value
  })
}

/**
 * Build the variable scope a template renders against from a
 * `SocialSourceContext`. Exposes the universal context fields (`title`,
 * `description`, `link`, `modelLabel`, `sourceId`, `sourceKind`) plus the raw
 * `metadata` object so authors reach host-specific fields via
 * `{{ metadata.anything }}`. The `extra` map lets callers layer in per-publish
 * values (e.g. a board name or an offer code).
 */
export const buildTemplateScope = (
  ctx: SocialSourceContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  baseDescription: ctx.baseDescription,
  baseTitle: ctx.baseTitle,
  description: ctx.baseDescription,
  link: ctx.link,
  metadata: ctx.metadata ?? {},
  modelLabel: ctx.modelLabel ?? undefined,
  sourceId: ctx.sourceId,
  sourceKind: ctx.sourceKind,
  title: ctx.baseTitle,
  ...extra,
})
