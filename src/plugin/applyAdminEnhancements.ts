import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { PLUGIN_SLUG } from '../constants.js'

type AdminComponents = NonNullable<Config['admin']>['components']

type NavComponent = NonNullable<NonNullable<AdminComponents>['beforeNavLinks']>[number]

const SOCIALS_VIEW_KEY = 'socials'

/**
 * Idempotent dedup helper. Re-applying the plugin (HMR, multiple instances)
 * must not stack the same nav link / dashboard widget multiple times.
 */
const withUniqueComponent = <T>(components: T[] | undefined, component: T): T[] => {
  const next = [...(components ?? [])]
  const exists = next.some((candidate) => {
    if (candidate === false || component === false) {
      return false
    }
    if (typeof candidate === 'string' || typeof component === 'string') {
      return candidate === component
    }
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof component === 'object' &&
      component !== null &&
      'path' in candidate &&
      'path' in component
    ) {
      return (
        (candidate as Record<string, unknown>).path ===
          (component as Record<string, unknown>).path &&
        (candidate as Record<string, unknown>).exportName ===
          (component as Record<string, unknown>).exportName
      )
    }
    return false
  })
  if (!exists) {
    next.push(component)
  }
  return next
}

export const applyAdminEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (options.admin.mode === 'headless') {
    return config
  }

  if (!config.admin) {
    config.admin = {}
  }
  if (!config.admin.components) {
    config.admin.components = {}
  }
  const components = config.admin.components

  // Expose plugin-config bits that client components need (basePath, route).
  if (!config.custom) {
    config.custom = {}
  }
  const custom = config.custom as Record<string, unknown>
  custom.socials = {
    adminRoute: options.admin.route,
    apiBasePath: options.api.basePath,
    enabledPlatforms: Object.entries(options.platforms)
      .filter(([, p]) => p.enabled)
      .map(([id]) => id),
  }

  if (options.admin.mode === 'route' || options.admin.mode === 'both') {
    // The view `path` is relative to the admin base, so the nav link href must
    // include that base. Default to '/admin' but respect a host override.
    const adminBase = (
      (config.routes as { admin?: string } | undefined)?.admin ?? '/admin'
    ).replace(/\/+$/, '')
    const navLink: NavComponent = {
      clientProps: { href: `${adminBase}${options.admin.route}`, label: options.admin.navLabel },
      exportName: 'SocialsNavLink',
      path: `${PLUGIN_SLUG}/client`,
    } as NavComponent
    components.beforeNavLinks = withUniqueComponent(components.beforeNavLinks, navLink)

    // Register the route view so the nav link actually renders something. A
    // host that already defined a `socials` view keeps theirs.
    if (!components.views) {
      components.views = {}
    }
    const views = components.views as Record<string, unknown>
    if (!views[SOCIALS_VIEW_KEY]) {
      views[SOCIALS_VIEW_KEY] = {
        Component: `${PLUGIN_SLUG}/rsc#SocialsAdminView`,
        path: options.admin.route,
      }
    }
  }

  if (options.admin.mode === 'dashboard' || options.admin.mode === 'both') {
    const widget = {
      exportName: 'SocialsDashboardWidget',
      path: `${PLUGIN_SLUG}/client`,
    }
    components.beforeDashboard = withUniqueComponent(components.beforeDashboard, widget as never)
  }

  return config
}
