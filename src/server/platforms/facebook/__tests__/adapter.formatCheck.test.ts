import { describe, expect, it } from 'vitest'

import type { NormalizedPluginOptions, SocialSourceContext } from '../../../../types/index.js'

import { createFacebookAdapter } from '../adapter.js'

/**
 * Tests for the `checkFormatIssue` branch logic inside Facebook's validate().
 * Facebook allows: jpeg, png, gif, bmp, tiff.
 */

const buildOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true, ...overrides },
    copyOverrides: {},
    platforms: { facebook: { apiVersion: 'v25.0', enabled: true, systemUserAccessToken: '' } },
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

describe('facebook adapter — checkFormatIssue branches', () => {
  it('surfaces an error for webp (disallowed on Facebook)', async () => {
    const options = buildOptions()
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('not accepted by Facebook'))).toBe(true)
  })

  it('surfaces an error for avif (disallowed on Facebook)', async () => {
    const options = buildOptions()
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('"avif"'))).toBe(true)
  })

  it('suppresses the error when autoConvert is enabled', async () => {
    const options = buildOptions({ autoConvert: true })
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('bypasses the check when preflight is disabled', async () => {
    const options = buildOptions({ preflight: false })
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for undefined format', async () => {
    const options = buildOptions()
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx(undefined),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for an allowed format (png)', async () => {
    const options = buildOptions()
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('png'),
      input: { format: 'PHOTO', imageUrl: 'https://cdn/img.ext', pageId: 'p1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not check format for non-PHOTO formats (LINK)', async () => {
    const options = buildOptions()
    const adapter = createFacebookAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { format: 'LINK', link: 'https://x', pageId: 'p1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })
})
