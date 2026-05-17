import type { Payload, PayloadRequest } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../../types/index.js'

import { recordConnectionError, saveCredentials } from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { policyFetch } from '../../utilities/requestPolicy.js'

/**
 * Facebook Login (OAuth 2.0 with FB extensions).
 *
 * One canonical authorize URL serves BOTH Instagram and Facebook because IG
 * Business publishing requires a Facebook Page that's linked to the IG
 * Business account — so both surfaces share the same Login dialog and the
 * combined scope set. The `platform` argument tells the plugin which set
 * of credentials (Pinterest-style per-platform storage) to write to.
 *
 * Flow:
 *   1. Plugin generates opaque `state`, sets a HttpOnly cookie (10-min TTL).
 *   2. Browser is sent to https://www.facebook.com/{version}/dialog/oauth
 *      with `client_id`, `redirect_uri`, `scope`, `state`, `response_type=code`.
 *   3. User accepts; Facebook redirects back to `redirect_uri?code=…&state=…`.
 *   4. Plugin verifies state cookie, exchanges code for short-lived token,
 *      immediately exchanges that for a long-lived (60-day) token via
 *      `oauth/access_token?grant_type=fb_exchange_token`.
 *   5. Long-lived token is persisted encrypted; cached in memory until 60s
 *      before expiry.
 */

type MetaPlatform = Extract<PlatformId, 'facebook' | 'instagram'>

const FB_LOGIN_HOST = 'https://www.facebook.com'
const GRAPH_HOST = 'https://graph.facebook.com'

export const STATE_COOKIE_NAMES = {
  facebook: 'socials_meta_oauth_state_fb',
  instagram: 'socials_meta_oauth_state_ig',
} as const satisfies Record<MetaPlatform, string>

export const STATE_COOKIE_TTL_SECONDS = 600

type ShortLivedTokenResponse = {
  access_token: string
  expires_in?: number
  token_type: 'bearer'
}

type LongLivedTokenResponse = {
  access_token: string
  expires_in?: number
  token_type: 'bearer'
}

const buildAuthorizeUrlInternal = (
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
  state: string,
): string => {
  const cfg = platform === 'instagram' ? options.platforms.instagram : options.platforms.facebook
  if (!cfg.appId || !cfg.redirectUri) {
    throw new PlatformApiError({
      message: `Meta OAuth requires platforms.${platform}.{appId, redirectUri}`,
      platform,
      retryable: false,
      statusCode: 400,
    })
  }
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: cfg.scopes.join(','),
    state,
  })
  return `${FB_LOGIN_HOST}/${cfg.apiVersion}/dialog/oauth?${params.toString()}`
}

export const buildAuthorizeUrl = (
  options: NormalizedPluginOptions,
  args: { platform: MetaPlatform; state: string },
): string => buildAuthorizeUrlInternal(options, args.platform, args.state)

export type CallbackResult = {
  accessTokenExpiresAt?: string
  scopes: string[]
}

export const exchangeCodeForTokens = async (args: {
  code: string
  options: NormalizedPluginOptions
  payload: Payload
  platform: MetaPlatform
  req: PayloadRequest
}): Promise<CallbackResult> => {
  const { code, options, payload, platform } = args
  const cfg = platform === 'instagram' ? options.platforms.instagram : options.platforms.facebook

  // Step 1: short-lived token.
  const shortParams = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code,
    redirect_uri: cfg.redirectUri,
  })
  const shortUrl = `${GRAPH_HOST}/${cfg.apiVersion}/oauth/access_token?${shortParams.toString()}`
  const shortResponse = await policyFetch({
    config: options.rateLimit,
    init: { method: 'GET' },
    input: shortUrl,
    payload,
    scope: `meta:${platform}:oauth`,
  })
  if (!shortResponse.ok) {
    const text = await shortResponse.text().catch(() => '')
    const err = new PlatformApiError({
      message: `Meta short-lived token exchange failed: ${shortResponse.status}`,
      platform,
      retryable: false,
      statusCode: shortResponse.status === 401 ? 401 : 502,
      upstreamCode: shortResponse.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, platform, err)
    throw err
  }
  const shortData = (await shortResponse.json()) as ShortLivedTokenResponse
  if (!shortData.access_token) {
    throw new PlatformApiError({
      message: 'Meta short-lived token exchange returned no access_token',
      platform,
      retryable: false,
      statusCode: 502,
    })
  }

  // Step 2: immediately exchange for long-lived.
  const longParams = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    fb_exchange_token: shortData.access_token,
    grant_type: 'fb_exchange_token',
  })
  const longUrl = `${GRAPH_HOST}/${cfg.apiVersion}/oauth/access_token?${longParams.toString()}`
  const longResponse = await policyFetch({
    config: options.rateLimit,
    init: { method: 'GET' },
    input: longUrl,
    payload,
    scope: `meta:${platform}:oauth`,
  })
  if (!longResponse.ok) {
    const text = await longResponse.text().catch(() => '')
    const err = new PlatformApiError({
      message: `Meta long-lived token exchange failed: ${longResponse.status}`,
      platform,
      retryable: false,
      statusCode: longResponse.status === 401 ? 401 : 502,
      upstreamCode: longResponse.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, platform, err)
    throw err
  }
  const longData = (await longResponse.json()) as LongLivedTokenResponse
  if (!longData.access_token) {
    throw new PlatformApiError({
      message: 'Meta long-lived token exchange returned no access_token',
      platform,
      retryable: false,
      statusCode: 502,
    })
  }

  // Step 3: introspect to confirm the granted scope set. We rely on the
  // /debug_token endpoint which lives at /{version}/debug_token and requires
  // an app access token (`{app_id}|{app_secret}` concatenation).
  let grantedScopes: string[] = []
  try {
    const appAccessToken = `${cfg.appId}|${cfg.appSecret}`
    const debugUrl =
      `${GRAPH_HOST}/${cfg.apiVersion}/debug_token` +
      `?input_token=${encodeURIComponent(longData.access_token)}` +
      `&access_token=${encodeURIComponent(appAccessToken)}`
    const debugResponse = await policyFetch({
      config: options.rateLimit,
      init: { method: 'GET' },
      input: debugUrl,
      payload,
      scope: `meta:${platform}:oauth`,
    })
    if (debugResponse.ok) {
      const debugData = (await debugResponse.json()) as {
        data?: { scopes?: string[] }
      }
      grantedScopes = debugData.data?.scopes ?? []
    }
  } catch {
    // Best-effort; the connection still works without scope introspection.
  }

  const expiresInSeconds = longData.expires_in ?? 60 * 60 * 24 * 60
  const accessTokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  await saveCredentials(payload, options, platform, {
    accessToken: longData.access_token,
    accessTokenExpiresAt,
    scopes: grantedScopes,
  })

  return {
    accessTokenExpiresAt,
    scopes: grantedScopes,
  }
}
