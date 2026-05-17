import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { STATE_COOKIE_NAME, STATE_COOKIE_TTL_SECONDS } from '../platforms/gbp/oauth.js'
import {
  createOauthCallbackEndpoint,
  createOauthDisconnectEndpoint,
  createOauthStartEndpoint,
  type OauthEndpointConfig,
} from './oauthEndpointFactory.js'

/**
 * GBP OAuth endpoints, built from the shared OAuth factory.
 *
 *   POST {basePath}/gbp/oauth/start
 *   GET  {basePath}/gbp/oauth/callback
 *   POST {basePath}/gbp/disconnect
 *
 * Service-account-only deployments mount only `disconnect` — they get their
 * access token from the JWT bearer flow at request time, so they never run the
 * OAuth start/callback dance. We still mount disconnect so admins can clear any
 * prior OAuth state.
 */
const GBP_OAUTH_CONFIG: OauthEndpointConfig = {
  connectedValue: 'gbp',
  cookieName: STATE_COOKIE_NAME,
  cookieTtlSeconds: STATE_COOKIE_TTL_SECONDS,
  credsErrorMessage: 'OAuth flow requires platforms.gbp.{clientId, clientSecret, redirectUri}',
  hasOauthCreds: (options) => {
    const cfg = options.platforms.gbp
    return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri)
  },
  label: 'GBP',
  pathSegment: 'gbp',
  platform: 'gbp',
}

const createGbpOauthStartEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthStartEndpoint(options, GBP_OAUTH_CONFIG)

const createGbpOauthCallbackEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthCallbackEndpoint(options, GBP_OAUTH_CONFIG)

const createGbpDisconnectEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthDisconnectEndpoint(options, GBP_OAUTH_CONFIG)

export const createGbpOauthEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.platforms.gbp.enabled) {
    return []
  }
  const cfg = options.platforms.gbp
  const endpoints: Endpoint[] = [createGbpDisconnectEndpoint(options)]
  if (cfg.clientId && cfg.clientSecret && cfg.redirectUri) {
    endpoints.push(createGbpOauthStartEndpoint(options), createGbpOauthCallbackEndpoint(options))
  }
  return endpoints
}
