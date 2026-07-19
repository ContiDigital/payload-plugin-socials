import type { Config } from 'payload'

import { describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../../types/index.js'

import { applyAdminEnhancements } from '../applyAdminEnhancements.js'
import { normalizePluginOptions } from '../normalizeOptions.js'

const optionsWith = (admin: PayloadPluginSocialsConfig['admin'], extra: Partial<Config> = {}) => {
  const options = normalizePluginOptions({
    admin,
    authorize: () => Promise.resolve(true),
    encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    platforms: {
      pinterest: { clientId: 'c', clientSecret: 's', enabled: true, redirectUri: 'https://x/cb' },
    },
    sources: { product: () => Promise.reject(new Error('stub')) },
  } as PayloadPluginSocialsConfig)
  const config = { ...extra } as Config
  return { config, options }
}

const navLinks = (config: Config) => config.admin?.components?.beforeNavLinks ?? []
const views = (config: Config) =>
  (config.admin?.components?.views ?? {}) as Record<string, { Component: string; path: string }>

describe('applyAdminEnhancements', () => {
  it('registers the nav link and the route view in route mode', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    applyAdminEnhancements(config, options)

    const link = navLinks(config)[0] as { clientProps?: { href?: string }; exportName?: string }
    expect(link.exportName).toBe('SocialsNavLink')
    expect(link.clientProps?.href).toBe('/admin/socials')

    expect(views(config).socials).toEqual({
      Component: 'payload-plugin-socials/rsc#SocialsAdminView',
      path: '/socials',
    })
    expect(config.admin?.components?.beforeDashboard ?? []).toHaveLength(0)
  })

  it('registers only the dashboard widget in dashboard mode', () => {
    const { config, options } = optionsWith({ mode: 'dashboard' })
    applyAdminEnhancements(config, options)
    expect((config.admin?.components?.beforeDashboard ?? []).length).toBe(1)
    expect(navLinks(config)).toHaveLength(0)
    expect(views(config).socials).toBeUndefined()
  })

  it('registers everything in both mode', () => {
    const { config, options } = optionsWith({ mode: 'both' })
    applyAdminEnhancements(config, options)
    expect(navLinks(config)).toHaveLength(1)
    expect(views(config).socials).toBeDefined()
    expect((config.admin?.components?.beforeDashboard ?? []).length).toBe(1)
  })

  it('registers nothing in headless mode', () => {
    const { config, options } = optionsWith({ mode: 'headless' })
    const result = applyAdminEnhancements(config, options)
    expect(result.admin?.components?.beforeNavLinks ?? []).toHaveLength(0)
    expect(result.admin?.components?.views).toBeUndefined()
  })

  it('honors a custom route and admin base in the nav href', () => {
    const { config, options } = optionsWith({ mode: 'route', route: '/social-hub' }, {
      routes: { admin: '/cms' },
    } as Partial<Config>)
    applyAdminEnhancements(config, options)
    const link = navLinks(config)[0] as { clientProps?: { href?: string } }
    expect(link.clientProps?.href).toBe('/cms/social-hub')
    expect(views(config)['socials'].path).toBe('/social-hub')
  })

  it('does not duplicate the nav link or view when applied twice', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    applyAdminEnhancements(config, options)
    applyAdminEnhancements(config, options)
    expect(navLinks(config)).toHaveLength(1)
    expect(Object.keys(views(config))).toEqual(['socials'])
  })

  it('exposes plugin config to client components via config.custom (server path)', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    applyAdminEnhancements(config, options)
    const custom = (
      config.custom as { socials?: { apiBasePath?: string; enabledPlatforms?: string[] } }
    ).socials
    expect(custom?.apiBasePath).toBe('/socials')
    expect(custom?.enabledPlatforms).toContain('pinterest')
  })

  // Fix 1: admin.custom.socials must be populated so useConfig() in the browser
  // can read enabledPlatforms, apiBasePath, sourceKinds, and adminRoute.
  it('populates admin.custom.socials for client-side useConfig() readers', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    applyAdminEnhancements(config, options)
    const adminCustom = config.admin?.custom as
      | {
          socials?: {
            adminRoute?: string
            apiBasePath?: string
            enabledPlatforms?: string[]
            sourceKinds?: unknown[]
          }
        }
      | undefined
    expect(adminCustom?.socials?.apiBasePath).toBe('/socials')
    expect(adminCustom?.socials?.enabledPlatforms).toContain('pinterest')
    expect(adminCustom?.socials?.adminRoute).toBe('/socials')
    expect(Array.isArray(adminCustom?.socials?.sourceKinds)).toBe(true)
  })

  it('does not clobber existing admin.custom keys when adding socials', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    // Pre-populate admin.custom with a key from another plugin.
    config.admin = { custom: { anotherPlugin: { foo: 'bar' } } }
    applyAdminEnhancements(config, options)
    const adminCustom = config.admin?.custom as Record<string, unknown>
    expect(adminCustom.anotherPlugin).toEqual({ foo: 'bar' })
    expect(adminCustom.socials).toBeDefined()
  })

  // Fix 2: adminBase must be stored on options.admin so OAuth callback endpoints
  // can build the correct post-auth redirect URL.
  it('stores the resolved adminBase on options.admin', () => {
    const { config, options } = optionsWith({ mode: 'route' }, {
      routes: { admin: '/cms' },
    } as Partial<Config>)
    applyAdminEnhancements(config, options)
    expect(options.admin.adminBase).toBe('/cms')
  })

  it('defaults adminBase to /admin when config.routes.admin is absent', () => {
    const { config, options } = optionsWith({ mode: 'route' })
    applyAdminEnhancements(config, options)
    expect(options.admin.adminBase).toBe('/admin')
  })
})
