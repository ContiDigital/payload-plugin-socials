import { describe, expect, it } from 'vitest'

import type { SocialSourceContext } from '../../../types/index.js'

import { buildDefaultFacebookMessage } from '../facebook/copy.js'
import { buildDefaultGbpSummary } from '../gbp/copy.js'
import { buildDefaultInstagramCaption, countHashtags, countMentions } from '../instagram/copy.js'
import {
  buildDefaultPinterestAltText,
  buildDefaultPinterestDescription,
  buildDefaultPinterestHashtags,
  buildDefaultPinterestTitle,
  truncate,
} from '../pinterest/copy.js'

const ctx = (overrides: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'Hand carved Italian marble.',
  baseTitle: 'Carrara Marble Mantel',
  images: [{ role: 'main', url: 'https://cdn.example.com/x.jpg' }],
  link: 'https://example.com/products/carrara',
  sourceId: '1',
  sourceKind: 'product',
  ...overrides,
})

describe('truncate', () => {
  it('returns the value untouched when within the limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('appends an ellipsis and stays within the limit when too long', () => {
    const out = truncate('hello world this is long', 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns just an ellipsis when the limit is 1 or less', () => {
    expect(truncate('hello', 1)).toBe('…')
  })
})

describe('buildDefaultPinterestTitle', () => {
  it('uses the base title alone when no model label is present', () => {
    expect(buildDefaultPinterestTitle(ctx({ baseTitle: 'Marble Lion' }))).toBe('Marble Lion')
  })

  it('appends the model label with a pipe separator', () => {
    expect(buildDefaultPinterestTitle(ctx({ baseTitle: 'Marble Lion', modelLabel: 'ML-01' }))).toBe(
      'Marble Lion | ML-01',
    )
  })

  it('truncates to the 100-char Pinterest limit', () => {
    const out = buildDefaultPinterestTitle(ctx({ baseTitle: 'A'.repeat(200) }))
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('buildDefaultPinterestDescription', () => {
  it('front-loads category + material + color, then body, attributes, hashtags', () => {
    const out = buildDefaultPinterestDescription(
      ctx({
        baseDescription: 'A regal lion.',
        baseTitle: 'Lion',
        metadata: {
          categoryLabel: 'Marble Statues',
          dimensions: '24in',
          googleColor: 'white',
          googleMaterial: 'marble',
        },
        modelLabel: 'LN-01',
      }),
    )
    expect(out.startsWith('Marble Statues crafted from marble in white.')).toBe(true)
    expect(out).toContain('A regal lion.')
    expect(out).toContain('Dimensions 24in.')
    expect(out).toContain('Model LN-01.')
    expect(out).toContain('#marble')
  })

  it('falls back to just the product copy when no metadata is present', () => {
    const out = buildDefaultPinterestDescription(
      ctx({ baseDescription: 'Plain body.', metadata: {} }),
    )
    expect(out).toBe('Plain body.')
  })

  it('caps the description at 500 chars', () => {
    const out = buildDefaultPinterestDescription(ctx({ baseDescription: 'x '.repeat(600) }))
    expect(out.length).toBeLessThanOrEqual(500)
  })
})

describe('buildDefaultPinterestAltText', () => {
  it('describes the visual content tangibly', () => {
    const out = buildDefaultPinterestAltText(
      ctx({
        baseTitle: 'Lion',
        metadata: {
          categoryLabel: 'Statues',
          dimensions: '24in',
          googleColor: 'White',
          googleMaterial: 'Marble',
        },
      }),
    )
    expect(out).toContain('Lion')
    expect(out).toContain('crafted from marble')
    expect(out).toContain('in white')
    expect(out).toContain('measuring 24in')
    expect(out).toContain('from the Statues collection')
  })

  it('omits the collection clause when the category is already in the title', () => {
    const out = buildDefaultPinterestAltText(
      ctx({ baseTitle: 'Statues Lion', metadata: { categoryLabel: 'Statues' } }),
    )
    expect(out).not.toContain('from the Statues collection')
  })

  it('falls back to a generic noun when the title is empty', () => {
    expect(buildDefaultPinterestAltText(ctx({ baseTitle: '', metadata: {} }))).toBe('Item.')
  })
})

describe('buildDefaultPinterestHashtags', () => {
  it('sources tags from segments, material, and color, capped at 5 with a # prefix', () => {
    const tags = buildDefaultPinterestHashtags(
      ctx({
        hints: { pinterestSegments: ['marble-statues'] },
        metadata: { googleColor: 'gold', googleMaterial: 'bronze' },
      }),
    )
    expect(tags.length).toBeLessThanOrEqual(5)
    expect(tags.every((t) => t.startsWith('#'))).toBe(true)
    expect(tags).toContain('#bronze')
    expect(tags).toContain('#gold')
  })

  it('excludes a standalone "multi" color', () => {
    const tags = buildDefaultPinterestHashtags(
      ctx({ metadata: { googleColor: 'multi', googleMaterial: 'marble' } }),
    )
    expect(tags).toEqual(['#marble'])
  })

  it('returns an empty array when there is nothing to tag', () => {
    expect(buildDefaultPinterestHashtags(ctx({ hints: {}, metadata: {} }))).toEqual([])
  })
})

describe('buildDefaultInstagramCaption', () => {
  it('joins title, body, hashtags and link with blank lines', () => {
    const out = buildDefaultInstagramCaption(
      ctx({
        baseDescription: 'Body text.',
        baseTitle: 'Title',
        hints: { instagramHashtags: ['#Marble', 'luxury decor', 'fine-art'] },
        link: 'https://example.com/p',
      }),
    )
    expect(out).toContain('Title')
    expect(out).toContain('Body text.')
    expect(out).toContain('#Marble')
    expect(out).toContain('#luxurydecor')
    expect(out).toContain('#fineart')
    expect(out).toContain('https://example.com/p')
    expect(out.split('\n\n').length).toBeGreaterThan(1)
  })

  it('caps the caption at 2200 chars', () => {
    const out = buildDefaultInstagramCaption(ctx({ baseDescription: 'y '.repeat(2000) }))
    expect(out.length).toBeLessThanOrEqual(2200)
  })
})

describe('caption counters', () => {
  it('counts hashtags', () => {
    expect(countHashtags('#alpha plain #beta #gamma')).toBe(3)
    expect(countHashtags('no tags here')).toBe(0)
  })

  it('counts mentions', () => {
    expect(countMentions('hi @user.name and @bob')).toBe(2)
  })
})

describe('buildDefaultFacebookMessage', () => {
  it('joins title and body without appending the link', () => {
    const out = buildDefaultFacebookMessage(
      ctx({ baseDescription: 'Body.', baseTitle: 'Title', link: 'https://example.com/p' }),
    )
    expect(out).toBe('Title\n\nBody.')
    expect(out).not.toContain('https://example.com/p')
  })
})

describe('buildDefaultGbpSummary', () => {
  it('joins title and body with an em-dash separator', () => {
    expect(buildDefaultGbpSummary(ctx({ baseDescription: 'Body.', baseTitle: 'Title' }))).toBe(
      'Title — Body.',
    )
  })

  it('caps the summary at 1500 chars', () => {
    const out = buildDefaultGbpSummary(ctx({ baseDescription: 'z '.repeat(1000) }))
    expect(out.length).toBeLessThanOrEqual(1500)
  })
})
