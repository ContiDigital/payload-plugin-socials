import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'

import { STATE_COOKIE_NAMES, STATE_COOKIE_TTL_SECONDS } from '../platforms/_meta/oauth.js'
import {
  createOauthCallbackEndpoint,
  createOauthDisconnectEndpoint,
  createOauthStartEndpoint,
  type OauthEndpointConfig,
} from './oauthEndpointFactory.js'

/**
 * Meta OAuth endpoints — mounted once per Meta platform (instagram, facebook).
 *
 *   POST {basePath}/{platform}/oauth/start
 *   GET  {basePath}/{platform}/oauth/callback
 *   POST {basePath}/{platform}/disconnect
 *
 * Both platforms share the underlying Facebook Login dialog (CLAUDE.md §4.4)
 * because IG Business publishing requires a Facebook Page link. Tokens are
 * stored separately per platform so each can be disconnected independently.
 * System-user deployments mount only `disconnect` (no OAuth wiring).
 */

type MetaPlatform = Extract<PlatformId, 'facebook' | 'instagram'>

const hasOauthCreds =
  (platform: MetaPlatform) =>
  (options: NormalizedPluginOptions): boolean => {
    const cfg = options.platforms[platform]
    return Boolean(cfg.appId && cfg.appSecret && cfg.redirectUri)
  }

const metaOauthConfig = (platform: MetaPlatform): OauthEndpointConfig => ({
  connectedValue: platform,
  cookieName: STATE_COOKIE_NAMES[platform],
  cookieTtlSeconds: STATE_COOKIE_TTL_SECONDS,
  credsErrorMessage: `OAuth flow requires platforms.${platform}.{appId, appSecret, redirectUri}`,
  echoPlatformInStartResponse: true,
  hasOauthCreds: hasOauthCreds(platform),
  label: platform,
  pathSegment: platform,
  platform,
})

export const createMetaOauthEndpointsForPlatform = (
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Endpoint[] => {
  const cfg = options.platforms[platform]
  if (!cfg.enabled) {
    return []
  }
  const config = metaOauthConfig(platform)
  const endpoints: Endpoint[] = [createOauthDisconnectEndpoint(options, config)]
  // System-user deployments don't need OAuth wiring.
  if (cfg.appId && cfg.appSecret && cfg.redirectUri) {
    endpoints.push(
      createOauthStartEndpoint(options, config),
      createOauthCallbackEndpoint(options, config),
    )
  }
  return endpoints
}

export const createMetaOauthEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  ...createMetaOauthEndpointsForPlatform(options, 'instagram'),
  ...createMetaOauthEndpointsForPlatform(options, 'facebook'),
]
