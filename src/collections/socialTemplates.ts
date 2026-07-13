import type { CollectionConfig, PayloadRequest } from 'payload'

import type { AuthorizeFn } from '../types/index.js'

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

export const buildSocialTemplatesCollection = (authorize?: AuthorizeFn): CollectionConfig => {
  const gate = buildGate(authorize)
  return {
    slug: SOCIAL_TEMPLATES_SLUG,
    access: {
      create: gate,
      delete: gate,
      read: gate,
      update: gate,
    },
    admin: {
      defaultColumns: ['name', 'enabled', 'description'],
      description:
        'Reusable post templates. Placeholders are filled per source record at compose time.',
      group: 'Socials',
      hidden: ({ user }) => !user,
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
    timestamps: true,
  }
}
