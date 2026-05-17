import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { coerceEncryptionKey, decryptString, encryptString } from '../../utilities/encryption.js'
import {
  disconnectPlatform,
  getCredentials,
  recordConnectionError,
  saveCredentials,
} from '../connectionService.js'

const KEY = coerceEncryptionKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')
const options = { encryptionKey: KEY } as unknown as NormalizedPluginOptions

let store: Record<string, unknown>
let payload: Payload

beforeEach(() => {
  store = {}
  payload = {
    findGlobal: vi.fn(() => Promise.resolve(store)),
    logger: undefined,
    updateGlobal: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store = data
      return Promise.resolve(data)
    }),
  } as unknown as Payload
})

describe('connectionService — encrypted round trip', () => {
  it('persists tokens encrypted and decrypts them back', async () => {
    await saveCredentials(payload, options, 'pinterest', {
      accessToken: 'pina_SECRET',
      accessTokenExpiresAt: '2027-01-01T00:00:00.000Z',
      accountId: 'acc1',
      accountLabel: 'Fine Gallery',
      refreshToken: 'pinr_SECRET',
      scopes: ['pins:read', 'pins:write'],
    })
    const creds = await getCredentials(payload, options, 'pinterest')
    expect(creds).toMatchObject({
      accessToken: 'pina_SECRET',
      accessTokenExpiresAt: '2027-01-01T00:00:00.000Z',
      accountId: 'acc1',
      accountLabel: 'Fine Gallery',
      refreshToken: 'pinr_SECRET',
      scopes: ['pins:read', 'pins:write'],
    })
  })

  it('never writes plaintext tokens to the global', async () => {
    await saveCredentials(payload, options, 'pinterest', {
      accessToken: 'pina_DISTINCTIVE_PLAINTEXT_TOKEN',
    })
    expect(JSON.stringify(store)).not.toContain('pina_DISTINCTIVE_PLAINTEXT_TOKEN')
    const record = store.pinterest as { accessToken: Record<string, unknown> }
    expect(record.accessToken).toHaveProperty('ciphertext')
    expect(record.accessToken).toHaveProperty('iv')
    expect(record.accessToken).toHaveProperty('authTag')
    expect(record.accessToken.version).toBe(1)
  })

  it('decrypts with a previous key and atomically re-encrypts with the current key', async () => {
    const oldKey = Buffer.alloc(32, 7)
    store = {
      pinterest: {
        accessToken: encryptString('pina_OLD_KEY', oldKey),
        refreshToken: encryptString('pinr_OLD_KEY', oldKey),
        state: { connected: true },
      },
    }
    const rotatingOptions = {
      encryptionKey: KEY,
      previousEncryptionKeys: [oldKey],
    } as unknown as NormalizedPluginOptions
    await expect(getCredentials(payload, rotatingOptions, 'pinterest')).resolves.toMatchObject({
      accessToken: 'pina_OLD_KEY',
      refreshToken: 'pinr_OLD_KEY',
    })
    const record = store.pinterest as {
      accessToken: Parameters<typeof decryptString>[0]
      refreshToken: Parameters<typeof decryptString>[0]
    }
    expect(decryptString(record.accessToken, KEY)).toBe('pina_OLD_KEY')
    expect(decryptString(record.refreshToken, KEY)).toBe('pinr_OLD_KEY')
    expect(() => decryptString(record.accessToken, oldKey)).toThrow()
  })
})

describe('connectionService — getCredentials edge cases', () => {
  it('returns null when there is no record for the platform', async () => {
    expect(await getCredentials(payload, options, 'instagram')).toBeNull()
  })

  it('returns null when both token envelopes are empty', async () => {
    store = { facebook: { accessToken: {}, refreshToken: {}, state: { connected: false } } }
    expect(await getCredentials(payload, options, 'facebook')).toBeNull()
  })
})

describe('connectionService — saveCredentials merge semantics', () => {
  it('preserves the prior refresh token when only the access token is updated', async () => {
    await saveCredentials(payload, options, 'pinterest', { refreshToken: 'pinr_KEEP' })
    await saveCredentials(payload, options, 'pinterest', { accessToken: 'pina_NEW' })
    const creds = await getCredentials(payload, options, 'pinterest')
    expect(creds?.accessToken).toBe('pina_NEW')
    expect(creds?.refreshToken).toBe('pinr_KEEP')
  })

  it('keeps prior account metadata when updateAccount is false', async () => {
    await saveCredentials(payload, options, 'pinterest', {
      accessToken: 'pina_1',
      accountId: 'acc1',
      accountLabel: 'Original',
    })
    await saveCredentials(payload, options, 'pinterest', {
      accessToken: 'pina_2',
      accountId: 'acc2',
      accountLabel: 'Should Not Apply',
      updateAccount: false,
    })
    const creds = await getCredentials(payload, options, 'pinterest')
    expect(creds?.accountId).toBe('acc1')
    expect(creds?.accountLabel).toBe('Original')
  })
})

describe('connectionService — error + disconnect', () => {
  it('records a connection error onto the state', async () => {
    await saveCredentials(payload, options, 'pinterest', { accessToken: 'pina_1' })
    await recordConnectionError(payload, 'pinterest', new Error('token revoked'))
    const record = store.pinterest as { state: { lastError: string } }
    expect(record.state.lastError).toBe('token revoked')
  })

  it('never throws even if the global write fails', async () => {
    const failing = {
      findGlobal: vi.fn(() => Promise.resolve({})),
      logger: undefined,
      updateGlobal: vi.fn(() => Promise.reject(new Error('db down'))),
    } as unknown as Payload
    await expect(
      recordConnectionError(failing, 'pinterest', new Error('boom')),
    ).resolves.toBeUndefined()
  })

  it('disconnect clears tokens and marks the platform disconnected', async () => {
    await saveCredentials(payload, options, 'pinterest', { accessToken: 'pina_1' })
    await disconnectPlatform(payload, 'pinterest')
    expect(await getCredentials(payload, options, 'pinterest')).toBeNull()
    const record = store.pinterest as { state: { connected: boolean } }
    expect(record.state.connected).toBe(false)
  })
})
