import type { Payload, PayloadRequest } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { ValidationError } from '../../utilities/errors.js'
import { pinterestJson } from './api.js'

export type PinterestBoard = {
  boardPinsModifiedAt?: string
  collaboratorCount?: number
  coverImageUrl?: string
  createdAt?: string
  description?: string
  followerCount?: number
  id: string
  name: string
  pinCount?: number
  privacy: 'PROTECTED' | 'PUBLIC' | 'SECRET'
  url?: string
}

type PinterestBoardListPage = {
  bookmark?: null | string
  items?: Array<{
    board_pins_modified_at?: string
    collaborator_count?: number
    created_at?: string
    description?: string
    follower_count?: number
    id: string
    media?: { image_cover_url?: string }
    name: string
    pin_count?: number
    privacy: string
  }>
}

const normalizePrivacy = (raw: string | undefined): PinterestBoard['privacy'] => {
  if (raw === 'SECRET') {
    return 'SECRET'
  }
  if (raw === 'PROTECTED') {
    return 'PROTECTED'
  }
  return 'PUBLIC'
}

/**
 * List all boards available to the authenticated account. Paginates via the
 * Pinterest `bookmark` cursor; accumulates until the cursor is null/missing.
 *
 * `privacy: 'ALL'` requires `boards:read` + (when secret boards are wanted)
 * `boards:read_secret`. Plugin scope normalizer requests both by default.
 */
export const listAllBoards = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  args: { privacy?: 'ALL' | 'PROTECTED' | 'PUBLIC' | 'SECRET' } = {},
): Promise<PinterestBoard[]> => {
  const privacy = args.privacy ?? 'ALL'
  const out: PinterestBoard[] = []
  let bookmark: string | undefined

  while (true) {
    const params = new URLSearchParams({
      page_size: '100',
      privacy,
    })
    if (bookmark) {
      params.set('bookmark', bookmark)
    }
    const page = await pinterestJson<PinterestBoardListPage>(
      payload,
      options,
      `/v5/boards?${params.toString()}`,
    )
    for (const board of page.items ?? []) {
      out.push({
        id: board.id,
        name: board.name,
        boardPinsModifiedAt: board.board_pins_modified_at,
        collaboratorCount: board.collaborator_count,
        coverImageUrl: board.media?.image_cover_url,
        createdAt: board.created_at,
        description: board.description,
        followerCount: board.follower_count,
        pinCount: board.pin_count,
        privacy: normalizePrivacy(board.privacy),
      })
    }
    if (!page.bookmark) {
      break
    }
    bookmark = page.bookmark
  }

  // Stable ordering prevents destination menus from moving between refreshes.
  out.sort((a, b) => {
    const pinDelta = (b.pinCount ?? 0) - (a.pinCount ?? 0)
    if (pinDelta !== 0) {
      return pinDelta
    }
    return a.name.localeCompare(b.name)
  })

  return out
}

export type CreateBoardInput = {
  description?: string
  name: string
  privacy?: 'PROTECTED' | 'PUBLIC' | 'SECRET'
}

/**
 * Create a new board. Test-mode (sandbox env OR `options.testMode === true`)
 * forces a `[TEST]` name prefix and `SECRET` privacy to keep production
 * audiences clean during integration testing.
 */
export const createBoard = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  input: CreateBoardInput,
  _req?: PayloadRequest,
): Promise<PinterestBoard> => {
  const name = input.name.trim()
  if (!name) {
    throw new ValidationError('Board name is required')
  }

  const isTestMode = options.testMode || options.platforms.pinterest.environment === 'sandbox'

  const safeName = isTestMode && !name.startsWith('[TEST]') ? `[TEST] ${name}` : name
  const safePrivacy: 'PROTECTED' | 'PUBLIC' | 'SECRET' = isTestMode
    ? 'SECRET'
    : (input.privacy ?? 'PUBLIC')

  const created = await pinterestJson<{
    collaborator_count?: number
    created_at?: string
    description?: string
    follower_count?: number
    id: string
    name: string
    pin_count?: number
    privacy: string
  }>(payload, options, '/v5/boards', {
    body: JSON.stringify({
      name: safeName,
      description: input.description?.trim() || undefined,
      privacy: safePrivacy,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  return {
    id: created.id,
    name: created.name,
    collaboratorCount: created.collaborator_count,
    createdAt: created.created_at,
    description: created.description,
    followerCount: created.follower_count,
    pinCount: created.pin_count,
    privacy: normalizePrivacy(created.privacy),
  }
}

export const deleteBoard = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  boardId: string,
): Promise<void> => {
  // 204 No Content — pinterestJson would choke on empty body, so go raw.
  const { makePinterestRequest } = await import('./api.js')
  const response = await makePinterestRequest(
    payload,
    options,
    `/v5/boards/${encodeURIComponent(boardId)}`,
    { init: { method: 'DELETE' } },
  )
  if (response.status === 404) {
    return
  } // Idempotent: already gone.
  if (!response.ok) {
    throw new ValidationError(
      `Pinterest board delete failed: ${response.status} ${await response.text().catch(() => '')}`,
    )
  }
}
