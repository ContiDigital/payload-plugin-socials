import type { CollectionConfig, PayloadRequest } from 'payload'

import type { AuthorizeFn } from '../types/index.js'

import { PLATFORM_IDS, SOCIAL_TEMPLATES_SLUG } from '../constants.js'

/**
 * Plugin-owned `social-templates` collection.
 *
 * Reusable post templates authored by staff. Each field holds a template
 * string with `{{ variable }}` placeholders that the composer fills per source
 * record at compose time (see `server/templates/resolveTemplateCopy.ts`).
 *
 * Unlike `social-posts` (plugin-internal, read-only in the admin), templates
 * are staff-authored content, so all CRUD is gated by the host `authorize`
 * function rather than locked to the service layer. Payload renders the
 * collection's edit UI automatically, so template authoring needs no custom
 * admin component.
 */

const TEMPLATE_HELP =
  'Use {{ variable }} placeholders. Available: {{title}}, {{description}}, {{material}}, ' +
  '{{color}}, {{category}}, {{dimensions}}, {{link}}, {{modelLabel}}, and {{metadata.<field>}}. ' +
  'Filters: | upper, | lower, | trim, | truncate:N, | default:text.'

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
          { name: 'pinterestTitle', type: 'text', admin: { description: TEMPLATE_HELP } },
          {
            name: 'pinterestDescription',
            type: 'textarea',
            admin: { description: TEMPLATE_HELP },
          },
          { name: 'pinterestAltText', type: 'textarea', admin: { description: TEMPLATE_HELP } },
          {
            name: 'pinterestHashtags',
            type: 'text',
            admin: {
              description:
                'Space or comma separated tags; a leading # is added automatically. ' +
                TEMPLATE_HELP,
            },
          },
          { name: 'instagramCaption', type: 'textarea', admin: { description: TEMPLATE_HELP } },
          { name: 'facebookMessage', type: 'textarea', admin: { description: TEMPLATE_HELP } },
          { name: 'gbpSummary', type: 'textarea', admin: { description: TEMPLATE_HELP } },
        ],
      },
    ],
    timestamps: true,
  }
}
