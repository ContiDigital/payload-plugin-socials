import type { CollectionConfig, Config, Field, TabsField } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { buildSocialPostsCollection } from '../collections/socialPosts.js'
import { buildSocialTemplatesCollection } from '../collections/socialTemplates.js'
import { PLUGIN_SLUG, SOCIAL_POSTS_SLUG, SOCIAL_TEMPLATES_SLUG } from '../constants.js'

/**
 * Inject the plugin-owned `social-posts` collection AND, for every host
 * collection listed in `options.admin.injectInto`, append a "Socials" tab
 * that mounts the multi-platform composer.
 *
 * The tab field uses the placeholder pattern documented in CLAUDE.md §1.6:
 * the actual UI component is referenced via the `payload-plugin-socials/client`
 * package path so Payload's bundler can locate it.
 */

const SOCIALS_PLACEHOLDER_NAME = 'socialsPlaceholder'

const buildSocialsField = (sourceKind: string): Field => ({
  name: 'socials',
  type: 'ui',
  admin: {
    components: {
      Field: {
        clientProps: { sourceKind },
        exportName: 'SocialPublishPanelClient',
        path: `${PLUGIN_SLUG}/client`,
      },
    },
  },
})

const buildSocialsTab = (label: string, sourceKind: string): TabsField['tabs'][number] => ({
  fields: [buildSocialsField(sourceKind)],
  label,
})

const injectTabIntoCollection = (
  collection: CollectionConfig,
  label: string,
  sourceKind: string,
  position: 'append' | 'before-last' | number,
): void => {
  const tabsIndex = collection.fields.findIndex(
    (f): f is TabsField => 'type' in f && f.type === 'tabs',
  )

  const newTab = buildSocialsTab(label, sourceKind)

  if (tabsIndex !== -1) {
    const tabs = collection.fields[tabsIndex] as TabsField
    // Look for a placeholder tab the host may have dropped in for manual placement.
    const placeholderIndex = tabs.tabs.findIndex(
      (tab) =>
        'fields' in tab &&
        tab.fields.some((f) => 'name' in f && f.name === SOCIALS_PLACEHOLDER_NAME),
    )
    if (placeholderIndex !== -1) {
      tabs.tabs[placeholderIndex] = newTab
      return
    }
    if (position === 'before-last' && tabs.tabs.length > 0) {
      tabs.tabs.splice(tabs.tabs.length - 1, 0, newTab)
    } else if (typeof position === 'number') {
      tabs.tabs.splice(position, 0, newTab)
    } else {
      tabs.tabs.push(newTab)
    }
    return
  }

  // No existing tabs — wrap existing fields in a General tab and add Socials.
  const existingFields = [...collection.fields]
  collection.fields = [
    {
      type: 'tabs',
      tabs: [{ fields: existingFields, label: 'General' }, newTab],
    },
  ]
}

export const applyCollectionEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.collections) {
    config.collections = []
  }

  // Add the plugin-owned collections. Idempotent — re-applying the plugin
  // (HMR or multiple instances) does not duplicate the registration.
  if (!config.collections.some((c) => c.slug === SOCIAL_POSTS_SLUG)) {
    config.collections.push(buildSocialPostsCollection(options.authorize))
  }
  if (!config.collections.some((c) => c.slug === SOCIAL_TEMPLATES_SLUG)) {
    config.collections.push(buildSocialTemplatesCollection(options))
  }

  // Inject Socials tab into each host collection.
  for (const target of options.admin.injectInto) {
    const collection = config.collections.find((c) => c.slug === target.collection)
    if (!collection) {
      throw new Error(
        `${PLUGIN_SLUG}: collection "${target.collection}" not found — ` +
          'register it before applying the plugin.',
      )
    }
    if (!options.sources[target.sourceKind]) {
      throw new Error(
        `${PLUGIN_SLUG}: admin.injectInto references sourceKind "${target.sourceKind}" ` +
          'but no resolver is registered in options.sources.',
      )
    }
    injectTabIntoCollection(
      collection,
      target.label ?? 'Socials',
      target.sourceKind,
      target.tabPosition ?? 'append',
    )
  }

  return config
}

/** Manual-placement helper — host drops this field into an existing tab. */
export const SocialsUIPlaceholder: Field = {
  name: SOCIALS_PLACEHOLDER_NAME,
  type: 'ui',
  admin: {
    components: {
      Field: `${PLUGIN_SLUG}/client#SocialPublishPanelClient`,
    },
  },
}

/** Returns a ready-to-mount Socials tab for manual placement. */
export const getSocialsTab = (sourceKind: string, label = 'Socials') =>
  buildSocialsTab(label, sourceKind)

/** Returns a ready-to-mount Socials UI field for manual placement. */
export const getSocialsField = (sourceKind: string): Field => buildSocialsField(sourceKind)
