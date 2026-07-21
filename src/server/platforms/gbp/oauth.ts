import type { Payload, PayloadRequest } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { recordConnectionError, saveCredentials } from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { policyFetch } from '../../utilities/requestPolicy.js'

/**
 * Google Business Profile OAuth 2.0 — Authorization Code grant.
 *
 * Required scope: `https://www.googleapis.com/auth/business.manage`.
 *
 * Refresh tokens for Google don't expire from age but DO get revoked
 * after 6 months of inactivity. The plugin's token cache schedules a
 * refresh ~60s before stated `expires_in` to keep the warm path fast.
 *
 * Flow mirrors the Pinterest OAuth pattern — state cookie + verify on
 * callback, NOT admin session — to survive cross-origin redirects.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const STATE_COOKIE_NAME = 'socials_gbp_oauth_state'
export const STATE_COOKIE_TTL_SECONDS = 600

const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/business.manage'

export type AuthorizeUrlInput = {
  state: string
}

export const buildAuthorizeUrl = (
  options: NormalizedPluginOptions,
  input: AuthorizeUrlInput,
): string => {
  const cfg = options.platforms.gbp
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPE,
    state: input.state,
    // `access_type=offline` is mandatory to receive a refresh token.
    access_type: 'offline',
    // Explicit consent ensures the callback receives a refresh token for offline work.
    include_granted_scopes: 'true',
    prompt: 'consent',
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

type GoogleTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: 'Bearer'
}

export type CallbackResult = {
  accessTokenExpiresAt: string
  scopes: string[]
}

export const exchangeCodeForTokens = async (args: {
  code: string
  options: NormalizedPluginOptions
  payload: Payload
  req: PayloadRequest
}): Promise<CallbackResult> => {
  const { code, options, payload } = args
  const cfg = options.platforms.gbp

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
  })

  const response = await policyFetch({
    config: options.rateLimit,
    init: {
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    input: TOKEN_URL,
    payload,
    scope: 'gbp:oauth',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err = new PlatformApiError({
      message: `GBP token exchange failed: ${response.status}`,
      platform: 'gbp',
      retryable: false,
      statusCode: response.status === 401 ? 401 : 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, 'gbp', err)
    throw err
  }

  const data = (await response.json()) as GoogleTokenResponse
  const grantedScopes = (data.scope ?? '')
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!grantedScopes.includes(REQUIRED_SCOPE)) {
    const err = new PlatformApiError({
      message: `GBP authorization did not grant the required ${REQUIRED_SCOPE} scope`,
      platform: 'gbp',
      retryable: false,
      statusCode: 403,
      upstreamCode: 'insufficient_scope',
    })
    await recordConnectionError(payload, 'gbp', err)
    throw err
  }

  if (!data.refresh_token) {
    // Google only returns refresh_token on the FIRST authorize for a given
    // user × app pair unless `prompt=consent` is forced. We force it in
    // `buildAuthorizeUrl` so this branch should never fire — but the
    // platform sometimes drops it anyway under odd consent-screen states.
    const err = new PlatformApiError({
      message:
        'Google did not return a refresh_token. Revoke this app at myaccount.google.com/permissions then reconnect.',
      platform: 'gbp',
      retryable: false,
      statusCode: 400,
      upstreamCode: 'no_refresh_token',
    })
    await recordConnectionError(payload, 'gbp', err)
    throw err
  }

  const accessTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

  await saveCredentials(payload, options, 'gbp', {
    accessToken: data.access_token,
    accessTokenExpiresAt,
    refreshToken: data.refresh_token,
    scopes: grantedScopes,
  })

  return { accessTokenExpiresAt, scopes: grantedScopes }
}
