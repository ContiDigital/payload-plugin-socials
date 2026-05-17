import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { PLATFORM_IDS } from '../../constants.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { assertAccess } from '../utilities/access.js'
import { errorResponse, jsonResponse } from '../utilities/http.js'
import { createPluginLogger, redactSecretString } from '../utilities/logger.js'

export const createConnectionsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      const log = createPluginLogger(req.payload.logger, { endpoint: 'connections' })
      const connections = Object.fromEntries(
        await Promise.all(
          PLATFORM_IDS.filter((platform) => options.platforms[platform].enabled).map(
            async (platform) => {
              try {
                return [
                  platform,
                  await getPlatformAdapter(platform).isConnected({
                    options,
                    payload: req.payload,
                  }),
                ] as const
              } catch (error) {
                const message = redactSecretString(
                  error instanceof Error ? error.message : String(error),
                )
                log.warn('connection state unavailable', { error: message, platform })
                return [platform, { connected: false, lastError: message }] as const
              }
            },
          ),
        ),
      )
      return jsonResponse({ connections })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/connections`,
})
