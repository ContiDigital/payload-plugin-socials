import type { Config, Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { createAccessEndpoint } from '../server/endpoints/createAccessEndpoint.js'
import { createComposeEndpoints } from '../server/endpoints/createComposeEndpoints.js'
import { createConnectionsEndpoint } from '../server/endpoints/createConnectionsEndpoint.js'
import { createGbpLocationsEndpoints } from '../server/endpoints/createGbpLocationsEndpoints.js'
import { createGbpOauthEndpoints } from '../server/endpoints/createGbpOauthEndpoints.js'
import { createHealthEndpoint } from '../server/endpoints/createHealthEndpoint.js'
import { createInternalSchedulerEndpoints } from '../server/endpoints/createInternalSchedulerEndpoints.js'
import { createMetaDiscoveryEndpoints } from '../server/endpoints/createMetaDiscoveryEndpoints.js'
import { createMetaOauthEndpoints } from '../server/endpoints/createMetaOauthEndpoints.js'
import { createMetaWebhookEndpoints } from '../server/endpoints/createMetaWebhookEndpoints.js'
import { createPinterestBoardsEndpoints } from '../server/endpoints/createPinterestBoardsEndpoints.js'
import { createPinterestOauthEndpoints } from '../server/endpoints/createPinterestOauthEndpoints.js'
import { createPostDeleteEndpoints } from '../server/endpoints/createPostDeleteEndpoints.js'
import { createSourcePublishEndpoints } from '../server/endpoints/createSourcePublishEndpoints.js'
import { createTemplateEndpoints } from '../server/endpoints/createTemplateEndpoints.js'

export const applyEndpointEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.endpoints) {
    config.endpoints = []
  }

  const endpoints: Endpoint[] = [
    createHealthEndpoint(options),
    createAccessEndpoint(options),
    createConnectionsEndpoint(options),
    ...createPinterestOauthEndpoints(options),
    ...createPinterestBoardsEndpoints(options),
    ...createGbpOauthEndpoints(options),
    ...createGbpLocationsEndpoints(options),
    ...createMetaOauthEndpoints(options),
    ...createMetaWebhookEndpoints(options),
    ...createMetaDiscoveryEndpoints(options),
    ...createSourcePublishEndpoints(options),
    ...createTemplateEndpoints(options),
    ...createComposeEndpoints(options),
    ...createInternalSchedulerEndpoints(options),
    ...createPostDeleteEndpoints(options),
  ]

  // Avoid duplicate registration on HMR — match by exact (method, path).
  for (const endpoint of endpoints) {
    if (
      !config.endpoints.some(
        (existing) => existing.path === endpoint.path && existing.method === endpoint.method,
      )
    ) {
      config.endpoints.push(endpoint)
    }
  }
  return config
}
