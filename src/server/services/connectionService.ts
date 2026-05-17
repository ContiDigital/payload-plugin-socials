import type { Payload } from 'payload'

import type { EncryptedValue, NormalizedPluginOptions, PlatformId } from '../../types/index.js'

import { SOCIALS_CONNECTIONS_GLOBAL_SLUG } from '../../constants.js'
import { decryptStringWithKeyring, encryptString } from '../utilities/encryption.js'
import { createPluginLogger, redactSecretString } from '../utilities/logger.js'

/**
 * Reads + writes encrypted credentials on the `socials-connections` global.
 *
 * The plugin NEVER stores plaintext tokens. Callers see the decrypted values
 * via `getCredentials(payload, platform)` and pass the same shape back via
 * `saveCredentials(payload, platform, ...)`.
 *
 * The encryption layer wraps the actual ciphertext + IV + auth tag in a
 * versioned envelope — see `server/utilities/encryption.ts`.
 */

const isEmptyEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return true
  }
  const envelope = value as Partial<EncryptedValue>
  return (
    !envelope.ciphertext ||
    !envelope.iv ||
    !envelope.authTag ||
    typeof envelope.version !== 'number'
  )
}

export type ConnectionCredentials = {
  accessToken?: string
  accessTokenExpiresAt?: string
  accountId?: string
  accountLabel?: string
  extra?: Record<string, unknown>
  refreshToken?: string
  refreshTokenExpiresAt?: string
  scopes?: string[]
}

type ConnectionStateRecord = {
  accessTokenExpiresAt?: string
  accountId?: string
  accountLabel?: string
  connected: boolean
  lastError?: string
  lastRefreshedAt?: string
  refreshTokenExpiresAt?: string
  scopes?: Array<{ value: string }>
}

type PlatformConnectionRecord = {
  accessToken?: EncryptedValue | Record<string, never>
  extra?: Record<string, unknown>
  refreshToken?: EncryptedValue | Record<string, never>
  state?: ConnectionStateRecord
}

type ConnectionsGlobal = Partial<Record<PlatformId, PlatformConnectionRecord>>

const readGlobal = async (payload: Payload): Promise<ConnectionsGlobal> => {
  const doc = (await payload.findGlobal({
    slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as ConnectionsGlobal | null
  return doc ?? {}
}

export const getCredentials = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: PlatformId,
): Promise<ConnectionCredentials | null> => {
  const doc = await readGlobal(payload)
  const record = doc[platform]
  if (!record) {
    return null
  }

  const accessResult = !isEmptyEnvelope(record.accessToken)
    ? decryptStringWithKeyring(
        record.accessToken as EncryptedValue,
        options.encryptionKey,
        options.previousEncryptionKeys ?? [],
      )
    : undefined
  const refreshResult = !isEmptyEnvelope(record.refreshToken)
    ? decryptStringWithKeyring(
        record.refreshToken as EncryptedValue,
        options.encryptionKey,
        options.previousEncryptionKeys ?? [],
      )
    : undefined
  const accessToken = accessResult?.plaintext
  const refreshToken = refreshResult?.plaintext

  if (!accessToken && !refreshToken) {
    return null
  }

  if ((accessResult?.keyIndex ?? 0) > 0 || (refreshResult?.keyIndex ?? 0) > 0) {
    await payload.updateGlobal({
      slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG as never,
      data: {
        [platform]: {
          ...record,
          accessToken:
            accessResult && accessResult.keyIndex > 0
              ? encryptString(accessResult.plaintext, options.encryptionKey)
              : record.accessToken,
          refreshToken:
            refreshResult && refreshResult.keyIndex > 0
              ? encryptString(refreshResult.plaintext, options.encryptionKey)
              : record.refreshToken,
        },
      } as never,
      overrideAccess: true,
    })
  }

  return {
    accessToken,
    accessTokenExpiresAt: record.state?.accessTokenExpiresAt,
    accountId: record.state?.accountId,
    accountLabel: record.state?.accountLabel,
    extra: record.extra,
    refreshToken,
    refreshTokenExpiresAt: record.state?.refreshTokenExpiresAt,
    scopes: record.state?.scopes?.map((s) => s.value).filter(Boolean),
  }
}

export type SaveCredentialsArgs = {
  accessToken?: string
  accessTokenExpiresAt?: string
  accountId?: string
  accountLabel?: string
  extra?: Record<string, unknown>
  refreshToken?: string
  refreshTokenExpiresAt?: string
  scopes?: readonly string[]
  /** Set false on a token-only refresh — keeps prior account metadata intact. */
  updateAccount?: boolean
}

export const saveCredentials = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: PlatformId,
  args: SaveCredentialsArgs,
): Promise<void> => {
  const log = createPluginLogger(payload.logger, { op: 'saveCredentials', platform })
  const existing = await readGlobal(payload)
  const prior = existing[platform] ?? {}

  const nextRecord: PlatformConnectionRecord = {
    accessToken: prior.accessToken,
    extra: { ...(prior.extra ?? {}), ...(args.extra ?? {}) },
    refreshToken: prior.refreshToken,
    state: {
      ...(prior.state ?? { connected: false }),
      connected: true,
      lastError: undefined,
      lastRefreshedAt: new Date().toISOString(),
    },
  }

  if (args.accessToken !== undefined) {
    nextRecord.accessToken = encryptString(args.accessToken, options.encryptionKey)
  }
  if (args.refreshToken !== undefined) {
    nextRecord.refreshToken = encryptString(args.refreshToken, options.encryptionKey)
  }
  if (args.accessTokenExpiresAt !== undefined) {
    nextRecord.state!.accessTokenExpiresAt = args.accessTokenExpiresAt
  }
  if (args.refreshTokenExpiresAt !== undefined) {
    nextRecord.state!.refreshTokenExpiresAt = args.refreshTokenExpiresAt
  }
  if (args.scopes) {
    nextRecord.state!.scopes = args.scopes.map((value) => ({ value }))
  }
  if (args.updateAccount !== false) {
    if (args.accountId !== undefined) {
      nextRecord.state!.accountId = args.accountId
    }
    if (args.accountLabel !== undefined) {
      nextRecord.state!.accountLabel = args.accountLabel
    }
  }

  await payload.updateGlobal({
    slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG as never,
    data: { [platform]: nextRecord } as never,
    overrideAccess: true,
  })

  log.info('Credentials persisted')
}

export const recordConnectionError = async (
  payload: Payload,
  platform: PlatformId,
  error: unknown,
): Promise<void> => {
  try {
    const existing = await readGlobal(payload)
    const prior = existing[platform] ?? {}
    const message = redactSecretString(error instanceof Error ? error.message : String(error))
    await payload.updateGlobal({
      slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG as never,
      data: {
        [platform]: {
          ...prior,
          state: { ...(prior.state ?? { connected: false }), lastError: message },
        },
      } as never,
      overrideAccess: true,
    })
  } catch {
    // Cleanup-only path — never let logging failure mask the operation error.
  }
}

export const disconnectPlatform = async (payload: Payload, platform: PlatformId): Promise<void> => {
  await payload.updateGlobal({
    slug: SOCIALS_CONNECTIONS_GLOBAL_SLUG as never,
    data: {
      [platform]: {
        accessToken: {},
        extra: {},
        refreshToken: {},
        state: { connected: false },
      },
    } as never,
    overrideAccess: true,
  })
}
