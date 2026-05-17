import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { buildTemplateScope, renderTemplate } from '../renderTemplate.js'

describe('renderTemplate — substitution', () => {
  it('substitutes a simple variable', () => {
    expect(renderTemplate('Hi {{title}}', { title: 'Marble Lion' })).toBe('Hi Marble Lion')
  })

  it('resolves a nested dot path', () => {
    expect(renderTemplate('{{metadata.material}}', { metadata: { material: 'bronze' } })).toBe(
      'bronze',
    )
  })

  it('renders multiple placeholders', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: 'one', b: 'two' })).toBe('one and two')
  })

  it('tolerates surrounding whitespace in the expression', () => {
    expect(renderTemplate('{{  title  }}', { title: 'X' })).toBe('X')
  })

  it('renders a missing path as an empty string', () => {
    expect(renderTemplate('a{{nope}}b', {})).toBe('ab')
  })

  it('leaves a string without placeholders untouched', () => {
    expect(renderTemplate('plain text', { title: 'x' })).toBe('plain text')
  })

  it('returns an empty string for a non-string template', () => {
    expect(renderTemplate(undefined as unknown as string, {})).toBe('')
  })

  it('stringifies numbers and booleans but not objects', () => {
    expect(renderTemplate('{{n}}/{{b}}/{{o}}', { b: true, n: 42, o: { a: 1 } })).toBe('42/true/')
  })
})

describe('renderTemplate — filters', () => {
  it('applies upper, lower, and trim', () => {
    expect(renderTemplate('{{x | upper}}', { x: 'hi' })).toBe('HI')
    expect(renderTemplate('{{x | lower}}', { x: 'HI' })).toBe('hi')
    expect(renderTemplate('{{x | trim}}', { x: '  hi  ' })).toBe('hi')
  })

  it('truncates to the given length with an ellipsis', () => {
    const out = renderTemplate('{{x | truncate:5}}', { x: 'abcdefghij' })
    expect(out.length).toBeLessThanOrEqual(5)
    expect(out.endsWith('…')).toBe(true)
  })

  it('does not truncate when within the limit', () => {
    expect(renderTemplate('{{x | truncate:50}}', { x: 'short' })).toBe('short')
  })

  it('uses the default filter only when the value is empty', () => {
    expect(renderTemplate('{{missing | default:Fallback}}', {})).toBe('Fallback')
    expect(renderTemplate('{{x | default:Fallback}}', { x: 'present' })).toBe('present')
  })

  it('chains filters left to right', () => {
    expect(renderTemplate('{{x | trim | upper}}', { x: '  hi  ' })).toBe('HI')
  })

  it('ignores an unknown filter', () => {
    expect(renderTemplate('{{x | bogus}}', { x: 'hi' })).toBe('hi')
  })
})

describe('renderTemplate — safety', () => {
  it('never reaches the prototype chain', () => {
    expect(renderTemplate('{{__proto__.polluted}}', {})).toBe('')
    expect(renderTemplate('{{constructor.name}}', {})).toBe('')
    expect(renderTemplate('{{a.constructor.name}}', { a: {} })).toBe('')
  })
})

describe('buildTemplateScope', () => {
  const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
    baseDescription: 'A regal marble lion.',
    baseTitle: 'Marble Lion',
    images: [],
    link: 'https://example.com/p',
    metadata: { categoryLabel: 'Statues', googleColor: 'white', googleMaterial: 'marble' },
    modelLabel: 'ML-01',
    sourceId: '1',
    sourceKind: 'product',
    ...over,
  })

  it('exposes friendly aliases from the context', () => {
    const scope = buildTemplateScope(ctx())
    expect(renderTemplate('{{title}} | {{material}} | {{category}} | {{modelLabel}}', scope)).toBe(
      'Marble Lion | marble | Statues | ML-01',
    )
  })

  it('exposes raw metadata for host-specific fields', () => {
    const scope = buildTemplateScope(ctx({ metadata: { sku: 'SKU-9' } }))
    expect(renderTemplate('{{metadata.sku}}', scope)).toBe('SKU-9')
  })

  it('layers in extra per-publish values', () => {
    const scope = buildTemplateScope(ctx(), { boardName: 'Marble Statues' })
    expect(renderTemplate('Pinned to {{boardName}}', scope)).toBe('Pinned to Marble Statues')
  })

  it('renders cleanly when optional metadata is absent', () => {
    const scope = buildTemplateScope(ctx({ metadata: undefined, modelLabel: null }))
    expect(renderTemplate('{{title}}{{material}}{{modelLabel}}', scope)).toBe('Marble Lion')
  })
})
