/**
 * Pure, framework-free model for the social template builder UI.
 *
 * No React imports. All functions are unit-testable in isolation.
 *
 * Token catalogue:
 *   The TEMPLATE_SCOPE_TOKENS list mirrors the keys that `buildTemplateScope`
 *   returns. Keep this list in lockstep with that function — the test suite
 *   (`socialTemplateBuilderModel.test.ts`) asserts equality by calling
 *   `buildTemplateScope` with a realistic context and checking that every key
 *   produced by that function is present here.
 *
 * Token discovery:
 *   Static tokens are the entries in TEMPLATE_SCOPE_TOKENS minus `metadata`
 *   (which is the raw object, not a leaf). The preview endpoint additionally
 *   returns `scopeKeys` which includes discovered `metadata.*` leaf paths;
 *   those are merged into the picker at runtime.
 */

// ---------------------------------------------------------------------------
// Static token catalogue (must mirror buildTemplateScope keys)
// ---------------------------------------------------------------------------

/**
 * Friendly top-level alias tokens that `buildTemplateScope` always exposes.
 * These are the ONLY statically-known insertable tokens. The `metadata` entry
 * is the raw object and is NOT individually insertable; leaf paths within it
 * are discovered at runtime via the preview endpoint's `scopeKeys` response.
 */
export const TEMPLATE_SCOPE_TOKENS = [
  'baseDescription',
  'baseTitle',
  'description',
  'link',
  'metadata',
  'modelLabel',
  'sourceId',
  'sourceKind',
  'title',
] as const

export type TemplateScopeToken = (typeof TEMPLATE_SCOPE_TOKENS)[number]

/**
 * The leaf tokens the token picker presents as directly insertable. This
 * excludes `metadata` itself (which is an object, not a scalar) because
 * inserting `{{ metadata }}` would render nothing. Instead, `metadata.*`
 * leaf paths are discovered from the preview endpoint.
 */
export const INSERTABLE_STATIC_TOKENS: ReadonlyArray<string> = TEMPLATE_SCOPE_TOKENS.filter(
  (token) => token !== 'metadata',
)

// ---------------------------------------------------------------------------
// Available filters
// ---------------------------------------------------------------------------

export type TemplateFilter = 'default' | 'lower' | 'trim' | 'truncate' | 'upper'

export const TEMPLATE_FILTERS = ['truncate', 'default', 'upper', 'lower', 'trim'] as const

/**
 * Which filters take a colon-separated argument (e.g. `truncate:100`).
 */
export const FILTER_TAKES_ARG: Record<TemplateFilter, boolean> = {
  default: true,
  lower: false,
  trim: false,
  truncate: true,
  upper: false,
}

// ---------------------------------------------------------------------------
// Token insertion
// ---------------------------------------------------------------------------

/**
 * Insert `{{ token }}` into `value` at byte offset `cursor`.
 * If `cursor` is out of range it is clamped to the string's length.
 */
export const insertToken = (value: string, cursor: number, token: string): string => {
  const safeOffset = Math.max(0, Math.min(cursor, value.length))
  const snippet = `{{ ${token} }}`
  return `${value.slice(0, safeOffset)}${snippet}${value.slice(safeOffset)}`
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Parse the first `{{ path | ... }}` placeholder in `value` and rewrite its
 * filter chain. If no placeholder is present the value is returned unchanged.
 *
 * When `token` is provided, only a placeholder whose path matches `token` is
 * rewritten. When `filter` is `null` or the empty string, existing filters for
 * the matching path segment are stripped (reset to bare `{{ token }}`).
 *
 * This intentionally only rewrites the FIRST matching placeholder so callers
 * can apply it per-field without worrying about multi-placeholder templates.
 */
export const applyFilter = (value: string, token: string, filter: string, arg?: string): string => {
  const filterSpec = arg !== undefined && arg !== '' ? `${filter}:${arg}` : filter

  // Replace the first placeholder whose leading path segment matches token.
  return value.replace(/\{\{([^{}]*)\}\}/, (_match, inner: string) => {
    const segments = inner.split('|').map((s) => s.trim())
    const path = segments[0] ?? ''
    if (path !== token) {
      return _match
    }
    if (!filter) {
      return `{{ ${token} }}`
    }
    // Keep all non-matching filters, then append the new one.
    const otherFilters = segments.slice(1).filter((s) => {
      const name = s.includes(':') ? s.slice(0, s.indexOf(':')) : s
      return name !== filter
    })
    const allFilters = [...otherFilters, filterSpec]
    return `{{ ${[token, ...allFilters].join(' | ')} }}`
  })
}

// ---------------------------------------------------------------------------
// Preview request body compilation
// ---------------------------------------------------------------------------

export type PreviewRequestBody = {
  fields: Record<string, string>
  sourceId: string
  sourceKind: string
}

/**
 * Compile the per-field draft values into the body shape the
 * `POST {basePath}/templates/preview` endpoint expects.
 */
export const compilePreviewRequestBody = (
  sourceKind: string,
  sourceId: string,
  fields: Record<string, string>,
): PreviewRequestBody => ({
  fields,
  sourceId,
  sourceKind,
})

// ---------------------------------------------------------------------------
// Token classification helper
// ---------------------------------------------------------------------------

/**
 * Return true when `token` is a dynamic `metadata.*` key (i.e. discovered
 * from the preview endpoint's `scopeKeys` rather than statically known).
 */
export const isMetadataToken = (token: string): boolean => token.startsWith('metadata.')

// ---------------------------------------------------------------------------
// Kind-driven token discovery (from the preview endpoint's scopeKeys)
// ---------------------------------------------------------------------------

/**
 * Split the preview endpoint's `scopeKeys` response into the two groups the
 * token picker renders: `static` (friendly alias tokens like `title`,
 * `material`) and `metadata` (discovered `metadata.*` leaf paths). The bare
 * `metadata` object key and any empty/non-string entries are dropped, and each
 * group is deduped while preserving first-seen order.
 *
 * Driving the picker from this — rather than the fixed static list — means the
 * operator sees exactly the fields that resolve for the bound collection's
 * record, so a category template shows category fields, not product fields.
 */
export const tokensFromScopeKeys = (
  scopeKeys: readonly string[],
): { metadata: string[]; static: string[] } => {
  const staticTokens: string[] = []
  const metadata: string[] = []
  const seen = new Set<string>()
  for (const key of scopeKeys) {
    if (typeof key !== 'string' || key.length === 0 || key === 'metadata' || seen.has(key)) {
      continue
    }
    seen.add(key)
    if (isMetadataToken(key)) {
      metadata.push(key)
    } else {
      staticTokens.push(key)
    }
  }
  return { metadata, static: staticTokens }
}

/**
 * Host REST URL that fetches the most recent single record of a collection, so
 * the builder can auto-pick a sample record to drive token discovery and the
 * live preview: `{apiRoute}/{collection}?limit=1&depth=0&sort=-createdAt`.
 */
export const sampleListUrl = (apiRoute: string, collection: string): string => {
  const base = apiRoute.replace(/\/$/, '')
  return `${base}/${encodeURIComponent(collection)}?limit=1&depth=0&sort=-createdAt`
}
