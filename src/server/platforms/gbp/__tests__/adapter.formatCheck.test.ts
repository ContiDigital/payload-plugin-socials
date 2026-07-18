import { describe, expect, it } from 'vitest'

import type { NormalizedPluginOptions, SocialSourceContext } from '../../../../types/index.js'

import { createGbpAdapter } from '../adapter.js'

/**
 * Tests for the `checkFormatIssue` branch logic inside GBP's validate().
 * GBP allows: jpeg, png.
 */

const buildOptions = (
  overrides: Partial<NormalizedPluginOptions['assets']> = {},
): NormalizedPluginOptions =>
  ({
    assets: { autoConvert: false, jpegQuality: 82, preflight: true, ...overrides },
    copyOverrides: {},
    platforms: { gbp: { enabled: true } },
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

const VALID_INPUT = {
  imageUrl: 'https://cdn/img.ext',
  locationResourceName: 'accounts/a/locations/l',
  summary: 'Hello',
  topicType: 'STANDARD' as const,
}

describe('gbp adapter — checkFormatIssue branches', () => {
  it('surfaces an error for webp (disallowed on GBP)', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: VALID_INPUT,
      options,
    })
    expect(result.ok).toBe(false)
    expect(
      result.issues.some((i) => i.message.includes('not accepted by Google Business Profile')),
    ).toBe(true)
  })

  it('surfaces an error for avif (disallowed on GBP)', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('avif'),
      input: VALID_INPUT,
      options,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('"avif"'))).toBe(true)
  })

  it('suppresses the error when autoConvert is enabled', async () => {
    const options = buildOptions({ autoConvert: true })
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: VALID_INPUT,
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('bypasses the check when preflight is disabled', async () => {
    const options = buildOptions({ preflight: false })
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: VALID_INPUT,
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for undefined format', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx(undefined),
      input: VALID_INPUT,
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for an allowed format (jpeg)', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('jpeg'),
      input: VALID_INPUT,
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not error for png (allowed on GBP)', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('png'),
      input: VALID_INPUT,
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })

  it('does not check format when imageUrl is absent', async () => {
    const options = buildOptions()
    const adapter = createGbpAdapter(options)
    const result = await adapter.validate({
      ctx: ctx('webp'),
      input: { ...VALID_INPUT, imageUrl: undefined },
      options,
    })
    expect(result.issues.every((i) => !i.message.includes('not accepted'))).toBe(true)
  })
})
