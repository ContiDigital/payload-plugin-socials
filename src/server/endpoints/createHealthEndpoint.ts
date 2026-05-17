import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { PLATFORM_IDS } from '../../constants.js'
import { getRegisteredSourceKinds } from '../sources/registry.js'
import { errorResponse, jsonResponse } from '../utilities/http.js'

/**
 * Public health probe. Returns the set of enabled platforms and registered
 * source kinds without revealing any credentials. Useful for ops smoke tests.
 */
export const createHealthEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: (req) => {
    try {
      const enabledPlatforms = PLATFORM_IDS.filter((id) => options.platforms[id].enabled === true)
      return Promise.resolve(
        jsonResponse({
          admin: { mode: options.admin.mode, route: options.admin.route },
          api: { basePath: options.api.basePath },
          enabledPlatforms,
          plugin: 'payload-plugin-socials',
          sourceKinds: getRegisteredSourceKinds(),
          status: 'ok',
          testMode: options.testMode,
          timestamp: new Date().toISOString(),
        }),
      )
    } catch (error) {
      return Promise.resolve(errorResponse(req, error))
    }
  },
  method: 'get',
  path: `${options.api.basePath}/health`,
})
