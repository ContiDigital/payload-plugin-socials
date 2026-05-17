import type { PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))

import { getPlatformAdapter } from '../../platforms/registry.js'
import { assertAccess } from '../../utilities/access.js'
import { createConnectionsEndpoint } from '../createConnectionsEndpoint.js'

const options = {
  api: { basePath: '/socials' },
  platforms: {
    facebook: { enabled: false },
    gbp: { enabled: false },
    instagram: { enabled: true },
    pinterest: { enabled: true },
  },
} as unknown as NormalizedPluginOptions

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
})

describe('createConnectionsEndpoint', () => {
  it('returns connection state only for enabled adapters', async () => {
    vi.mocked(getPlatformAdapter).mockImplementation(
      (platform) =>
        ({
          isConnected: vi.fn().mockResolvedValue({ accountLabel: platform, connected: true }),
        }) as never,
    )
    const endpoint = createConnectionsEndpoint(options)
    const response = await endpoint.handler({ payload: {} } as PayloadRequest)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      connections: {
        instagram: { accountLabel: 'instagram', connected: true },
        pinterest: { accountLabel: 'pinterest', connected: true },
      },
    })
    expect(assertAccess).toHaveBeenCalledWith(expect.anything(), options, 'admin')
  })

  it('isolates a broken connection while returning the others', async () => {
    vi.mocked(getPlatformAdapter).mockImplementation(
      (platform) =>
        ({
          isConnected:
            platform === 'instagram'
              ? vi.fn().mockRejectedValue(new Error('access_token=secret'))
              : vi.fn().mockResolvedValue({ connected: true }),
        }) as never,
    )
    const response = await createConnectionsEndpoint(options).handler({
      payload: {},
    } as PayloadRequest)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      connections: {
        instagram: { connected: false, lastError: 'access_token=[REDACTED]' },
        pinterest: { connected: true },
      },
    })
  })
})
