import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { resolveTemplateCopy } from '../resolveTemplateCopy.js'

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

describe('resolveTemplateCopy', () => {
  it('renders each populated field against the source context', () => {
    const resolved = resolveTemplateCopy(
      {
        gbpSummary: '{{title}} now showing.',
        instagramCaption: '{{title}} | {{metadata.googleMaterial}}',
        pinterestTitle: '{{title}} ({{modelLabel}})',
      },
      ctx(),
    )
    expect(resolved.pinterestTitle).toBe('Marble Lion (ML-01)')
    expect(resolved.instagramCaption).toBe('Marble Lion | marble')
    expect(resolved.gbpSummary).toBe('Marble Lion now showing.')
  })

  it('omits empty, missing, and whitespace-only fields', () => {
    const resolved = resolveTemplateCopy(
      {
        facebookMessage: '   ',
        gbpSummary: null,
        pinterestTitle: '{{title}}',
      },
      ctx(),
    )
    expect(resolved.pinterestTitle).toBe('Marble Lion')
    expect(resolved).not.toHaveProperty('facebookMessage')
    expect(resolved).not.toHaveProperty('gbpSummary')
    expect(resolved).not.toHaveProperty('instagramCaption')
  })

  it('drops a field that renders to nothing', () => {
    const resolved = resolveTemplateCopy({ pinterestTitle: '{{missing}}' }, ctx())
    expect(resolved).not.toHaveProperty('pinterestTitle')
  })

  it('splits hashtags and normalizes a leading #', () => {
    const resolved = resolveTemplateCopy(
      {
        pinterestHashtags:
          '{{metadata.googleMaterial}} #{{metadata.googleColor}} luxury, ExampleBrand',
      },
      ctx(),
    )
    expect(resolved.pinterestHashtags).toEqual(['#marble', '#white', '#luxury', '#ExampleBrand'])
  })

  it('omits hashtags entirely when the template is empty', () => {
    const resolved = resolveTemplateCopy({ pinterestHashtags: '' }, ctx())
    expect(resolved).not.toHaveProperty('pinterestHashtags')
  })

  it('supports filters and extra per-publish variables', () => {
    const resolved = resolveTemplateCopy(
      { facebookMessage: '{{title | upper}} at {{boardName}}' },
      ctx(),
      { boardName: 'Statues Board' },
    )
    expect(resolved.facebookMessage).toBe('MARBLE LION at Statues Board')
  })

  it('returns an empty object for an all-empty template', () => {
    expect(resolveTemplateCopy({}, ctx())).toEqual({})
  })
})
