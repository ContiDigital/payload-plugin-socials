import type { Payload, PayloadRequest } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { recordConnectionError, saveCredentials } from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { policyFetch } from '../../utilities/requestPolicy.js'
import { getPinterestApiBase } from './api.js'

/**
 * Pinterest OAuth 2.0 — Authorization Code grant with continuous refresh.
 *
 * Flow:
 *   1. Plugin generates an opaque `state` value and sets a
 *      `socials_pinterest_oauth_state` HttpOnly cookie (10-min TTL).
 *   2. Browser is redirected to Pinterest's authorize URL with
 *      `refresh_on=true` so the issued refresh token rolls every refresh.
 *   3. Pinterest redirects back to the plugin's callback endpoint with
 *      `?code=...&state=...`. Plugin verifies state, exchanges code, and
 *      persists access + refresh tokens (encrypted at rest).
 *
 * State-cookie verification is the authoritative gate on the callback —
 * NOT an admin session cookie. Adding a session check here breaks the
 * cross-origin redirect (Pinterest never sends back session cookies).
 */

export const STATE_COOKIE_NAME = 'socials_pinterest_oauth_state'
export const STATE_COOKIE_TTL_SECONDS = 600

export type AuthorizeUrlInput = {
  state: string
}

/** Build the Pinterest authorize URL the plugin redirects the browser to. */
export const buildAuthorizeUrl = (
  options: NormalizedPluginOptions,
  input: AuthorizeUrlInput,
): string => {
  const cfg = options.platforms.pinterest
  // Pinterest authorize endpoint lives on `www.pinterest.com`, NOT the API
  // host. Sandbox uses the same authorize host.
  const authorizeBase = 'https://www.pinterest.com/oauth/'
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    refresh_on: 'true',
    response_type: 'code',
    scope: cfg.scopes.join(','),
    state: input.state,
  })
  return `${authorizeBase}?${params.toString()}`
}

type PinterestTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_at?: number
  refresh_token_expires_in?: number
  scope: string
  token_type: 'bearer'
}

type PinterestAccountResponse = {
  account_type?: string
  business_name?: string
  id?: string
  username?: string
}

export type CallbackResult = {
  accessTokenExpiresAt?: string
  accountId?: string
  accountLabel?: string
  refreshTokenExpiresAt?: string
  scopes: string[]
}

const REQUIRED_SCOPES_FALLBACK = ['pins:read', 'pins:write', 'user_accounts:read'] as const

export const exchangeCodeForTokens = async (args: {
  code: string
  options: NormalizedPluginOptions
  payload: Payload
  req: PayloadRequest
}): Promise<CallbackResult> => {
  const { code, options, payload } = args
  const cfg = options.platforms.pinterest
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')

  const body = new URLSearchParams({
    code,
    continuous_refresh: 'true',
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
  })

  const tokenResponse = await policyFetch({
    config: options.rateLimit,
    init: {
      body: body.toString(),
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    },
    input: `${getPinterestApiBase(cfg.environment)}/v5/oauth/token`,
    payload,
    scope: 'pinterest:oauth',
  })

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text().catch(() => '')
    const err = new PlatformApiError({
      message: `Pinterest token exchange failed: ${tokenResponse.status}`,
      platform: 'pinterest',
      retryable: false,
      statusCode: tokenResponse.status === 401 ? 401 : 502,
      upstreamCode: tokenResponse.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, 'pinterest', err)
    throw err
  }

  const data = (await tokenResponse.json()) as PinterestTokenResponse
  const grantedScopes = (data.scope ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Hard-fail when required scopes aren't granted — otherwise the publish
  // path silently 403s later.
  const required = cfg.scopes.length > 0 ? cfg.scopes : REQUIRED_SCOPES_FALLBACK
  const missing = required.filter((scope) => !grantedScopes.includes(scope))
  if (missing.length > 0) {
    const err = new PlatformApiError({
      message: `Pinterest granted scopes are missing required entries: ${missing.join(', ')}`,
      platform: 'pinterest',
      retryable: false,
      statusCode: 403,
      upstreamCode: 'insufficient_scope',
    })
    await recordConnectionError(payload, 'pinterest', err)
    throw err
  }

  // Fetch account info so the admin UI can display "connected as @handle".
  let account: PinterestAccountResponse = {}
  try {
    const accountResponse = await policyFetch({
      config: options.rateLimit,
      init: { headers: { Authorization: `Bearer ${data.access_token}` } },
      input: `${getPinterestApiBase(cfg.environment)}/v5/user_account`,
      payload,
      scope: 'pinterest:oauth',
    })
    if (accountResponse.ok) {
      account = (await accountResponse.json()) as PinterestAccountResponse
    }
  } catch {
    // Best-effort — connection still succeeds without it.
  }

  const accountLabel = account.business_name?.trim() || account.username?.trim() || account.id || ''
  const accessTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()
  const refreshTokenExpiresAt =
    data.refresh_token_expires_at !== undefined
      ? new Date(data.refresh_token_expires_at * 1000).toISOString()
      : data.refresh_token_expires_in !== undefined
        ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
        : undefined

  await saveCredentials(payload, options, 'pinterest', {
    accessToken: data.access_token,
    accessTokenExpiresAt,
    accountId: account.id,
    accountLabel,
    extra: {
      accountType: account.account_type,
    },
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt,
    scopes: grantedScopes,
  })

  return {
    accessTokenExpiresAt,
    accountId: account.id,
    accountLabel,
    refreshTokenExpiresAt,
    scopes: grantedScopes,
  }
}
