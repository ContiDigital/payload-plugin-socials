import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { STATE_COOKIE_NAME, STATE_COOKIE_TTL_SECONDS } from '../platforms/pinterest/oauth.js'
import {
  createOauthCallbackEndpoint,
  createOauthDisconnectEndpoint,
  createOauthStartEndpoint,
  type OauthEndpointConfig,
} from './oauthEndpointFactory.js'

/**
 * Three Pinterest OAuth endpoints, built from the shared OAuth factory:
 *
 *   POST {basePath}/pinterest/oauth/start      → admin-gated; returns authorize URL + sets state cookie
 *   GET  {basePath}/pinterest/oauth/callback   → cookie-gated; exchanges code; redirects to admin
 *   POST {basePath}/pinterest/disconnect       → admin-gated; nukes encrypted tokens
 *
 * Pinterest mounts start + callback whenever it is enabled (no separate
 * system-user mode), so unlike Meta/GBP there is no credential gate.
 */
const PINTEREST_OAUTH_CONFIG: OauthEndpointConfig = {
  connectedValue: 'pinterest',
  cookieName: STATE_COOKIE_NAME,
  cookieTtlSeconds: STATE_COOKIE_TTL_SECONDS,
  label: 'Pinterest',
  pathSegment: 'pinterest',
  platform: 'pinterest',
}

export const createPinterestOauthStartEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthStartEndpoint(options, PINTEREST_OAUTH_CONFIG)

export const createPinterestOauthCallbackEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthCallbackEndpoint(options, PINTEREST_OAUTH_CONFIG)

export const createPinterestDisconnectEndpoint = (options: NormalizedPluginOptions): Endpoint =>
  createOauthDisconnectEndpoint(options, PINTEREST_OAUTH_CONFIG)

export const createPinterestOauthEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.platforms.pinterest.enabled) {
    return []
  }
  return [
    createPinterestOauthStartEndpoint(options),
    createPinterestOauthCallbackEndpoint(options),
    createPinterestDisconnectEndpoint(options),
  ]
}
