import type { Endpoint, Payload, PayloadRequest } from 'payload'

import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { getCredentials } from '../../services/connectionService.js'
import { coerceEncryptionKey, encryptString } from '../../utilities/encryption.js'
import { createPinterestBoardsEndpoints } from '../createPinterestBoardsEndpoints.js'

const KEY = coerceEncryptionKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

const getBoardsEndpoint = (options: NormalizedPluginOptions): Endpoint => {
  const endpoint = createPinterestBoardsEndpoints(options).find(
    (candidate) => candidate.method === 'get',
  )
  if (!endpoint) {
    throw new Error('Pinterest boards endpoint was not registered')
  }
  return endpoint
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Pinterest boards refresh discovery regression', () => {
  it('refreshes once, persists through real Pino, caches the token, and returns boards twice', async () => {
    const options = {
      api: { basePath: '/socials' },
      authorize: vi.fn(() => true),
      coordination: {},
      encryptionKey: KEY,
      platforms: {
        pinterest: {
          clientId: 'cid',
          clientSecret: 'secret',
          enabled: true,
          environment: 'production',
        },
      },
      previousEncryptionKeys: [],
      rateLimit: { enabled: false },
    } as unknown as NormalizedPluginOptions
    let store: Record<string, unknown> = {
      pinterest: {
        refreshToken: encryptString('pinr_SEED', KEY),
        state: { connected: true, scopes: [{ value: 'boards:read' }] },
      },
    }
    const logLines: string[] = []
    const logger = pino(
      { level: 'info', timestamp: false },
      { write: (line: string) => logLines.push(line) },
    )
    const payload = {
      findGlobal: vi.fn(() => Promise.resolve(store)),
      logger,
      updateGlobal: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        store = { ...store, ...data }
        return Promise.resolve(store)
      }),
    } as unknown as Payload
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/v5/oauth/token')) {
        return Promise.resolve(
          Response.json({
            access_token: 'pina_REFRESHED',
            expires_in: 3600,
            refresh_token: 'pinr_ROTATED',
            scope: 'boards:read pins:read',
            token_type: 'bearer',
          }),
        )
      }
      if (url.endsWith('/v5/boards?page_size=100&privacy=ALL')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer pina_REFRESHED',
        )
        return Promise.resolve(
          Response.json({
            bookmark: null,
            items: [{ id: 'board-1', name: 'Gallery', pin_count: 7, privacy: 'PUBLIC' }],
          }),
        )
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const req = { payload, user: { id: 'user-1' } } as unknown as PayloadRequest
    const endpoint = getBoardsEndpoint(options)

    const first = await endpoint.handler(req)
    const second = await endpoint.handler(req)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual({
      boards: [{ id: 'board-1', name: 'Gallery', pinCount: 7, privacy: 'PUBLIC' }],
    })
    expect(await second.json()).toEqual({
      boards: [{ id: 'board-1', name: 'Gallery', pinCount: 7, privacy: 'PUBLIC' }],
    })
    expect(
      fetchMock.mock.calls.filter(([url]) => requestUrl(url).endsWith('/v5/oauth/token')),
    ).toHaveLength(1)
    expect(
      fetchMock.mock.calls.filter(([url]) => requestUrl(url).includes('/v5/boards?')),
    ).toHaveLength(2)
    expect(payload.updateGlobal).toHaveBeenCalledTimes(1)
    await expect(getCredentials(payload, options, 'pinterest')).resolves.toMatchObject({
      accessToken: 'pina_REFRESHED',
      refreshToken: 'pinr_ROTATED',
      scopes: ['boards:read', 'pins:read'],
    })
    expect(logLines.some((line) => line.includes('[Socials] Credentials persisted'))).toBe(true)
  })
})
