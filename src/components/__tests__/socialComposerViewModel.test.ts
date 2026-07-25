import { describe, expect, it } from 'vitest'

import {
  asRecord,
  destinationPath,
  inferMediaFormat,
  platformFormats,
} from '../socialComposerViewModel.js'

describe('socialComposerViewModel', () => {
  it('accepts plain records and rejects arrays, null, and primitives', () => {
    const record = { id: 'board-1' }
    expect(asRecord(record)).toBe(record)
    expect(asRecord([])).toBeUndefined()
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord('board-1')).toBeUndefined()
  })

  it('prefers a normalized MIME subtype over the URL extension', () => {
    expect(
      inferMediaFormat('https://cdn.example.com/photo.avif', 'image/JPEG; charset=utf-8'),
    ).toBe('jpeg')
  })

  it('extracts a case-insensitive extension from absolute and relative URLs', () => {
    expect(inferMediaFormat('https://cdn.example.com/path/PHOTO.PNG?width=1200')).toBe('png')
    expect(inferMediaFormat('/media/video.MP4#preview')).toBe('mp4')
  })

  it('does not mistake a dotted hostname for a file extension', () => {
    expect(inferMediaFormat('https://cdn.example.com/media/no-extension')).toBeUndefined()
    expect(inferMediaFormat('not a valid URL')).toBeUndefined()
  })

  it('defines discovery paths and at least one format for every platform', () => {
    expect(destinationPath).toEqual({
      facebook: '/facebook/pages',
      gbp: '/gbp/locations',
      instagram: '/instagram/accounts',
      pinterest: '/pinterest/boards',
    })
    for (const formats of Object.values(platformFormats)) {
      expect(formats.length).toBeGreaterThan(0)
    }
  })
})
