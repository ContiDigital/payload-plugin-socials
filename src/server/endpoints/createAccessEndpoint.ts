import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { checkAccess } from '../utilities/access.js'
import { jsonResponse } from '../utilities/http.js'

/**
 * Capability probe for the current `req.user`. Every admin UI surface calls
 * this before rendering so an unauthorized user sees nothing — no nav link, no
 * view, no widget, no composer forms.
 *
 * This is NOT a gate: it never throws and always answers 200. Unauthenticated
 * requests, and a host `authorize` that throws, both resolve to `false` for
 * every scope. Mutations stay gated by `assertAccess` on their own endpoints.
 */
export const createAccessEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      const [admin, publisher] = await Promise.all([
        checkAccess(req, options, 'admin'),
        checkAccess(req, options, 'publisher'),
      ])
      return jsonResponse({ admin, publisher })
    } catch {
      return jsonResponse({ admin: false, publisher: false })
    }
  },
  method: 'get',
  path: `${options.api.basePath}/access`,
})
