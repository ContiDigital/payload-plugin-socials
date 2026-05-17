import type { CollectionConfig, PayloadRequest } from 'payload'

import type { AuthorizeFn } from '../types/index.js'

import {
  PLATFORM_IDS,
  PLATFORM_PUBLICATION_STATUSES,
  POST_STATUSES,
  SOCIAL_POSTS_SLUG,
} from '../constants.js'

/**
 * Per-post audit + idempotency anchor.
 *
 * One row per `(sourceKind, sourceId, platform, idempotencyKey)`. The unique
 * Postgres index on `idempotencyKey` is the only true idempotency guard —
 * never drop it without a migration plan.
 *
 * Schema mirrors Fine's Gallery `pinterestPins` collection generalized to
 * N platforms. The `platform` field is the discriminator; each adapter
 * writes its `externalId` / `externalUrl` into the corresponding row.
 *
 * The plugin marks rows as `cancelled` (status), NEVER hard-deletes them —
 * the row is both the audit record AND the idempotency anchor.
 */

const buildAccessGate = (authorize: AuthorizeFn | undefined) => {
  return async ({ req }: { req: PayloadRequest }) => {
    if (!req.user) {
      return false
    }
    if (!authorize) {
      return false
    }
    const result = await authorize({ payload: req.payload, req, scope: 'admin' })
    return Boolean(result)
  }
}

export const buildSocialPostsCollection = (authorize?: AuthorizeFn): CollectionConfig => ({
  slug: SOCIAL_POSTS_SLUG,
  access: {
    create: () => false, // plugin-internal only; created via service layer
    delete: () => false,
    read: buildAccessGate(authorize),
    update: () => false,
  },
  admin: {
    defaultColumns: [
      'platform',
      'sourceKind',
      'sourceId',
      'status',
      'externalId',
      'publishedAt',
      'lastError',
    ],
    hidden: ({ user }) => !user,
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'idempotencyKey',
      type: 'text',
      admin: {
        description:
          'Stable idempotency hash. Format depends on platform but is always a hash of ' +
          '(platform, sourceKind, sourceId, destination, primary asset url).',
        readOnly: true,
      },
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'sourceHash',
      type: 'text',
      admin: {
        description: 'Content fingerprint of the outbound payload at publish time.',
        readOnly: true,
      },
      index: true,
      required: true,
    },
    {
      name: 'platform',
      type: 'select',
      dbName: 'soc_platform',
      index: true,
      options: PLATFORM_IDS.map((id) => ({ label: id, value: id })),
      required: true,
    },
    {
      name: 'sourceKind',
      type: 'text',
      admin: { readOnly: true },
      index: true,
      required: true,
    },
    {
      name: 'sourceId',
      type: 'text',
      admin: { readOnly: true },
      index: true,
      required: true,
    },
    {
      name: 'title',
      type: 'text',
      admin: { description: 'Snapshotted title at publish time.', readOnly: true },
    },
    {
      name: 'body',
      type: 'textarea',
      admin: { description: 'Snapshotted body text at publish time.', readOnly: true },
    },
    {
      name: 'altText',
      type: 'textarea',
      admin: { readOnly: true },
    },
    {
      name: 'imageUrl',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'link',
      type: 'text',
      admin: { description: 'Outbound URL embedded in the post.', readOnly: true },
    },
    {
      name: 'destination',
      type: 'group',
      admin: {
        description: 'Channel-specific destination (board id, location id, page id, etc.).',
      },
      fields: [
        { name: 'id', type: 'text' },
        { name: 'label', type: 'text' },
        { name: 'meta', type: 'json' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      dbName: 'soc_post_status',
      defaultValue: 'queued',
      index: true,
      options: POST_STATUSES.map((s) => ({ label: s, value: s })),
      required: true,
    },
    {
      name: 'platformPublicationStatus',
      type: 'select',
      dbName: 'soc_pub_status',
      options: PLATFORM_PUBLICATION_STATUSES.map((s) => ({ label: s, value: s })),
    },
    {
      name: 'externalId',
      type: 'text',
      admin: {
        description: 'Platform-side id (pin id, fb post id, ig media id, gbp localPost name).',
        readOnly: true,
      },
      index: true,
    },
    {
      name: 'externalUrl',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'publishedAt',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'lastAttemptedAt',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'attempts',
      type: 'number',
      admin: { readOnly: true },
      defaultValue: 0,
    },
    {
      name: 'lastError',
      type: 'textarea',
      admin: { readOnly: true },
    },
    // -----------------------------------------------------------------------
    // Scheduling state
    //
    // When `status` is `queued`, the publisher snapshots the full publish
    // input into `meta.queuedInput` and stamps `scheduledAt` (when the work
    // should fire) and `queuedJobId` (the Payload Jobs handle). The sweep
    // task picks these up and queues the actual publish job.
    //
    // After publish, `scheduledAt` is preserved as the audit record of WHEN
    // the post was originally scheduled, even though `status` flips to
    // `published`. NEVER clear it on success.
    // -----------------------------------------------------------------------
    {
      name: 'scheduledAt',
      type: 'date',
      admin: {
        description: 'When the post should publish. Null for immediate publishes.',
        readOnly: true,
      },
      index: true,
    },
    {
      name: 'queuedJobId',
      type: 'text',
      admin: { description: 'Payload Jobs job id (when queued).', readOnly: true },
    },
    {
      name: 'nextRetryAt',
      type: 'date',
      admin: { description: 'Next attempt time for failed posts.', readOnly: true },
      index: true,
    },
    {
      name: 'publishedBy',
      type: 'relationship',
      admin: { readOnly: true },
      relationTo: 'users',
    },
    {
      name: 'meta',
      type: 'json',
      admin: { description: 'Free-form platform-specific metadata.' },
    },
    {
      name: 'insightsSnapshot',
      type: 'json',
      admin: { description: 'Last fetched per-post analytics snapshot.', readOnly: true },
    },
    {
      name: 'insightsFetchedAt',
      type: 'date',
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
})
