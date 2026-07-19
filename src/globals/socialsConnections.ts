import type { GlobalConfig, PayloadRequest } from 'payload'

import type { AuthorizeFn } from '../types/index.js'

import { SOCIALS_CONNECTIONS_GLOBAL_SLUG } from '../constants.js'

/**
 * Per-platform connection state with encrypted credentials.
 *
 * Tokens are stored as JSON envelopes `{version, iv, ciphertext, authTag}` —
 * never plaintext. The encryption layer (`server/utilities/encryption.ts`)
 * uses AES-256-GCM with a host-supplied 32-byte key.
 *
 * Each platform has its own tab so the admin UI surfaces are clean.
 */

const buildAdminGate = (authorize?: AuthorizeFn) => {
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

const encryptedValueFields = [
  { name: 'version', type: 'number' as const, admin: { readOnly: true }, defaultValue: 1 },
  { name: 'iv', type: 'text' as const, admin: { readOnly: true } },
  { name: 'ciphertext', type: 'textarea' as const, admin: { readOnly: true } },
  { name: 'authTag', type: 'text' as const, admin: { readOnly: true } },
]

// The `scopes` array becomes its own relational table, so every platform tab
// needs its OWN dbName. A shared name collides (Drizzle cannot infer which
// relation a query targets) and breaks the host's migration on Postgres and
// sqlite alike.
const buildConnectionStateFields = (scopesDbName: string) => [
  { name: 'connected', type: 'checkbox' as const, admin: { readOnly: true }, defaultValue: false },
  { name: 'accountId', type: 'text' as const, admin: { readOnly: true } },
  { name: 'accountLabel', type: 'text' as const, admin: { readOnly: true } },
  { name: 'accessTokenExpiresAt', type: 'date' as const, admin: { readOnly: true } },
  { name: 'refreshTokenExpiresAt', type: 'date' as const, admin: { readOnly: true } },
  {
    name: 'scopes',
    type: 'array' as const,
    admin: { readOnly: true },
    dbName: scopesDbName,
    fields: [{ name: 'value', type: 'text' as const, required: true }],
  },
  { name: 'lastError', type: 'textarea' as const, admin: { readOnly: true } },
  { name: 'lastRefreshedAt', type: 'date' as const, admin: { readOnly: true } },
]

const buildPlatformTab = (label: string, name: string, scopesDbName: string) => ({
  name,
  fields: [
    {
      name: 'state',
      type: 'group' as const,
      fields: buildConnectionStateFields(scopesDbName),
    },
    {
      name: 'accessToken',
      type: 'group' as const,
      admin: {
        description: 'Encrypted at rest with AES-256-GCM. Never displayed in plaintext.',
      },
      fields: encryptedValueFields,
    },
    {
      name: 'refreshToken',
      type: 'group' as const,
      admin: {
        description: 'Encrypted at rest with AES-256-GCM. Never displayed in plaintext.',
      },
      fields: encryptedValueFields,
    },
    {
      name: 'extra',
      type: 'json' as const,
      admin: {
        description: 'Plugin-managed per-platform metadata (account id, page id, etc.).',
        readOnly: true,
      },
    },
  ],
  label,
})

export const buildSocialsConnectionsGlobal = (authorize?: AuthorizeFn): GlobalConfig => ({
  slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG,
  access: {
    read: buildAdminGate(authorize),
    update: () => false,
  },
  admin: {
    // Hidden from the admin nav and document view entirely. This global is
    // internal AES-256-GCM token storage; hand-editing the encrypted envelopes
    // corrupts the tokens. Operators manage connections from the Connections
    // tab in the plugin admin view, never by editing this global directly.
    hidden: true,
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        buildPlatformTab('Pinterest', 'pinterest', 'soc_conn_pin_scopes'),
        buildPlatformTab('Instagram', 'instagram', 'soc_conn_ig_scopes'),
        buildPlatformTab('Facebook', 'facebook', 'soc_conn_fb_scopes'),
        buildPlatformTab('Google Business Profile', 'gbp', 'soc_conn_gbp_scopes'),
      ],
    },
    {
      name: 'lastBoardsRefreshAt',
      type: 'date',
      admin: { hidden: true, readOnly: true },
    },
  ],
})
