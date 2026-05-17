import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../../services/connectionService.js', () => ({ getCredentials: vi.fn() }))
vi.mock('../../../utilities/requestPolicy.js', () => ({ policyFetch: vi.fn() }))

import { getCredentials } from '../../../services/connectionService.js'
import { policyFetch } from '../../../utilities/requestPolicy.js'
import { revokeGbpAuthorization } from '../revoke.js'

const payload = {} as Payload
const options = { rateLimit: {} } as NormalizedPluginOptions

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCredentials).mockResolvedValue({ refreshToken: 'refresh-token' })
  vi.mocked(policyFetch).mockResolvedValue(new Response(null, { status: 200 }))
})

describe('revokeGbpAuthorization', () => {
  it('sends the refresh token in a form body rather than the URL', async () => {
    await revokeGbpAuthorization(payload, options)
    const call = vi.mocked(policyFetch).mock.calls[0][0]
    expect(call.input).toBe('https://oauth2.googleapis.com/revoke')
    expect(call.init?.body).toBe('token=refresh-token')
    if (typeof call.input !== 'string') {
      throw new Error('expected a string revoke URL')
    }
    expect(call.input).not.toContain('refresh-token')
  })

  it('treats an already invalid token as an idempotent success', async () => {
    vi.mocked(policyFetch).mockResolvedValue(
      new Response('{"error":"invalid_token"}', { status: 400 }),
    )
    await expect(revokeGbpAuthorization(payload, options)).resolves.toBeUndefined()
  })
})
