// Kept in lockstep with buildTemplateScope; parity is enforced by unit tests.
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

// The raw metadata object is not renderable; the preview endpoint supplies its leaf paths.
export const INSERTABLE_STATIC_TOKENS: ReadonlyArray<string> = TEMPLATE_SCOPE_TOKENS.filter(
  (token) => token !== 'metadata',
)

export type TemplateFilter = 'default' | 'lower' | 'trim' | 'truncate' | 'upper'

export const TEMPLATE_FILTERS = ['truncate', 'default', 'upper', 'lower', 'trim'] as const

export const FILTER_TAKES_ARG: Record<TemplateFilter, boolean> = {
  default: true,
  lower: false,
  trim: false,
  truncate: true,
  upper: false,
}

export const insertToken = (value: string, cursor: number, token: string): string => {
  const safeOffset = Math.max(0, Math.min(cursor, value.length))
  const snippet = `{{ ${token} }}`
  return `${value.slice(0, safeOffset)}${snippet}${value.slice(safeOffset)}`
}

// One invocation edits one placeholder so callers can target repeated tokens independently.
export const applyFilter = (value: string, token: string, filter: string, arg?: string): string => {
  const filterSpec = arg !== undefined && arg !== '' ? `${filter}:${arg}` : filter

  return value.replace(/\{\{([^{}]*)\}\}/, (_match, inner: string) => {
    const segments = inner.split('|').map((s) => s.trim())
    const path = segments[0] ?? ''
    if (path !== token) {
      return _match
    }
    if (!filter) {
      return `{{ ${token} }}`
    }
    const otherFilters = segments.slice(1).filter((s) => {
      const name = s.includes(':') ? s.slice(0, s.indexOf(':')) : s
      return name !== filter
    })
    const allFilters = [...otherFilters, filterSpec]
    return `{{ ${[token, ...allFilters].join(' | ')} }}`
  })
}

export type PreviewRequestBody = {
  fields: Record<string, string>
  sourceId: string
  sourceKind: string
}

export const compilePreviewRequestBody = (
  sourceKind: string,
  sourceId: string,
  fields: Record<string, string>,
): PreviewRequestBody => ({
  fields,
  sourceId,
  sourceKind,
})

export const isMetadataToken = (token: string): boolean => token.startsWith('metadata.')

// Runtime scope keys prevent one collection's fields leaking into another's picker.
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

export const sampleListUrl = (apiRoute: string, collection: string): string => {
  const base = apiRoute.replace(/\/$/, '')
  return `${base}/${encodeURIComponent(collection)}?limit=1&depth=0&sort=-createdAt`
}
