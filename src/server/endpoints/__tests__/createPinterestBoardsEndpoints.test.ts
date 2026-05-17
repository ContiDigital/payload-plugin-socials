import type { Endpoint, PayloadRequest } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

vi.mock('../../platforms/pinterest/boards.js', () => ({
  createBoard: vi.fn(),
  deleteBoard: vi.fn(),
  listAllBoards: vi.fn(),
}))
vi.mock('../../utilities/access.js', () => ({ assertAccess: vi.fn() }))

import { createBoard, deleteBoard, listAllBoards } from '../../platforms/pinterest/boards.js'
import { assertAccess } from '../../utilities/access.js'
import { createPinterestBoardsEndpoints } from '../createPinterestBoardsEndpoints.js'

const buildOptions = (enabled = true): NormalizedPluginOptions =>
  ({
    api: { basePath: '/socials' },
    platforms: { pinterest: { enabled } },
  }) as unknown as NormalizedPluginOptions

const options = buildOptions()
const mkReq = (over: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, ...over }) as unknown as PayloadRequest

const find = (method: string, path: string): Endpoint => {
  const e = createPinterestBoardsEndpoints(options).find(
    (x) => x.method === method && x.path === `/socials${path}`,
  )
  if (!e) {
    throw new Error(`no endpoint ${method} ${path}`)
  }
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertAccess).mockResolvedValue(undefined as never)
})

describe('list boards', () => {
  it('returns the boards for a publisher', async () => {
    vi.mocked(listAllBoards).mockResolvedValue([
      { id: 'b1', name: 'A', privacy: 'PUBLIC' },
    ] as never)
    const res = await find('get', '/pinterest/boards').handler(mkReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ boards: [{ id: 'b1', name: 'A', privacy: 'PUBLIC' }] })
  })

  it('propagates an access rejection', async () => {
    vi.mocked(assertAccess).mockRejectedValueOnce(
      Object.assign(new Error('no'), { statusCode: 403 }),
    )
    const res = await find('get', '/pinterest/boards').handler(mkReq())
    expect(res.status).toBe(403)
  })
})

describe('create board', () => {
  it('creates a board and returns 201', async () => {
    vi.mocked(createBoard).mockResolvedValue({
      id: 'b1',
      name: 'My Board',
      privacy: 'PUBLIC',
    } as never)
    const res = await find('post', '/pinterest/boards').handler(
      mkReq({ data: { name: 'My Board', privacy: 'PUBLIC' } }),
    )
    expect(res.status).toBe(201)
    expect(createBoard).toHaveBeenCalledWith(
      expect.anything(),
      options,
      expect.objectContaining({ name: 'My Board', privacy: 'PUBLIC' }),
      expect.anything(),
    )
  })

  it('rejects an invalid privacy', async () => {
    const res = await find('post', '/pinterest/boards').handler(
      mkReq({ data: { name: 'X', privacy: 'WEIRD' } }),
    )
    expect(res.status).toBe(400)
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('rejects a missing name', async () => {
    const res = await find('post', '/pinterest/boards').handler(mkReq({ data: {} }))
    expect(res.status).toBe(400)
  })
})

describe('delete board', () => {
  it('deletes the board id from the path', async () => {
    vi.mocked(deleteBoard).mockResolvedValue(undefined)
    const res = await find('delete', '/pinterest/boards/:boardId').handler(
      mkReq({ routeParams: { boardId: 'b1' } }),
    )
    expect(res.status).toBe(200)
    expect(deleteBoard).toHaveBeenCalledWith(expect.anything(), options, 'b1')
  })

  it('400s a missing board id', async () => {
    const res = await find('delete', '/pinterest/boards/:boardId').handler(
      mkReq({ routeParams: {} }),
    )
    expect(res.status).toBe(400)
  })
})

describe('factory gating', () => {
  it('returns nothing when Pinterest is disabled', () => {
    expect(createPinterestBoardsEndpoints(buildOptions(false))).toEqual([])
  })

  it('returns the three endpoints when enabled', () => {
    expect(createPinterestBoardsEndpoints(options).map((e) => `${e.method} ${e.path}`)).toEqual([
      'get /socials/pinterest/boards',
      'post /socials/pinterest/boards',
      'delete /socials/pinterest/boards/:boardId',
    ])
  })
})
