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

  // Resolve the Payload admin base path from config.routes.admin (default '/admin').
  // Stored on options.admin so that endpoint factories (e.g. oauthEndpointFactory)
  // can build the correct post-auth redirect URL without needing the Payload Config.
  const adminBase = ((config.routes as { admin?: string } | undefined)?.admin ?? '/admin').replace(
    /\/+$/,
    '',
  )
  options.admin.adminBase = adminBase

  // Expose plugin-config bits that client components need (basePath, route,
  // sourceKinds for the template builder's record-search picker).
  //
  // Payload 3.86+ strips root config.custom from the client-side config
  // (listed in serverOnlyConfigProperties). We therefore write the socials
  // object to BOTH paths:
  //   - config.custom.socials          → server-side readers (SocialsAdminView,
  //                                      req.payload.config.custom)
  //   - config.admin.custom.socials    → client-side readers via useConfig()
  //                                      (the admin.custom object IS serialized)
  const socialsCustom = {
    adminRoute: options.admin.route,
    apiBasePath: options.api.basePath,
    enabledPlatforms: Object.entries(options.platforms)
      .filter(([, p]) => p.enabled)
      .map(([id]) => id),
    // Expose the registered source kinds so the template builder can
    // populate the record-picker dropdown without enumerating collections.
    sourceKinds: options.admin.injectInto.map(({ collection, label, sourceKind }) => ({
      collection,
      kind: sourceKind,
      label: label ?? collection,
    })),
  }

  // Server-side path (kept for SocialsAdminView and server hooks). Includes
  // the host `authorize` function so the RSC view can gate itself before
  // rendering. This is server-only — config.custom is NOT serialized to the
  // browser (Payload strips it via serverOnlyConfigProperties), so the function
  // reference never leaks client-side.
  if (!config.custom) {
    config.custom = {}
  }
  ;(config.custom as Record<string, unknown>).socials = {
    ...socialsCustom,
    authorize: options.authorize,
  }

  // Client-side path: config.admin.custom IS serialized to the browser.
  // Spread any existing keys so we do not clobber other plugins' entries.
  config.admin.custom = {
    ...(config.admin.custom as Record<string, unknown> | undefined),
    socials: socialsCustom,
  }

  if (options.admin.mode === 'route' || options.admin.mode === 'both') {
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
