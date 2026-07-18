import { describe, expect, it } from 'vitest'

import type { NormalizedPluginOptions, SocialSourceContext } from '../../../../types/index.js'

import { createPinterestAdapter } from '../adapter.js'

/**
 * Tests for the `checkFormatIssue` branch logic inside Pinterest's validate().
 * Pinterest allows: jpeg, png, webp.
 */

const buildOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true, ...overrides },
    copyOverrides: {},
    platforms: { pinterest: { environment: 'production' } },
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

describe('pinterest adapter — checkFormatIssue branches', () => {
  it('surfaces an error for avif (disallowed on Pinterest)', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('not accepted by Pinterest'))).toBe(true)
  })

  it('surfaces an error for bmp (disallowed on Pinterest)', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('bmp'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('"bmp"'))).toBe(true)
  })

  it('suppresses the error when autoConvert is enabled', async () => {
    const options = buildOptions({ autoConvert: true })
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('bypasses the check when preflight is disabled', async () => {
    const options = buildOptions({ preflight: false })
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for undefined format', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx(undefined),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for jpeg (allowed on Pinterest)', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('jpeg'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for webp (allowed on Pinterest)', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for png (allowed on Pinterest)', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('png'),
      input: { boardId: 'b1' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not check format for VIDEO mediaType', async () => {
    const options = buildOptions()
    const adapter = createPinterestAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: { boardId: 'b1', mediaType: 'VIDEO', videoUrl: 'https://cdn/v.mp4' },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })
})
