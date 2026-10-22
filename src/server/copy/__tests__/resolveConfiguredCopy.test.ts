import { describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  SocialSourceContext,
  SocialsTransformations,
} from '../../../types/index.js'

import { resolveConfiguredHashtags, resolveConfiguredText } from '../resolveConfiguredCopy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCtx = (overrides: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'Hand-finished Italian marble.',
  baseTitle: 'Carrara Mantel',
  images: [{ role: 'main', url: 'https://cdn.example.com/x.jpg' }],
  link: 'https://example.com/p/carrara',
  sourceId: '42',
  sourceKind: 'product',
  ...overrides,
})

const makeOptions = (
  transformations: SocialsTransformations = Object.freeze({}) as SocialsTransformations,
  copyOverrides: NormalizedPluginOptions['copyOverrides'] = {},
): NormalizedPluginOptions =>
  ({
    admin: {
      adminBase: '/admin',
      injectInto: [],
      mode: 'route',
      navLabel: 'Socials',
      route: '/socials',
    },
    api: { basePath: '/socials' },
    assets: {
      autoConvert: false,
      jpegQuality: 82,
      maxConcurrentConversions: 1,
      maxSourceImageBytes: 25 * 1024 * 1024,
      normalize: false,
      preflight: true,
      remoteFetchTimeoutMs: 15_000,
      renditionData: {},
      trustedRemoteHosts: [],
    },
    authorize: () => true,
    coordination: {},
    copyOverrides,
    disabled: false,
    encryptionKey: Buffer.alloc(32),
    platforms: {
      facebook: {
        apiVersion: 'v25.0',
        appId: '',
        appSecret: '',
        enabled: false,
        redirectUri: '',
        scopes: [],
        systemUserAccessToken: '',
      },
      gbp: { clientId: '', clientSecret: '', enabled: false, redirectUri: '' },
      instagram: {
        apiVersion: 'v25.0',
        appId: '',
        appSecret: '',
        enabled: false,
        redirectUri: '',
        scopes: [],
        systemUserAccessToken: '',
      },
      pinterest: {
        allowedVideoHosts: [],
        clientId: '',
        clientSecret: '',
        enabled: false,
        environment: 'production',
        redirectUri: '',
        scopes: [],
        videoUploadTimeoutMs: 15000,
      },
    },
    previousEncryptionKeys: [],
    rateLimit: {
      baseRetryDelayMs: 1000,
      enabled: false,
      jitterFactor: 0,
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRetries: 0,
      maxRetryDelayMs: 1000,
      requestTimeoutMs: 5000,
    },
    scheduling: {
      connectionRefreshWindowSeconds: 86400,
      drainBatchSize: 100,
      insightsRefreshWindowSeconds: 2592000,
      queue: 'socials',
      sweepBatchSize: 100,
    },
    sources: {},
    testMode: false,
    transformations,
    webhooks: {},
  }) as NormalizedPluginOptions

const buildDefault = (_ctx: SocialSourceContext): string => 'DEFAULT'
const buildDefaultHashtags = (_ctx: SocialSourceContext): string[] => ['#default']

// ---------------------------------------------------------------------------
// resolveConfiguredText — precedence matrix
// ---------------------------------------------------------------------------

describe('resolveConfiguredText — precedence', () => {
  it('returns the default when no transforms or overrides are set', () => {
    const result = resolveConfiguredText('pinterestTitle', makeCtx(), makeOptions(), buildDefault)
    expect(result).toBe('DEFAULT')
  })

  it('uses copyOverrides when no transformations are set', () => {
    const options = makeOptions({} as SocialsTransformations, {
      pinterestTitle: () => 'OVERRIDE',
    })
    expect(resolveConfiguredText('pinterestTitle', makeCtx(), options, buildDefault)).toBe(
      'OVERRIDE',
    )
  })

  it('kind-specific string beats copyOverrides and default', () => {
    const ctx = makeCtx()
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestTitle: '{{title}} TRANSFORMED' }),
      }) as SocialsTransformations,
      { pinterestTitle: () => 'OVERRIDE' },
    )
    expect(resolveConfiguredText('pinterestTitle', ctx, options, buildDefault)).toBe(
      'Carrara Mantel TRANSFORMED',
    )
  })

  it('wildcard string beats copyOverrides when no kind-specific entry matches', () => {
    const ctx = makeCtx({ sourceKind: 'blogPost' })
    const options = makeOptions(
      Object.freeze({
        '*': Object.freeze({ pinterestTitle: 'WILDCARD' }),
      }) as SocialsTransformations,
      { pinterestTitle: () => 'OVERRIDE' },
    )
    expect(resolveConfiguredText('pinterestTitle', ctx, options, buildDefault)).toBe('WILDCARD')
  })

  it('kind-specific beats wildcard', () => {
    const ctx = makeCtx()
    const options = makeOptions(
      Object.freeze({
        '*': Object.freeze({ pinterestTitle: 'WILDCARD' }),
        product: Object.freeze({ pinterestTitle: 'KIND' }),
      }) as SocialsTransformations,
    )
    expect(resolveConfiguredText('pinterestTitle', ctx, options, buildDefault)).toBe('KIND')
  })

  it('wildcard falls through to default when only kind-specific misses', () => {
    const ctx = makeCtx({ sourceKind: 'unknown' })
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestTitle: 'KIND' }),
      }) as SocialsTransformations,
    )
    expect(resolveConfiguredText('pinterestTitle', ctx, options, buildDefault)).toBe('DEFAULT')
  })
})

// ---------------------------------------------------------------------------
// resolveConfiguredText — string form runs template engine
// ---------------------------------------------------------------------------

describe('resolveConfiguredText — template rendering', () => {
  it('renders a string template with {{ title | upper }}', () => {
    const ctx = makeCtx({ baseTitle: 'hello world' })
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestTitle: '{{ title | upper }}' }),
      }) as SocialsTransformations,
    )
    expect(resolveConfiguredText('pinterestTitle', ctx, options, buildDefault)).toBe('HELLO WORLD')
  })

  it('renders {{ description | truncate:10 }}', () => {
    const ctx = makeCtx({ baseDescription: 'Hand-finished Italian marble.' })
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestDescription: '{{ description | truncate:10 }}' }),
      }) as SocialsTransformations,
    )
    const result = resolveConfiguredText('pinterestDescription', ctx, options, buildDefault)
    expect(result.length).toBeLessThanOrEqual(10)
    expect(result.endsWith('…')).toBe(true)
  })

  it('renders a literal string without placeholders unchanged', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ gbpSummary: 'Static copy' }),
      }) as SocialsTransformations,
    )
    expect(resolveConfiguredText('gbpSummary', makeCtx(), options, buildDefault)).toBe(
      'Static copy',
    )
  })

  it('renders a missing path to empty string (safe fallback)', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ facebookMessage: '{{ nonexistent }}' }),
      }) as SocialsTransformations,
    )
    expect(resolveConfiguredText('facebookMessage', makeCtx(), options, buildDefault)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// resolveConfiguredText — function form
// ---------------------------------------------------------------------------

describe('resolveConfiguredText — function form', () => {
  it('calls the function with the SocialSourceContext', () => {
    const fn = vi.fn((_ctx: SocialSourceContext) => 'FN_RESULT')
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ instagramCaption: fn }),
      }) as unknown as SocialsTransformations,
    )
    const ctx = makeCtx()
    const result = resolveConfiguredText('instagramCaption', ctx, options, buildDefault)
    expect(result).toBe('FN_RESULT')
    expect(fn).toHaveBeenCalledWith(ctx)
  })
})

// ---------------------------------------------------------------------------
// resolveConfiguredText — all six string fields independently
// ---------------------------------------------------------------------------

describe('resolveConfiguredText — all string fields are handled', () => {
  const fields = [
    'facebookMessage',
    'gbpSummary',
    'instagramCaption',
    'pinterestAltText',
    'pinterestDescription',
    'pinterestTitle',
  ] as const

  for (const field of fields) {
    it(`routes ${field} through the kind-specific transform`, () => {
      const options = makeOptions(
        Object.freeze({
          product: Object.freeze({ [field]: `${field}_VALUE` }),
        }) as SocialsTransformations,
      )
      expect(resolveConfiguredText(field, makeCtx(), options, buildDefault)).toBe(`${field}_VALUE`)
    })
  }
})

// ---------------------------------------------------------------------------
// resolveConfiguredHashtags — precedence matrix
// ---------------------------------------------------------------------------

describe('resolveConfiguredHashtags — precedence', () => {
  it('returns the default when nothing is configured', () => {
    expect(resolveConfiguredHashtags(makeCtx(), makeOptions(), buildDefaultHashtags)).toEqual([
      '#default',
    ])
  })

  it('uses copyOverrides.pinterestHashtags when no transformations are set', () => {
    const options = makeOptions({} as SocialsTransformations, {
      pinterestHashtags: () => ['#override'],
    })
    expect(resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)).toEqual([
      '#override',
    ])
  })

  it('kind-specific string beats copyOverrides and default', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestHashtags: 'marble luxury' }),
      }) as SocialsTransformations,
      { pinterestHashtags: () => ['#override'] },
    )
    const result = resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)
    expect(result).toContain('#marble')
    expect(result).toContain('#luxury')
  })

  it('kind-specific function beats wildcard and copyOverrides', () => {
    const fn = vi.fn(() => ['#kind'])
    const options = makeOptions(
      Object.freeze({
        '*': Object.freeze({ pinterestHashtags: 'wildcard' }),
        product: Object.freeze({ pinterestHashtags: fn }),
      }) as unknown as SocialsTransformations,
    )
    const ctx = makeCtx()
    expect(resolveConfiguredHashtags(ctx, options, buildDefaultHashtags)).toEqual(['#kind'])
    expect(fn).toHaveBeenCalledWith(ctx)
  })

  it('wildcard string beats copyOverrides when no kind-specific entry', () => {
    const options = makeOptions(
      Object.freeze({
        '*': Object.freeze({ pinterestHashtags: 'global tag' }),
      }) as SocialsTransformations,
      { pinterestHashtags: () => ['#override'] },
    )
    const result = resolveConfiguredHashtags(
      makeCtx({ sourceKind: 'blogPost' }),
      options,
      buildDefaultHashtags,
    )
    expect(result).toContain('#global')
    expect(result).toContain('#tag')
  })
})

// ---------------------------------------------------------------------------
// resolveConfiguredHashtags — string form → splitHashtags
// ---------------------------------------------------------------------------

describe('resolveConfiguredHashtags — string form splits and normalizes', () => {
  it('adds # prefix to tokens that lack one', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestHashtags: 'marble luxury' }),
      }) as SocialsTransformations,
    )
    const result = resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)
    expect(result.every((t) => t.startsWith('#'))).toBe(true)
  })

  it('preserves # prefix when already present', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestHashtags: '#marble #luxury' }),
      }) as SocialsTransformations,
    )
    const result = resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)
    expect(result).toContain('#marble')
    expect(result).toContain('#luxury')
    // No double ##
    expect(result.every((t) => !t.startsWith('##'))).toBe(true)
  })

  it('splits on commas as well as spaces', () => {
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestHashtags: 'marble,luxury,art' }),
      }) as SocialsTransformations,
    )
    const result = resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)
    expect(result).toHaveLength(3)
  })

  it('renders template variables before splitting', () => {
    const ctx = makeCtx({ metadata: { googleMaterial: 'bronze' } })
    const options = makeOptions(
      Object.freeze({
        product: Object.freeze({ pinterestHashtags: '{{metadata.googleMaterial}} luxury' }),
      }) as SocialsTransformations,
    )
    const result = resolveConfiguredHashtags(ctx, options, buildDefaultHashtags)
    expect(result).toContain('#bronze')
    expect(result).toContain('#luxury')
  })
})

// ---------------------------------------------------------------------------
// Regression guard — empty transformations == legacy behaviour
// ---------------------------------------------------------------------------

describe('regression guard — empty transformations equals legacy copyOverrides behaviour', () => {
  it('pinterestTitle uses override when transformations is empty', () => {
    const options = makeOptions({} as SocialsTransformations, {
      pinterestTitle: () => 'LEGACY_TITLE',
    })
    expect(resolveConfiguredText('pinterestTitle', makeCtx(), options, buildDefault)).toBe(
      'LEGACY_TITLE',
    )
  })

  it('pinterestTitle falls through to default when both are empty', () => {
    expect(resolveConfiguredText('pinterestTitle', makeCtx(), makeOptions(), buildDefault)).toBe(
      'DEFAULT',
    )
  })

  it('pinterestHashtags uses copyOverrides when transformations is empty', () => {
    const options = makeOptions({} as SocialsTransformations, {
      pinterestHashtags: () => ['#legacy'],
    })
    expect(resolveConfiguredHashtags(makeCtx(), options, buildDefaultHashtags)).toEqual(['#legacy'])
  })

  it('pinterestHashtags falls through to default when both are empty', () => {
    expect(resolveConfiguredHashtags(makeCtx(), makeOptions(), buildDefaultHashtags)).toEqual([
      '#default',
    ])
  })
})
