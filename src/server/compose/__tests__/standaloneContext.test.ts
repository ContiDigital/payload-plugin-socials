import { describe, expect, it } from 'vitest'

import { buildStandaloneContext } from '../standaloneContext.js'

describe('buildStandaloneContext', () => {
  it('builds a standalone context from inline content', () => {
    const ctx = buildStandaloneContext({
      body: 'Body text.',
      imageUrl: 'https://cdn/x.jpg',
      link: 'https://example.com/p',
      title: 'Spring Sale',
    })
    expect(ctx.sourceKind).toBe('standalone')
    expect(ctx.baseTitle).toBe('Spring Sale')
    expect(ctx.baseDescription).toBe('Body text.')
    expect(ctx.link).toBe('https://example.com/p')
    expect(ctx.images).toEqual([{ role: 'main', url: 'https://cdn/x.jpg' }])
    expect(typeof ctx.sourceId).toBe('string')
    expect(ctx.sourceId.length).toBeGreaterThan(0)
  })

  it('produces a stable id for identical content and a distinct id otherwise', () => {
    const a = buildStandaloneContext({ body: 'b', imageUrl: 'https://cdn/x.jpg', title: 'T' })
    const b = buildStandaloneContext({ body: 'b', imageUrl: 'https://cdn/x.jpg', title: 'T' })
    const c = buildStandaloneContext({
      body: 'different',
      imageUrl: 'https://cdn/x.jpg',
      title: 'T',
    })
    expect(a.sourceId).toBe(b.sourceId)
    expect(a.sourceId).not.toBe(c.sourceId)
  })

  it('prefers an explicit images array and defaults the role to main', () => {
    const ctx = buildStandaloneContext({
      images: [{ url: 'https://cdn/1.jpg' }, { role: 'detail', url: 'https://cdn/2.jpg' }],
      title: 'T',
    })
    expect(ctx.images).toEqual([
      { height: undefined, role: 'main', url: 'https://cdn/1.jpg', width: undefined },
      { height: undefined, role: 'detail', url: 'https://cdn/2.jpg', width: undefined },
    ])
  })

  it('defaults missing optional fields and yields no images when none are given', () => {
    const ctx = buildStandaloneContext({ title: 'Only a title' })
    expect(ctx.baseDescription).toBe('')
    expect(ctx.link).toBe('')
    expect(ctx.images).toEqual([])
  })
})
