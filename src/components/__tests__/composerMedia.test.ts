import { describe, expect, it } from 'vitest'

import type { SocialDraftMedia } from '../../types/index.js'

import {
  filterMediaBySearch,
  mediaToggleLabel,
  resolveMediaLibraryOptions,
} from '../socialComposerModel.js'

const media = (overrides: Partial<SocialDraftMedia>): SocialDraftMedia => ({
  type: 'image',
  url: 'https://cdn.example.com/a.jpg',
  ...overrides,
})

const pool: SocialDraftMedia[] = [
  media({ altText: 'Blue Painting', role: 'detail', url: 'https://cdn.example.com/1.jpg' }),
  media({ altText: 'Bronze Sculpture', role: 'main', url: 'https://cdn.example.com/2.jpg' }),
  media({ type: 'video', url: 'https://cdn.example.com/3.mp4' }),
]

describe('filterMediaBySearch', () => {
  it('returns the whole pool for an empty or whitespace query', () => {
    expect(filterMediaBySearch(pool, '')).toBe(pool)
    expect(filterMediaBySearch(pool, '   ')).toBe(pool)
  })

  it('matches alt text, role and type case-insensitively', () => {
    expect(filterMediaBySearch(pool, 'BRONZE')).toEqual([pool[1]])
    expect(filterMediaBySearch(pool, 'main')).toEqual([pool[1]])
    expect(filterMediaBySearch(pool, 'video')).toEqual([pool[2]])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterMediaBySearch(pool, 'watercolour')).toEqual([])
  })
})

describe('mediaToggleLabel', () => {
  it('names the asset by its alt text when available', () => {
    expect(mediaToggleLabel(pool[0], false, true)).toBe('Select Blue Painting')
    expect(mediaToggleLabel(pool[0], true, true)).toBe('Deselect Blue Painting')
  })

  it('falls back to the media type when there is no alt text', () => {
    expect(mediaToggleLabel(pool[2], false, true)).toBe('Select video asset')
  })

  it('explains an unavailable format', () => {
    expect(mediaToggleLabel(pool[0], false, false)).toBe('Not available for this format')
  })
})

describe('resolveMediaLibraryOptions', () => {
  it('leaves the drawer unscoped without configuration', () => {
    expect(resolveMediaLibraryOptions(undefined)).toEqual({
      collectionSlugs: undefined,
      filterOptions: undefined,
    })
    expect(resolveMediaLibraryOptions({ enabledPlatforms: [] })).toEqual({
      collectionSlugs: undefined,
      filterOptions: undefined,
    })
  })

  it('passes configured collection slugs and filter options through', () => {
    const filterOptions = { media: { private: { not_equals: true } } }
    expect(
      resolveMediaLibraryOptions({ mediaLibrary: { collectionSlugs: ['media'], filterOptions } }),
    ).toEqual({ collectionSlugs: ['media'], filterOptions })
  })

  it('ignores malformed values', () => {
    expect(
      resolveMediaLibraryOptions({ mediaLibrary: { collectionSlugs: 'media', filterOptions: 3 } }),
    ).toEqual({ collectionSlugs: undefined, filterOptions: undefined })
    expect(resolveMediaLibraryOptions({ mediaLibrary: { collectionSlugs: ['media', 4] } })).toEqual(
      {
        collectionSlugs: ['media'],
        filterOptions: undefined,
      },
    )
  })
})
