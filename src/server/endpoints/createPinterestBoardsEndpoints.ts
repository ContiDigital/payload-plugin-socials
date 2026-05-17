import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { createBoard, deleteBoard, listAllBoards } from '../platforms/pinterest/boards.js'
import { assertAccess } from '../utilities/access.js'
import { ValidationError } from '../utilities/errors.js'
import { errorResponse, getRouteParam, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { requireString } from '../utilities/validation.js'

const createPinterestListBoardsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const boards = await listAllBoards(req.payload, options)
      return jsonResponse({ boards })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/pinterest/boards`,
})

const createPinterestCreateBoardEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const body = await parseRequestBody(req)
      const name = requireString(body.name, 'name')
      const privacy = body.privacy as 'PROTECTED' | 'PUBLIC' | 'SECRET' | undefined
      if (privacy && !['PROTECTED', 'PUBLIC', 'SECRET'].includes(privacy)) {
        throw new ValidationError('privacy must be PUBLIC, PROTECTED, or SECRET')
      }
      const description = typeof body.description === 'string' ? body.description : undefined
      const board = await createBoard(req.payload, options, { name, description, privacy }, req)
      return jsonResponse({ board }, 201)
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/pinterest/boards`,
})

const createPinterestDeleteBoardEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      const boardId = requireString(getRouteParam(req, 'boardId'), 'boardId')
      await deleteBoard(req.payload, options, boardId)
      return jsonResponse({ ok: true })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'delete',
  path: `${options.api.basePath}/pinterest/boards/:boardId`,
})

export const createPinterestBoardsEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.platforms.pinterest.enabled) {
    return []
  }
  return [
    createPinterestListBoardsEndpoint(options),
    createPinterestCreateBoardEndpoint(options),
    createPinterestDeleteBoardEndpoint(options),
  ]
}
