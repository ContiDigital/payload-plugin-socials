import { describe, expect, it } from 'vitest'

import type { NormalizedPluginOptions, SocialSourceContext } from '../../../../types/index.js'

import { createInstagramAdapter } from '../adapter.js'

/**
 * Tests for the `checkFormatIssue` branch logic inside Instagram's validate().
 * These cover: disallowed format (error), disallowed with autoConvert (suppressed),
 * preflight disabled (bypassed), undefined format (no issue), allowed format.
 */

const buildOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true, ...overrides },
    copyOverrides: {},
    platforms: { instagram: { apiVersion: 'v25.0', enabled: true, systemUserAccessToken: '' } },
  }) as unknown as NormalizedPluginOptions

const ctx = (format?: string): SocialSourceContext => ({
  baseDescription: 'body',
  baseTitle: 'Title',
  images: [
    {
      format: format as SocialSourceContext['images'][0]['format'],
      role: 'main',
      url: 'https://cdn/img.ext',
    },
  ],
  link: 'https://example.com',
  sourceId: '1',
  sourceKind: 'product',
})

describe('instagram adapter — checkFormatIssue branches', () => {
  it('surfaces an error when image format is disallowed (webp on Instagram)', async () => {
    const options = buildOptions()
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('not accepted by Instagram'))).toBe(true)
  })

  it('surfaces an error for avif on Instagram', async () => {
    const options = buildOptions()
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('"avif"'))).toBe(true)
  })

  it('suppresses the error when autoConvert is enabled', async () => {
    const options = buildOptions({ autoConvert: true })
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    // Should not surface a format issue
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('bypasses the check when preflight is disabled', async () => {
    const options = buildOptions({ preflight: false })
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error when format is undefined (unknown)', async () => {
    const options = buildOptions()
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx(undefined),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error when the format is allowed (jpeg)', async () => {
    const options = buildOptions()
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('jpeg'),
      input: { igUserId: 'ig1', imageUrl: 'https://cdn/img.ext', mediaType: 'IMAGE' },
      options,
    })
    expect(result.ok).toBe(true)
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not check format for non-IMAGE mediaTypes (REELS)', async () => {
    const options = buildOptions()
    const adapter = createInstagramAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { igUserId: 'ig1', mediaType: 'REELS', videoUrl: 'https://cdn/v.mp4' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })
})
