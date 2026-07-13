import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../types/index.js'

import { buildTemplateScope } from '../../server/templates/renderTemplate.js'
import {
  applyFilter,
  compilePreviewRequestBody,
  INSERTABLE_STATIC_TOKENS,
  insertToken,
  isMetadataToken,
  TEMPLATE_SCOPE_TOKENS,
} from '../socialTemplateBuilderModel.js'

// ---------------------------------------------------------------------------
// Token catalogue tests
// ---------------------------------------------------------------------------

describe('TEMPLATE_SCOPE_TOKENS', () => {
  it('contains every key produced by buildTemplateScope for a fully-populated context', () => {
    const ctx: SocialSourceContext = {
      baseDescription: 'A fine piece',
      baseTitle: 'Marble Lion',
      images: [],
      link: 'https://example.test/ml',
      metadata: { categoryLabel: 'Statues', googleColor: 'white', googleMaterial: 'marble' },
      modelLabel: 'ML-01',
      sourceId: '1',
      sourceKind: 'product',
    }
    const scope = buildTemplateScope(ctx)
    const scopeKeys = Object.keys(scope)
    for (const key of scopeKeys) {
      expect(TEMPLATE_SCOPE_TOKENS).toContain(key)
    }
  })

  it('every TEMPLATE_SCOPE_TOKEN is a key in buildTemplateScope output', () => {
    const ctx: SocialSourceContext = {
      baseDescription: 'A fine piece',
      baseTitle: 'Marble Lion',
      images: [],
      link: 'https://example.test/ml',
      metadata: { categoryLabel: 'Statues' },
      modelLabel: null,
      sourceId: '1',
      sourceKind: 'product',
    }
    const scope = buildTemplateScope(ctx)
    for (const token of TEMPLATE_SCOPE_TOKENS) {
      expect(Object.prototype.hasOwnProperty.call(scope, token)).toBe(true)
    }
  })

  it('INSERTABLE_STATIC_TOKENS does not contain "metadata" (the raw object)', () => {
    expect(INSERTABLE_STATIC_TOKENS).not.toContain('metadata')
  })

  it('INSERTABLE_STATIC_TOKENS contains every other TEMPLATE_SCOPE_TOKEN', () => {
    const expected = TEMPLATE_SCOPE_TOKENS.filter((t) => t !== 'metadata')
    for (const token of expected) {
      expect(INSERTABLE_STATIC_TOKENS).toContain(token)
    }
  })
})

// ---------------------------------------------------------------------------
// insertToken
// ---------------------------------------------------------------------------

describe('insertToken', () => {
  it('inserts {{ token }} at the specified cursor position', () => {
    expect(insertToken('hello world', 5, 'title')).toBe('hello{{ title }} world')
  })

  it('appends when cursor equals the string length', () => {
    expect(insertToken('text', 4, 'title')).toBe('text{{ title }}')
  })

  it('prepends when cursor is 0', () => {
    expect(insertToken('text', 0, 'title')).toBe('{{ title }}text')
  })

  it('clamps an out-of-range cursor to the end', () => {
    expect(insertToken('hi', 999, 'title')).toBe('hi{{ title }}')
  })

  it('clamps a negative cursor to 0', () => {
    expect(insertToken('hi', -5, 'title')).toBe('{{ title }}hi')
  })

  it('inserts a metadata.* token correctly', () => {
    expect(insertToken('', 0, 'metadata.googleMaterial')).toBe('{{ metadata.googleMaterial }}')
  })
})

// ---------------------------------------------------------------------------
// applyFilter
// ---------------------------------------------------------------------------

describe('applyFilter', () => {
  it('rewrites a bare token with truncate:100', () => {
    expect(applyFilter('{{ title }}', 'title', 'truncate', '100')).toBe(
      '{{ title | truncate:100 }}',
    )
  })

  it('rewrites a bare token with upper (no arg)', () => {
    expect(applyFilter('{{ title }}', 'title', 'upper')).toBe('{{ title | upper }}')
  })

  it('rewrites an existing filter to a new one (appends)', () => {
    const result = applyFilter('{{ title | lower }}', 'title', 'truncate', '50')
    expect(result).toBe('{{ title | lower | truncate:50 }}')
  })

  it('resets filters when filter is empty string', () => {
    expect(applyFilter('{{ title | upper | truncate:10 }}', 'title', '')).toBe('{{ title }}')
  })

  it('does not touch a placeholder whose token does not match', () => {
    const original = '{{ description | lower }}'
    expect(applyFilter(original, 'title', 'upper')).toBe(original)
  })

  it('returns the value unchanged when no placeholder is present', () => {
    expect(applyFilter('no placeholders here', 'title', 'upper')).toBe('no placeholders here')
  })

  it('handles a default filter with an arg', () => {
    expect(applyFilter('{{ modelLabel }}', 'modelLabel', 'default', 'Shop Now')).toBe(
      '{{ modelLabel | default:Shop Now }}',
    )
  })
})

// ---------------------------------------------------------------------------
// compilePreviewRequestBody
// ---------------------------------------------------------------------------

describe('compilePreviewRequestBody', () => {
  it('returns the correct shape', () => {
    const body = compilePreviewRequestBody('product', '42', {
      instagramCaption: '{{ description | truncate:200 }}',
      pinterestTitle: '{{ title }}',
    })
    expect(body).toEqual({
      fields: {
        instagramCaption: '{{ description | truncate:200 }}',
        pinterestTitle: '{{ title }}',
      },
      sourceId: '42',
      sourceKind: 'product',
    })
  })

  it('accepts an empty fields map', () => {
    const body = compilePreviewRequestBody('product', '1', {})
    expect(body.fields).toEqual({})
    expect(body.sourceId).toBe('1')
    expect(body.sourceKind).toBe('product')
  })
})

// ---------------------------------------------------------------------------
// isMetadataToken
// ---------------------------------------------------------------------------

describe('isMetadataToken', () => {
  it('returns true for metadata.* keys', () => {
    expect(isMetadataToken('metadata.googleMaterial')).toBe(true)
    expect(isMetadataToken('metadata.categoryLabel')).toBe(true)
  })

  it('returns false for static alias tokens', () => {
    expect(isMetadataToken('title')).toBe(false)
    expect(isMetadataToken('description')).toBe(false)
    expect(isMetadataToken('metadata')).toBe(false)
  })
})
