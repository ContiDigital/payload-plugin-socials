import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/facebook/pages.js', () => ({
  listManagedPages: vi.fn(),
}))
vi.mock('../../platforms/instagram/discovery.js', () => ({
  discoverIgAccountFromPage: vi.fn(),
  listIgAccounts: vi.fn(),
}))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))

import { listManagedPages } from '../../platforms/facebook/pages.js'
import { discoverIgAccountFromPage, listIgAccounts } from '../../platforms/instagram/discovery.js'
import { assertAccess } from '../../utilities/access.js'
import { createMetaDiscoveryEndpoints } from '../createMetaDiscoveryEndpoints.js'

const buildOptions = (over: Record<string, unknown> = {}): NormalizedPluginOptions =>
  ({
    api: { basePath: '/socials' },
    platforms: { facebook: { enabled: true }, instagram: { enabled: true }, ...over },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const mkReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, ...over }) as unknown as PayloadRequest

const find = (path: string, opts = options): Endpoint => {
  const e = createMetaDiscoveryEndpoints(opts).find((x) => x.path === `/socials${path}`)
  if (!e) {
    throw new Error(`no endpoint ${path}`)
  }
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
})

describe('facebook pages', () => {
  it('lists pages but strips the page-scoped access token from the response', async () => {
    vi.mocked(listManagedPages).mockResolvedValue([
      { id: 'p1', name: 'Page', accessToken: 'SECRET', category: 'Retail' },
    ] as never)
    const res = await find('/facebook/pages').handler(mkReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pages[0]).toMatchObject({ id: 'p1', name: 'Page' })
    expect(body.pages[0]).not.toHaveProperty('accessToken')
  })
})

describe('instagram discovery', () => {
  it('lists IG accounts', async () => {
    vi.mocked(listIgAccounts).mockResolvedValue([{ igUserId: 'ig1', pageId: 'p1' }] as never)
    const res = await find('/instagram/accounts').handler(mkReq())
    expect(await res.json()).toEqual({ accounts: [{ igUserId: 'ig1', pageId: 'p1' }] })
  })

  it('returns the linked account for a page', async () => {
    vi.mocked(discoverIgAccountFromPage).mockResolvedValue({
      igUserId: 'ig1',
      pageId: 'p1',
    } as never)
    const res = await find('/instagram/pages/:pageId/account').handler(
      mkReq({ routeParams: { pageId: 'p1' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ igUserId: 'ig1', pageId: 'p1' })
  })

  it('404s when the page has no linked IG account', async () => {
    vi.mocked(discoverIgAccountFromPage).mockResolvedValue(null)
    const res = await find('/instagram/pages/:pageId/account').handler(
      mkReq({ routeParams: { pageId: 'p1' } }),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ igUserId: null })
  })
})

describe('factory gating', () => {
  it('mounts both Facebook and Instagram endpoints when both are enabled', () => {
    expect(createMetaDiscoveryEndpoints(options).map((e) => e.path)).toEqual([
      '/socials/facebook/pages',
      '/socials/instagram/accounts',
      '/socials/instagram/pages/:pageId/account',
    ])
  })

  it('mounts only the enabled platform', () => {
    expect(
      createMetaDiscoveryEndpoints(buildOptions({ instagram: { enabled: false } })).map(
        (e) => e.path,
      ),
    ).toEqual(['/socials/facebook/pages'])
  })

  it('mounts nothing when neither is enabled', () => {
    expect(
      createMetaDiscoveryEndpoints(
        buildOptions({ facebook: { enabled: false }, instagram: { enabled: false } }),
      ),
    ).toEqual([])
  })
})
