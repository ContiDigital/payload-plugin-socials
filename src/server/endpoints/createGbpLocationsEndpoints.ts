import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { listAccounts, listLocations, listPostablesLocations } from '../platforms/gbp/locations.js'
import { assertAccess } from '../utilities/access.js'
import { errorResponse, getRouteParam, jsonResponse } from '../utilities/http.js'
import { requireString } from '../utilities/validation.js'

/**
 * GBP account + location discovery endpoints. The Pinterest equivalent is
 * `/socials/pinterest/boards`; here we have a two-tier structure because
 * Google's hierarchy is `account → location → localPost` and the user often
 * has multiple accounts.
 *
 *   GET  {basePath}/gbp/accounts             — list manageable accounts
 *   GET  {basePath}/gbp/accounts/:accountId/locations
 *                                            — list locations under one account
 *   GET  {basePath}/gbp/locations            — flattened postable list across all accounts
 */

const createListAccountsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const accounts = await listAccounts(req.payload, options)
      return jsonResponse({ accounts })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/accounts`,
})

const createListAccountLocationsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const accountId = requireString(getRouteParam(req, 'accountId'), 'accountId')
      const locations = await listLocations(req.payload, options, accountId)
      return jsonResponse({ accountId, locations })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/accounts/:accountId/locations`,
})

const createListPostableLocationsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const locations = await listPostablesLocations(req.payload, options)
      return jsonResponse({ locations })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/locations`,
})

export const createGbpLocationsEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.platforms.gbp.enabled) {
    return []
  }
  return [
    createListAccountsEndpoint(options),
    createListAccountLocationsEndpoint(options),
    createListPostableLocationsEndpoint(options),
  ]
}
