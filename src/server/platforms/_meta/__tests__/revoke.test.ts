import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../../services/connectionService.js', () => ({ getCredentials: vi.fn() }))
vi.mock('../api.js', () => ({ makeMetaRequest: vi.fn() }))

import { getCredentials } from '../../../services/connectionService.js'
import { makeMetaRequest } from '../api.js'
import { revokeMetaAuthorization } from '../revoke.js'

const payload = {} as Payload
const options = {
  platforms: {
    facebook: { appId: 'shared-app', enabled: true, systemUserAccessToken: '' },
    instagram: { appId: 'shared-app', enabled: true, systemUserAccessToken: '' },
  },
} as unknown as NormalizedPluginOptions

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCredentials).mockResolvedValue({ accessToken: 'user-token' })
  vi.mocked(makeMetaRequest).mockResolvedValue(new Response('{"success":true}'))
})

describe('revokeMetaAuthorization', () => {
  it('revokes /me/permissions and reports a sibling sharing the Meta app', async () => {
    await expect(
      revokeMetaAuthorization({
        options,
        payload,
        platform: 'facebook',
      }),
    ).resolves.toEqual({ affectedPlatforms: ['facebook', 'instagram'] })
    expect(makeMetaRequest).toHaveBeenCalledWith(
      payload,
      options,
      'facebook',
      '/me/permissions',
      expect.objectContaining({ accessToken: 'user-token', init: { method: 'DELETE' } }),
    )
  })

  it('fails without deleting local state when Meta rejects revocation', async () => {
    vi.mocked(makeMetaRequest).mockResolvedValue(new Response('unavailable', { status: 503 }))
    await expect(
      revokeMetaAuthorization({
        options,
        payload,
        platform: 'instagram',
      }),
    ).rejects.toMatchObject({ platform: 'instagram', retryable: true })
  })
})
