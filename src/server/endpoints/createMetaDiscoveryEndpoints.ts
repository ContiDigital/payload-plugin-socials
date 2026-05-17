import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { listManagedPages } from '../platforms/facebook/pages.js'
import { discoverIgAccountFromPage, listIgAccounts } from '../platforms/instagram/discovery.js'
import { assertAccess } from '../utilities/access.js'
import { errorResponse, getRouteParam, jsonResponse } from '../utilities/http.js'
import { requireString } from '../utilities/validation.js'

/**
 * Meta destination-discovery endpoints. Equivalent to Pinterest's `/boards`
 * and GBP's `/locations` — these let the admin UI populate the publishing
 * destination picker.
 *
 *   GET {basePath}/facebook/pages
 *   GET {basePath}/instagram/accounts
 *   GET {basePath}/instagram/pages/:pageId/account
 */

const createListFbPagesEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const pages = await listManagedPages(req.payload, options)
      // Strip the Page-scoped token from the publisher-facing response —
      // it shouldn't leave the server unless the admin explicitly asks for
      // it via the diagnostic endpoint below.
      const safe = pages.map(({ accessToken: _omit, ...rest }) => rest)
      return jsonResponse({ pages: safe })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/facebook/pages`,
})

const createListIgAccountsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const accounts = await listIgAccounts(req.payload, options)
      return jsonResponse({ accounts })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/instagram/accounts`,
})

const createIgPageDiscoveryEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const pageId = requireString(getRouteParam(req, 'pageId'), 'pageId')
      const account = await discoverIgAccountFromPage(req.payload, options, pageId)
      if (!account) {
        return jsonResponse(
          { igUserId: null, note: 'Page has no linked IG Business account', pageId },
          404,
        )
      }
      return jsonResponse({ ...account, pageId })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/instagram/pages/:pageId/account`,
})

export const createMetaDiscoveryEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  const endpoints: Endpoint[] = []
  if (options.platforms.facebook.enabled) {
    endpoints.push(createListFbPagesEndpoint(options))
  }
  if (options.platforms.instagram.enabled) {
    endpoints.push(createListIgAccountsEndpoint(options), createIgPageDiscoveryEndpoint(options))
  }
  return endpoints
}
