import type { Endpoint } from 'payload'

import { randomBytes } from 'node:crypto'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'

import { clearMetaTokenCache } from '../platforms/_meta/api.js'
import { clearGbpTokenCache } from '../platforms/gbp/api.js'
import { clearPinterestTokenCache } from '../platforms/pinterest/api.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { disconnectPlatform } from '../services/connectionService.js'
import { assertAccess } from '../utilities/access.js'
import { ConflictError, ForbiddenError, ValidationError } from '../utilities/errors.js'
import { errorResponse, jsonResponse } from '../utilities/http.js'
import { createPluginLogger } from '../utilities/logger.js'
import {
  buildStateCookie,
  clearStateCookie,
  getSearchParam,
  readRequestCookie,
} from './oauthEndpointSupport.js'

/**
 * Generic Authorization Code flow endpoint builders, shared by every
 * platform's OAuth factory (Pinterest, Meta, GBP). Each platform supplies an
 * `OauthEndpointConfig` and gets three identical, audited handlers:
 *
 *   POST {basePath}/{pathSegment}/oauth/start     → admin-gated; authorize URL + state cookie
 *   GET  {basePath}/{pathSegment}/oauth/callback  → state-cookie gated; exchange; redirect
 *   POST {basePath}/{pathSegment}/disconnect      → admin-gated; clears tokens
 *
 * The callback is deliberately NOT admin-gated: cookie reliability is fragile
 * across the cross-origin redirect, so the state-cookie vs state-param match is
 * the authoritative CSRF gate (CLAUDE.md §2.18 #8).
 */
export type OauthEndpointConfig = {
  /** Value appended to `?connected=` on the post-callback admin redirect. */
  connectedValue: string
  /** Cookie name that holds the CSRF state token. */
  cookieName: string
  /** State cookie TTL in seconds. */
  cookieTtlSeconds: number
  /** Message thrown by `start` when `hasOauthCreds` returns false. */
  credsErrorMessage?: string
  /** When true, the `start` response echoes the platform id (Meta does this). */
  echoPlatformInStartResponse?: boolean
  /**
   * Optional hard credential check for `start`. When supplied and it returns
   * false, `start` throws `credsErrorMessage`. OAuth-only platforms (Meta, GBP)
   * set this; Pinterest does not.
   */
  hasOauthCreds?: (options: NormalizedPluginOptions) => boolean
  /** Human label for error + log messages (e.g. 'Pinterest', 'instagram', 'GBP'). */
  label: string
  /** URL segment under the API base path (e.g. 'pinterest', 'instagram', 'gbp'). */
  pathSegment: string
  /** Platform id used for the adapter registry + credential storage. */
  platform: PlatformId
}

export const createOauthStartEndpoint = (
  options: NormalizedPluginOptions,
  cfg: OauthEndpointConfig,
): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      if (!options.platforms[cfg.platform].enabled) {
        throw new ValidationError(`${cfg.label} is not enabled in plugin options`)
      }
      if (cfg.hasOauthCreds && !cfg.hasOauthCreds(options)) {
        throw new ValidationError(
          cfg.credsErrorMessage ?? `${cfg.label} OAuth credentials are not configured`,
        )
      }
      const state = randomBytes(24).toString('hex')
      const adapter = getPlatformAdapter(cfg.platform)
      const url = adapter.buildAuthorizeUrl
        ? await adapter.buildAuthorizeUrl({ options, payload: req.payload, state })
        : ''
      if (!url) {
        throw new ValidationError(`${cfg.label} adapter has no authorize URL builder`)
      }
      const body = cfg.echoPlatformInStartResponse ? { platform: cfg.platform, url } : { url }
      return jsonResponse(body, 200, {
        'Set-Cookie': buildStateCookie(cfg.cookieName, state, cfg.cookieTtlSeconds),
      })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/${cfg.pathSegment}/oauth/start`,
})

export const createOauthCallbackEndpoint = (
  options: NormalizedPluginOptions,
  cfg: OauthEndpointConfig,
): Endpoint => ({
  handler: async (req) => {
    const log = createPluginLogger(req.payload?.logger, { op: `${cfg.platform}:oauth:callback` })
    try {
      const code = getSearchParam(req, 'code')
      const state = getSearchParam(req, 'state')
      const error = getSearchParam(req, 'error')

      if (error) {
        log.warn(`${cfg.label} authorization denied`, { error })
        return jsonResponse({ error }, 400, { 'Set-Cookie': clearStateCookie(cfg.cookieName) })
      }
      if (!code) {
        throw new ValidationError('Missing authorization code')
      }
      if (!state) {
        throw new ValidationError('Missing state parameter')
      }

      const cookieState = readRequestCookie(req, cfg.cookieName)
      if (!cookieState || cookieState !== state) {
        throw new ForbiddenError('OAuth state mismatch')
      }

      const adapter = getPlatformAdapter(cfg.platform)
      if (!adapter.exchangeCallback) {
        throw new ValidationError(`${cfg.label} adapter does not implement exchangeCallback`)
      }
      await adapter.exchangeCallback({ code, options, payload: req.payload, req })

      return new Response(null, {
        headers: {
          Location: `${options.admin.route}?connected=${cfg.connectedValue}`,
          'Set-Cookie': clearStateCookie(cfg.cookieName),
        },
        status: 302,
      })
    } catch (caught) {
      const response = errorResponse(req, caught)
      response.headers.append('Set-Cookie', clearStateCookie(cfg.cookieName))
      return response
    }
  },
  method: 'get',
  path: `${options.api.basePath}/${cfg.pathSegment}/oauth/callback`,
})

export const createOauthDisconnectEndpoint = (
  options: NormalizedPluginOptions,
  cfg: OauthEndpointConfig,
): Endpoint => ({
  handler: async (req) => {
    const log = createPluginLogger(req.payload?.logger, { op: `${cfg.platform}:disconnect` })
    try {
      await assertAccess(req, options, 'admin')
      const adapter = getPlatformAdapter(cfg.platform)
      const state = await adapter.isConnected({ options, payload: req.payload })
      if (state.managedByConfig) {
        throw new ConflictError(
          `${cfg.platform} credentials are managed by host configuration and cannot be disconnected at runtime`,
        )
      }
      let upstreamRevoked = false
      let revoked: { affectedPlatforms?: PlatformId[] } | undefined
      if (adapter.revokeAuthorization) {
        try {
          const result = await adapter.revokeAuthorization({ options, payload: req.payload })
          revoked = result || undefined
          upstreamRevoked = true
        } catch (revokeError) {
          const message =
            revokeError instanceof Error ? revokeError.message : String(revokeError)
          log.warn('Upstream revocation failed; proceeding with local disconnect', {
            error: message,
            platform: cfg.platform,
          })
        }
      }
      const affectedPlatforms = revoked?.affectedPlatforms ?? [cfg.platform]
      for (const platform of affectedPlatforms) {
        await disconnectPlatform(req.payload, platform)
        if (platform === 'pinterest') {
          clearPinterestTokenCache(req.payload)
        }
        if (platform === 'gbp') {
          clearGbpTokenCache(req.payload)
        }
        if (platform === 'facebook' || platform === 'instagram') {
          clearMetaTokenCache(req.payload, platform)
        }
      }
      return jsonResponse({ affectedPlatforms, ok: true, upstreamRevoked })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/${cfg.pathSegment}/disconnect`,
})
