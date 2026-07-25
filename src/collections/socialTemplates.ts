import type { CollectionBeforeChangeHook, CollectionConfig, PayloadRequest, Where } from 'payload'

import type { AuthorizeFn, NormalizedPluginOptions } from '../types/index.js'

import { PLATFORM_IDS, PLUGIN_SLUG, SOCIAL_TEMPLATES_SLUG } from '../constants.js'

/**
 * Plugin-owned `social-templates` collection.
 *
 * Reusable post templates authored by staff. Each copy field mounts a
 * `SocialTemplateFieldBuilder` custom field component that provides a
 * structured token picker, filter menu, and debounced live preview against a
 * chosen record. The raw template string (`{{ path | filter }}`) is the stored
 * value; the builder is a structured editor over that string, with a
 * raw-string toggle as an escape hatch.
 *
 * Field types are unchanged (text / textarea) so no migration is required.
 */

/**
 * Context key that short-circuits the single-default enforcement hook so the
 * cascade update it issues (unsetting `isDefault` on sibling templates) never
 * re-enters itself.
 */
export const SKIP_SINGLE_DEFAULT_CONTEXT_KEY = 'socials:skip-single-default'

/**
 * Build the `sourceKind` select options from the registered source kinds. The
 * label prefers the `admin.injectInto` label for that kind (so operators see
 * "Products" rather than the raw kind slug) and falls back to the kind itself.
 */
export const buildSourceKindOptions = (
  sourceKinds: readonly string[],
  injectInto: NormalizedPluginOptions['admin']['injectInto'],
): Array<{ label: string; value: string }> => {
  const labelByKind = new Map<string, string>()
  for (const entry of injectInto) {
    if (entry.label) {
      labelByKind.set(entry.sourceKind, entry.label)
    }
  }
  return sourceKinds.map((kind) => ({ label: labelByKind.get(kind) ?? kind, value: kind }))
}

/**
 * `beforeChange` hook that keeps at most one default template per source kind.
 * When a row is saved with `isDefault: true`, every other enabled/disabled row
 * of the same `sourceKind` has its `isDefault` cleared. The cascade update runs
 * with `overrideAccess` and a context flag so it never triggers this hook again.
 */
export const buildSingleDefaultHook = (): CollectionBeforeChangeHook => {
  return async ({ context, data, originalDoc, req }) => {
    if (data?.isDefault !== true) {
      return data
    }
    if (context?.[SKIP_SINGLE_DEFAULT_CONTEXT_KEY]) {
      return data
    }
    const sourceKind =
      typeof data.sourceKind === 'string' && data.sourceKind
        ? data.sourceKind
        : (originalDoc?.sourceKind as string | undefined)
    if (!sourceKind) {
      return data
    }
    const filters: Where[] = [
      { sourceKind: { equals: sourceKind } },
      { isDefault: { equals: true } },
    ]
    const currentId = originalDoc?.id as number | string | undefined
    if (currentId !== undefined && currentId !== null) {
      filters.push({ id: { not_equals: currentId } })
    }
    await req.payload.update({
      collection: SOCIAL_TEMPLATES_SLUG as never,
      context: { [SKIP_SINGLE_DEFAULT_CONTEXT_KEY]: true },
      data: { isDefault: false } as never,
      overrideAccess: true,
      req,
      where: { and: filters },
    })
    return data
  }
}

const buildGate = (authorize: AuthorizeFn | undefined) => {
  return async ({ req }: { req: PayloadRequest }) => {
    if (!req.user) {
      return false
    }
    if (!authorize) {
      return false
    }
    return Boolean(await authorize({ payload: req.payload, req, scope: 'admin' }))
  }
}

const builderField = (
  copyField: string,
  multiline: boolean,
): {
  components: {
    Field: {
      clientProps: { copyField: string; multiline: boolean }
      exportName: string
      path: string
    }
  }
  description: string
} => ({
  components: {
    Field: {
      clientProps: { copyField, multiline },
      exportName: 'SocialTemplateFieldBuilder',
      path: `${PLUGIN_SLUG}/client`,
    },
  },
  description: `Template for "${copyField}". Use the builder to pick tokens from the resolved scope and apply filters. Tokens must be mapped by the host's SourceContextResolver to produce output — fields not exposed via the resolver's metadata map will render as empty.`,
})

export const buildSocialTemplatesCollection = (
  options: NormalizedPluginOptions,
  schemaOnly = false,
): CollectionConfig => {
  const gate = buildGate(options.authorize)
  const sourceKinds = Object.keys(options.sources)
  const sourceKindOptions = buildSourceKindOptions(sourceKinds, options.admin.injectInto)
  return {
    slug: SOCIAL_TEMPLATES_SLUG,
    access: {
      create: schemaOnly ? () => false : gate,
      delete: schemaOnly ? () => false : gate,
      read: schemaOnly ? () => false : gate,
      update: schemaOnly ? () => false : gate,
    },
    admin: {
      defaultColumns: ['name', 'sourceKind', 'isDefault', 'enabled'],
      description:
        'Reusable post templates. Each template is bound to a collection (source kind) and its placeholders are filled per source record at compose time.',
      group: 'Socials',
      hidden: schemaOnly ? true : ({ user }) => !user,
      useAsTitle: 'name',
    },
    fields: [
      {
        name: 'name',
        type: 'text',
        index: true,
        required: true,
        unique: true,
      },
      {
        name: 'sourceKind',
        type: 'select',
        admin: {
          description:
            'The collection (source kind) this template is built from. The builder offers that collection’s fields, and the composer only shows this template when publishing from that collection.',
        },
        dbName: 'tmpl_source_kind',
        // Required going forward. Existing rows default to the first registered
        // kind so they validate on next save; review and reassign them.
        defaultValue: sourceKinds[0],
        index: true,
        options: sourceKindOptions,
        required: true,
      },
      {
        name: 'isDefault',
        type: 'checkbox',
        admin: {
          description:
            'Default for this collection. When set, the composer auto-applies this template for its source kind (still honoring the platform filter below). Only one template per source kind can be the default.',
        },
        defaultValue: false,
        index: true,
      },
      {
        name: 'description',
        type: 'textarea',
        admin: { description: 'Internal note describing when to use this template.' },
      },
      {
        name: 'enabled',
        type: 'checkbox',
        defaultValue: true,
      },
      {
        name: 'appliesTo',
        type: 'select',
        admin: { description: 'Platforms this template is intended for (informational).' },
        hasMany: true,
        options: PLATFORM_IDS.map((id) => ({ label: id, value: id })),
      },
      {
        name: 'templates',
        type: 'group',
        fields: [
          {
            name: 'pinterestTitle',
            type: 'text',
            admin: builderField('pinterestTitle', false),
          },
          {
            name: 'pinterestDescription',
            type: 'textarea',
            admin: builderField('pinterestDescription', true),
          },
          {
            name: 'pinterestAltText',
            type: 'textarea',
            admin: builderField('pinterestAltText', true),
          },
          {
            name: 'pinterestHashtags',
            type: 'text',
            admin: {
              ...builderField('pinterestHashtags', false),
              description:
                'Space or comma separated tags; a leading # is added automatically. Use the builder to construct the template.',
            },
          },
          {
            name: 'instagramCaption',
            type: 'textarea',
            admin: builderField('instagramCaption', true),
          },
          {
            name: 'facebookMessage',
            type: 'textarea',
            admin: builderField('facebookMessage', true),
          },
          {
            name: 'gbpSummary',
            type: 'textarea',
            admin: builderField('gbpSummary', true),
          },
        ],
      },
    ],
    hooks: schemaOnly ? undefined : { beforeChange: [buildSingleDefaultHook()] },
    timestamps: true,
  }
}
