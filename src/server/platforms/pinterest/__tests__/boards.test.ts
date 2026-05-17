import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../api.js', () => ({ makePinterestRequest: vi.fn(), pinterestJson: vi.fn() }))

import { makePinterestRequest, pinterestJson } from '../api.js'
import { createBoard, deleteBoard, listAllBoards } from '../boards.js'

const options = {
  platforms: { pinterest: { environment: 'production' } },
  testMode: false,
} as unknown as NormalizedPluginOptions

const payload = {} as Payload

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listAllBoards', () => {
  it('normalizes and sorts boards by pin count then name', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      bookmark: null,
      items: [
        { id: 'b1', name: 'Zeta', pin_count: 5, privacy: 'PUBLIC' },
        {
          id: 'b2',
          name: 'Alpha',
          media: { image_cover_url: 'u' },
          pin_count: 10,
          privacy: 'SECRET',
        },
      ],
    } as never)
    const boards = await listAllBoards(payload, options)
    expect(boards.map((b) => b.id)).toEqual(['b2', 'b1']) // 10 before 5
    expect(boards[0]).toMatchObject({ coverImageUrl: 'u', privacy: 'SECRET' })
  })

  it('breaks ties by name ascending', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      bookmark: null,
      items: [
        { id: 'b1', name: 'Banana', pin_count: 3, privacy: 'PUBLIC' },
        { id: 'b2', name: 'Apple', pin_count: 3, privacy: 'PUBLIC' },
      ],
    } as never)
    const boards = await listAllBoards(payload, options)
    expect(boards.map((b) => b.name)).toEqual(['Apple', 'Banana'])
  })

  it('follows the bookmark cursor across pages', async () => {
    vi.mocked(pinterestJson)
      .mockResolvedValueOnce({
        bookmark: 'NEXT',
        items: [{ id: 'b1', name: 'A', pin_count: 1, privacy: 'PUBLIC' }],
      } as never)
      .mockResolvedValueOnce({
        bookmark: null,
        items: [{ id: 'b2', name: 'B', pin_count: 2, privacy: 'PUBLIC' }],
      } as never)
    const boards = await listAllBoards(payload, options)
    expect(boards).toHaveLength(2)
    expect(pinterestJson).toHaveBeenCalledTimes(2)
    expect(vi.mocked(pinterestJson).mock.calls[1]?.[2]).toContain('bookmark=NEXT')
  })

  it('normalizes an unknown privacy to PUBLIC', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      bookmark: null,
      items: [{ id: 'b1', name: 'X', pin_count: 0, privacy: 'WEIRD' }],
    } as never)
    const boards = await listAllBoards(payload, options)
    expect(boards[0]?.privacy).toBe('PUBLIC')
  })
})

describe('createBoard', () => {
  it('requires a non-empty name', async () => {
    await expect(createBoard(payload, options, { name: '   ' })).rejects.toThrow(
      /Board name is required/,
    )
  })

  it('creates a board with the given privacy in normal mode', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      id: 'b1',
      name: 'My Board',
      privacy: 'PUBLIC',
    } as never)
    await createBoard(payload, options, { name: 'My Board', privacy: 'PUBLIC' })
    const body = JSON.parse(vi.mocked(pinterestJson).mock.calls[0]?.[3]?.body as string)
    expect(body).toMatchObject({ name: 'My Board', privacy: 'PUBLIC' })
  })

  it('forces a [TEST] prefix and SECRET privacy in sandbox mode', async () => {
    const sandbox = {
      platforms: { pinterest: { environment: 'sandbox' } },
      testMode: false,
    } as unknown as NormalizedPluginOptions
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      id: 'b1',
      name: '[TEST] My Board',
      privacy: 'SECRET',
    } as never)
    const board = await createBoard(payload, sandbox, { name: 'My Board', privacy: 'PUBLIC' })
    const body = JSON.parse(vi.mocked(pinterestJson).mock.calls[0]?.[3]?.body as string)
    expect(body).toMatchObject({ name: '[TEST] My Board', privacy: 'SECRET' })
    expect(board.id).toBe('b1')
  })

  it('forces test-mode guards when options.testMode is set', async () => {
    const testModeOptions = {
      platforms: { pinterest: { environment: 'production' } },
      testMode: true,
    } as unknown as NormalizedPluginOptions
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      id: 'b1',
      name: '[TEST] Q',
      privacy: 'SECRET',
    } as never)
    await createBoard(payload, testModeOptions, { name: 'Q' })
    const body = JSON.parse(vi.mocked(pinterestJson).mock.calls[0]?.[3]?.body as string)
    expect(body.name).toBe('[TEST] Q')
    expect(body.privacy).toBe('SECRET')
  })
})

describe('deleteBoard', () => {
  const resp = (status: number, text = ''): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    }) as unknown as Response

  it('resolves on a successful delete', async () => {
    vi.mocked(makePinterestRequest).mockResolvedValueOnce(resp(200))
    await expect(deleteBoard(payload, options, 'b1')).resolves.toBeUndefined()
  })

  it('treats a 404 as an idempotent success', async () => {
    vi.mocked(makePinterestRequest).mockResolvedValueOnce(resp(404))
    await expect(deleteBoard(payload, options, 'b1')).resolves.toBeUndefined()
  })

  it('throws on any other failure', async () => {
    vi.mocked(makePinterestRequest).mockResolvedValueOnce(resp(500, 'boom'))
    await expect(deleteBoard(payload, options, 'b1')).rejects.toThrow(/board delete failed: 500/)
  })
})
