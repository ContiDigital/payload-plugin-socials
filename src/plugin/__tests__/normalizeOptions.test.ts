import { describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../../types/index.js'

import { normalizePluginOptions } from '../normalizeOptions.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const base = (): PayloadPluginSocialsConfig => ({
  authorize: () => Promise.resolve(true),
  encryptionKey: HEX_KEY,
  platforms: { pinterest: { enabled: false } },
  sources: { product: () => Promise.reject(new Error('stub')) },
})

const withOpts = (
  overrides: Partial<PayloadPluginSocialsConfig> = {},
): PayloadPluginSocialsConfig => ({ ...base(), ...overrides }) as PayloadPluginSocialsConfig

describe('normalizePluginOptions — required-field validation', () => {
  it('throws when authorize is not a function', () => {
    expect(() => normalizePluginOptions(withOpts({ authorize: undefined }))).toThrow(/authorize/)
  })

  it('throws when sources is empty or missing', () => {
    expect(() => normalizePluginOptions(withOpts({ sources: {} }))).toThrow(/sources/)
    expect(() => normalizePluginOptions(withOpts({ sources: undefined }))).toThrow(/sources/)
  })

  it('throws when platforms declares no entries', () => {
    expect(() => normalizePluginOptions(withOpts({ platforms: {} }))).toThrow(/platforms/)
  })

  it('throws when encryptionKey is missing', () => {
    expect(() => normalizePluginOptions(withOpts({ encryptionKey: undefined }))).toThrow(
      /encryptionKey/,
    )
  })

  it('throws when encryptionKey has the wrong shape', () => {
    expect(() => normalizePluginOptions(withOpts({ encryptionKey: 'too-short' }))).toThrow()
  })
})

describe('normalizePluginOptions — disabled bypass', () => {
  it('returns a valid stub without any credentials', () => {
    const result = normalizePluginOptions({ disabled: true } as PayloadPluginSocialsConfig)
    expect(result.disabled).toBe(true)
    expect(Buffer.isBuffer(result.encryptionKey)).toBe(true)
    expect(result.encryptionKey).toHaveLength(32)
  })
})

describe('normalizePluginOptions — defaults', () => {
  const n = normalizePluginOptions(base())

  it('resolves admin defaults', () => {
    expect(n.admin.mode).toBe('route')
    expect(n.admin.navLabel).toBe('Socials')
    expect(n.admin.route).toBe('/socials')
    expect(n.admin.injectInto).toEqual([])
  })

  it('resolves the api base path', () => {
    expect(n.api.basePath).toBe('/socials')
  })

  it('resolves rate-limit defaults', () => {
    expect(n.rateLimit).toMatchObject({
      enabled: true,
      jitterFactor: 0.25,
      maxConcurrency: 4,
      maxRequestsPerMinute: 60,
      maxRetries: 5,
      requestTimeoutMs: 20_000,
    })
  })

  it('resolves scheduling defaults with no autoRun unless a cron is set', () => {
    expect(n.scheduling.sweepBatchSize).toBe(100)
    expect(n.scheduling.drainBatchSize).toBe(100)
    expect(n.scheduling.connectionRefreshWindowSeconds).toBe(86_400)
    expect(n.scheduling.insightsRefreshWindowSeconds).toBe(30 * 86_400)
    expect(n.scheduling.autoRun).toBeUndefined()
  })

  it('coerces the encryption key to a 32-byte Buffer and defaults testMode to false', () => {
    expect(n.encryptionKey).toHaveLength(32)
    expect(n.testMode).toBe(false)
    expect(n.disabled).toBe(false)
  })

  it('normalizes an empty auth collection to undefined', () => {
    expect(
      normalizePluginOptions(withOpts({ authCollection: '  ' })).authCollection,
    ).toBeUndefined()
  })

  it('resolves assets defaults', () => {
    expect(n.assets).toEqual({
      autoConvert: false,
      jpegQuality: 82,
      preflight: true,
      remoteFetchTimeoutMs: 15_000,
      renditionCollection: undefined,
      trustedRemoteHosts: [],
    })
  })
})

describe('normalizePluginOptions — primitive normalizers', () => {
  it('forces a leading slash on admin.route and api.basePath', () => {
    // The public type already constrains these to `/${string}`, so this
    // exercises the defensive runtime branch for untyped (JS) callers.
    const opts = {
      ...base(),
      admin: { route: 'dashboard' },
      api: { basePath: 'social' },
    } as unknown as PayloadPluginSocialsConfig
    const n = normalizePluginOptions(opts)
    expect(n.admin.route).toBe('/dashboard')
    expect(n.api.basePath).toBe('/social')
  })

  it('falls back to route mode for an invalid admin mode and passes valid modes through', () => {
    expect(
      normalizePluginOptions(withOpts({ admin: { mode: 'nonsense' as never } })).admin.mode,
    ).toBe('route')
    expect(normalizePluginOptions(withOpts({ admin: { mode: 'dashboard' } })).admin.mode).toBe(
      'dashboard',
    )
  })

  it('floors and clamps rate-limit integers and the jitter fraction', () => {
    const n = normalizePluginOptions(
      withOpts({
        rateLimit: { jitterFactor: 5, maxConcurrency: 3.9, maxRetries: -2 },
      }),
    )
    expect(n.rateLimit.maxConcurrency).toBe(3)
    expect(n.rateLimit.maxRetries).toBe(0)
    expect(n.rateLimit.jitterFactor).toBe(1)
  })

  it('registers an autoRun entry only when a cron is supplied, defaulting the queue', () => {
    const n = normalizePluginOptions(withOpts({ scheduling: { autoRun: { cron: '7 * * * *' } } }))
    expect(n.scheduling.autoRun).toMatchObject({ cron: '7 * * * *', queue: 'socials' })
  })

  it('honours testMode', () => {
    expect(normalizePluginOptions(withOpts({ testMode: true })).testMode).toBe(true)
  })
})

describe('normalizePluginOptions — assets config', () => {
  it('defaults preflight to true and autoConvert to false', () => {
    const n = normalizePluginOptions(withOpts({ assets: {} }))
    expect(n.assets.preflight).toBe(true)
    expect(n.assets.autoConvert).toBe(false)
    expect(n.assets.jpegQuality).toBe(82)
  })

  it('allows disabling preflight', () => {
    const n = normalizePluginOptions(withOpts({ assets: { preflight: false } }))
    expect(n.assets.preflight).toBe(false)
  })

  it('throws when autoConvert is true without renditionCollection', () => {
    expect(() => normalizePluginOptions(withOpts({ assets: { autoConvert: true } }))).toThrow(
      /renditionCollection/,
    )
  })

  it('accepts autoConvert with renditionCollection', () => {
    const n = normalizePluginOptions(
      withOpts({ assets: { autoConvert: true, renditionCollection: 'media' } }),
    )
    expect(n.assets.autoConvert).toBe(true)
    expect(n.assets.renditionCollection).toBe('media')
  })

  it('clamps jpegQuality to 1-100', () => {
    const low = normalizePluginOptions(withOpts({ assets: { jpegQuality: 0 } }))
    expect(low.assets.jpegQuality).toBe(1)

    const high = normalizePluginOptions(withOpts({ assets: { jpegQuality: 200 } }))
    expect(high.assets.jpegQuality).toBe(100)

    const normal = normalizePluginOptions(withOpts({ assets: { jpegQuality: 75 } }))
    expect(normal.assets.jpegQuality).toBe(75)
  })

  it('normalizes the remote fetch timeout and trusted hostnames', () => {
    const n = normalizePluginOptions(
      withOpts({
        assets: {
          remoteFetchTimeoutMs: 2_500.9,
          trustedRemoteHosts: [' MEDIA.EXAMPLE.COM ', 'media.example.com'],
        },
      }),
    )
    expect(n.assets.remoteFetchTimeoutMs).toBe(2_500)
    expect(n.assets.trustedRemoteHosts).toEqual(['media.example.com'])
  })

  it('rejects trusted remote hosts containing a scheme, port, or localhost', () => {
    for (const host of ['https://media.example.com', 'media.example.com:8443', 'localhost']) {
      expect(() =>
        normalizePluginOptions(withOpts({ assets: { trustedRemoteHosts: [host] } })),
      ).toThrow(/exact DNS hostnames/)
    }
  })
})

describe('normalizePluginOptions — platform credential validation', () => {
  it('throws when Pinterest is enabled without credentials', () => {
    expect(() =>
      normalizePluginOptions(withOpts({ platforms: { pinterest: { enabled: true } } })),
    ).toThrow(/pinterest/)
  })

  it('normalizes an enabled Pinterest config with defaults', () => {
    const n = normalizePluginOptions(
      withOpts({
        platforms: {
          pinterest: {
            clientId: 'cid',
            clientSecret: 'secret',
            enabled: true,
            redirectUri: 'https://app.example.com/cb',
          },
        },
      }),
    )
    expect(n.platforms.pinterest.enabled).toBe(true)
    expect(n.platforms.pinterest.environment).toBe('production')
    expect(n.platforms.pinterest.scopes).toContain('pins:write')
  })

  it('respects the Pinterest sandbox environment and custom scopes', () => {
    const n = normalizePluginOptions(
      withOpts({
        platforms: {
          pinterest: {
            clientId: 'cid',
            clientSecret: 'secret',
            enabled: true,
            environment: 'sandbox',
            redirectUri: 'https://app.example.com/cb',
            scopes: ['pins:read'],
          },
        },
      }),
    )
    expect(n.platforms.pinterest.environment).toBe('sandbox')
    expect(n.platforms.pinterest.scopes).toEqual(['pins:read'])
    expect(Object.isFrozen(n.platforms.pinterest.scopes)).toBe(true)
  })

  it('throws when Instagram is enabled without either OAuth creds or a system token', () => {
    expect(() =>
      normalizePluginOptions(withOpts({ platforms: { instagram: { enabled: true } } })),
    ).toThrow(/instagram/)
  })

  it('accepts an Instagram system-user token and defaults the api version', () => {
    const n = normalizePluginOptions(
      withOpts({
        platforms: { instagram: { enabled: true, systemUserAccessToken: 'EAA-token' } },
      }),
    )
    expect(n.platforms.instagram.enabled).toBe(true)
    expect(n.platforms.instagram.apiVersion).toBe('v25.0')
  })

  it('rejects a malformed Meta API version', () => {
    expect(() =>
      normalizePluginOptions(
        withOpts({
          platforms: {
            instagram: {
              apiVersion: 'latest',
              enabled: true,
              systemUserAccessToken: 'EAA-token',
            },
          },
        }),
      ),
    ).toThrow(/apiVersion/)
  })

  it('throws when Facebook is enabled without credentials', () => {
    expect(() =>
      normalizePluginOptions(withOpts({ platforms: { facebook: { enabled: true } } })),
    ).toThrow(/facebook/)
  })

  it('accepts a GBP service-account config', () => {
    const n = normalizePluginOptions(
      withOpts({
        platforms: {
          gbp: {
            enabled: true,
            serviceAccount: { clientEmail: 'svc@project.iam', privateKey: 'KEY' },
          },
        },
      }),
    )
    expect(n.platforms.gbp.enabled).toBe(true)
    expect(n.platforms.gbp.serviceAccount?.clientEmail).toBe('svc@project.iam')
  })

  it('throws when GBP is enabled without OAuth creds or a service account', () => {
    expect(() =>
      normalizePluginOptions(withOpts({ platforms: { gbp: { enabled: true } } })),
    ).toThrow(/gbp/)
  })
})
