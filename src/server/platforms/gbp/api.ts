import type { Payload } from 'payload'

import { createSign } from 'node:crypto'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { RETRYABLE_STATUS_CODES } from '../../../constants.js'
import {
  getCredentials,
  recordConnectionError,
  saveCredentials,
} from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { createPluginLogger } from '../../utilities/logger.js'
import {
  isRetryableNetworkError,
  isSafeToRetryRequest,
  policyFetch,
} from '../../utilities/requestPolicy.js'

/**
 * Google Business Profile HTTP client.
 *
 * Supports both configured credential paths:
 *
 *   1. **OAuth 2.0 web-app flow** — preferred for SaaS where each tenant
 *      authorizes their own GBP. Refresh tokens persist indefinitely.
 *      Mints a fresh access token via the standard refresh_token grant.
 *
 *   2. **Service-account JWT bearer flow** — preferred for single-tenant
 *      backend deployments where a service-account email is added as
 *      manager on the GBP account directly. Mints a fresh access token
 *      via `urn:ietf:params:oauth:grant-type:jwt-bearer`.
 *
 * Either flow is selected at config-time per `options.platforms.gbp`. If
 * both are supplied, OAuth takes precedence (refresh token in
 * `socials-connections`); SA is the fallback for cold starts where the
 * tenant hasn't completed OAuth yet.
 *
 * Google splits Business Profile resources across several API hosts; this
 * module is the single source of those base URLs.
 */

export const GBP_HOSTS = {
  accountManagement: 'https://mybusinessaccountmanagement.googleapis.com',
  businessInformation: 'https://mybusinessbusinessinformation.googleapis.com',
  legacyV4: 'https://mybusiness.googleapis.com',
  performance: 'https://businessprofileperformance.googleapis.com',
} as const

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SA_SCOPE = 'https://www.googleapis.com/auth/business.manage'

// ---------------------------------------------------------------------------
// Access-token cache (per-payload, per-credential-mode)
// ---------------------------------------------------------------------------

type CachedAccessToken = { expiresAtMs: number; token: string }
const tokenCache = new WeakMap<Payload, Map<string, CachedAccessToken>>()

const cacheKey = (mode: 'oauth' | 'sa', identifier: string): string => `gbp:${mode}:${identifier}`

const getCachedToken = (payload: Payload, key: string): string | undefined => {
  const cache = tokenCache.get(payload)
  if (!cache) {
    return undefined
  }
  const entry = cache.get(key)
  if (!entry) {
    return undefined
  }
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.token
}

const setCachedToken = (
  payload: Payload,
  key: string,
  token: string,
  expiresInSeconds: number,
): void => {
  let cache = tokenCache.get(payload)
  if (!cache) {
    cache = new Map()
    tokenCache.set(payload, cache)
  }
  const safetyWindowMs = 60_000
  cache.set(key, {
    expiresAtMs: Date.now() + Math.max(safetyWindowMs, expiresInSeconds * 1000 - safetyWindowMs),
    token,
  })
}

const invalidateCachedToken = (payload: Payload, key: string): void => {
  tokenCache.get(payload)?.delete(key)
}

export const clearGbpTokenCache = (payload: Payload): void => {
  tokenCache.delete(payload)
}

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

type GoogleTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  token_type: 'Bearer'
}

export const refreshGbpAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<null | string> => {
  const cfg = options.platforms.gbp
  const credentials = await getCredentials(payload, options, 'gbp')
  if (!credentials?.refreshToken) {
    return null
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    return null
  }

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
  })

  const response = await policyFetch({
    config: options.rateLimit,
    init: {
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    input: OAUTH_TOKEN_URL,
    payload,
    scope: 'gbp:oauth',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err = new PlatformApiError({
      message: `GBP OAuth refresh failed: ${response.status}`,
      platform: 'gbp',
      retryable: response.status >= 500,
      statusCode: response.status === 401 ? 401 : 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, 'gbp', err)
    throw err
  }

  const data = (await response.json()) as GoogleTokenResponse
  if (!data.access_token) {
    throw new PlatformApiError({
      message: 'GBP OAuth refresh returned no access_token',
      platform: 'gbp',
      retryable: false,
      statusCode: 502,
    })
  }

  await saveCredentials(payload, options, 'gbp', {
    accessToken: data.access_token,
    // OAuth refresh tokens for Google are NOT rotated on refresh — preserve
    // the existing one unless Google explicitly returned a new value.
    accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    refreshToken: data.refresh_token,
    scopes: data.scope
      ? data.scope
          .split(' ')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    updateAccount: false,
  })

  setCachedToken(payload, cacheKey('oauth', cfg.clientId), data.access_token, data.expires_in)
  return data.access_token
}

// ---------------------------------------------------------------------------
// Service-account JWT bearer flow
// ---------------------------------------------------------------------------

const base64UrlEncode = (input: Buffer | string): string => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

const signServiceAccountJwt = (serviceAccount: {
  clientEmail: string
  impersonate?: string
  privateKey: string
}): string => {
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims: Record<string, unknown> = {
    aud: OAUTH_TOKEN_URL,
    exp: now + 3600,
    iat: now,
    iss: serviceAccount.clientEmail,
    scope: SA_SCOPE,
  }
  if (serviceAccount.impersonate) {
    claims.sub = serviceAccount.impersonate
  }

  const payload = base64UrlEncode(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`

  // Private key is typically PEM-formatted. Buffers/JWT libraries unescape
  // literal `\n` sequences; we do the same here for env-var-supplied keys.
  const pem = serviceAccount.privateKey.includes('\\n')
    ? serviceAccount.privateKey.replace(/\\n/g, '\n')
    : serviceAccount.privateKey

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(pem)
  return `${signingInput}.${base64UrlEncode(signature)}`
}

const mintServiceAccountAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<null | string> => {
  const sa = options.platforms.gbp.serviceAccount
  if (!sa) {
    return null
  }

  const assertion = signServiceAccountJwt(sa)
  const body = new URLSearchParams({
    assertion,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  })

  const response = await policyFetch({
    config: options.rateLimit,
    init: {
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    input: OAUTH_TOKEN_URL,
    payload,
    scope: 'gbp:oauth',
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err = new PlatformApiError({
      message: `GBP service-account JWT exchange failed: ${response.status}`,
      platform: 'gbp',
      retryable: response.status >= 500,
      statusCode: response.status === 401 ? 401 : 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, 'gbp', err)
    throw err
  }

  const data = (await response.json()) as GoogleTokenResponse
  if (!data.access_token) {
    throw new PlatformApiError({
      message: 'GBP service-account JWT returned no access_token',
      platform: 'gbp',
      retryable: false,
      statusCode: 502,
    })
  }

  setCachedToken(payload, cacheKey('sa', sa.clientEmail), data.access_token, data.expires_in)
  return data.access_token
}

// ---------------------------------------------------------------------------
// Public: get the current access token (OAuth preferred, SA fallback)
// ---------------------------------------------------------------------------

export const getGbpAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<string> => {
  const cfg = options.platforms.gbp

  // Try OAuth first when configured AND a refresh token exists.
  if (cfg.clientId && cfg.clientSecret) {
    const oauthKey = cacheKey('oauth', cfg.clientId)
    const cached = getCachedToken(payload, oauthKey)
    if (cached) {
      return cached
    }

    const oauthCreds = await getCredentials(payload, options, 'gbp')
    if (oauthCreds?.refreshToken) {
      const token = await refreshGbpAccessToken(payload, options)
      if (token) {
        return token
      }
    }
  }

  // Service-account fallback.
  if (cfg.serviceAccount) {
    const saKey = cacheKey('sa', cfg.serviceAccount.clientEmail)
    const cached = getCachedToken(payload, saKey)
    if (cached) {
      return cached
    }
    const token = await mintServiceAccountAccessToken(payload, options)
    if (token) {
      return token
    }
  }

  throw new PlatformApiError({
    message: 'No GBP access token available — connect via OAuth or configure a service account.',
    platform: 'gbp',
    retryable: false,
    statusCode: 401,
    upstreamCode: 'no_credentials',
  })
}

// ---------------------------------------------------------------------------
// Request helper (retries 408/425/429/5xx with exponential backoff + jitter)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const parseRetryAfter = (headerValue: null | string): null | number => {
  if (!headerValue) {
    return null
  }
  const numeric = Number(headerValue)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric)
  }
  const asDate = Date.parse(headerValue)
  if (!Number.isNaN(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000)
    return seconds > 0 ? seconds : null
  }
  return null
}

const computeBackoffMs = (
  attempt: number,
  base: number,
  cap: number,
  jitterFactor: number,
): number => {
  const exponential = Math.min(cap, base * 2 ** attempt)
  const jitter = exponential * jitterFactor * Math.random()
  return Math.floor(exponential + jitter)
}

export type GbpRequestOptions = {
  init?: RequestInit
  maxRetries?: number
}

export const makeGbpRequest = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  url: string,
  requestOptions: GbpRequestOptions = {},
): Promise<Response> => {
  const log = createPluginLogger(payload.logger, { platform: 'gbp', url })
  const rl = options.rateLimit
  const maxRetries = requestOptions.maxRetries ?? rl.maxRetries
  const safeToRetry = isSafeToRetryRequest(requestOptions.init)
  let attempt = 0
  let didRefresh = false

  while (true) {
    const accessToken = await getGbpAccessToken(payload, options)
    const init: RequestInit = {
      ...requestOptions.init,
      headers: {
        Accept: 'application/json',
        ...(requestOptions.init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    }
    let response: Response
    try {
      response = await policyFetch({
        config: options.rateLimit,
        init,
        input: url,
        payload,
        scope: 'gbp',
      })
    } catch (error) {
      if (safeToRetry && isRetryableNetworkError(error) && attempt < maxRetries) {
        const delayMs = computeBackoffMs(
          attempt,
          rl.baseRetryDelayMs,
          rl.maxRetryDelayMs,
          rl.jitterFactor,
        )
        log.warn(`GBP network failure; backing off ${delayMs}ms`, { attempt })
        await sleep(delayMs)
        attempt++
        continue
      }
      throw new PlatformApiError({
        message: 'GBP request failed before receiving a response',
        outcome: safeToRetry ? 'failed' : 'unknown',
        platform: 'gbp',
        raw: error,
        retryable: safeToRetry && isRetryableNetworkError(error),
        statusCode: 502,
        upstreamCode: error instanceof Error ? error.name : 'network_error',
        upstreamMessage: error instanceof Error ? error.message : String(error),
      })
    }
    if (response.ok) {
      return response
    }

    if (response.status === 401 && !didRefresh) {
      // Cached token might be stale — clear cache + retry once.
      const cfg = options.platforms.gbp
      if (cfg.clientId) {
        invalidateCachedToken(payload, cacheKey('oauth', cfg.clientId))
      }
      if (cfg.serviceAccount) {
        invalidateCachedToken(payload, cacheKey('sa', cfg.serviceAccount.clientEmail))
      }
      didRefresh = true
      continue
    }

    if (
      (safeToRetry || response.status === 429) &&
      RETRYABLE_STATUS_CODES.has(response.status) &&
      attempt < maxRetries
    ) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const delayMs =
        retryAfter !== null
          ? retryAfter * 1000
          : computeBackoffMs(attempt, rl.baseRetryDelayMs, rl.maxRetryDelayMs, rl.jitterFactor)
      log.warn(`GBP ${response.status}; backing off ${delayMs}ms`, { attempt })
      await sleep(delayMs)
      attempt++
      continue
    }

    return response
  }
}

/** JSON convenience — throws PlatformApiError on non-2xx. */
export const gbpJson = async <T>(
  payload: Payload,
  options: NormalizedPluginOptions,
  url: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await makeGbpRequest(payload, options, url, { init })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let upstream: unknown = text
    try {
      upstream = JSON.parse(text) as unknown
    } catch {
      /* keep raw */
    }
    const errorBody =
      typeof upstream === 'object' && upstream !== null && 'error' in upstream
        ? (upstream as { error?: Record<string, unknown> }).error
        : undefined
    const safeToRetry = isSafeToRetryRequest(init)
    const outcome =
      !safeToRetry && response.status !== 429 && RETRYABLE_STATUS_CODES.has(response.status)
        ? 'unknown'
        : 'failed'
    throw new PlatformApiError({
      message: `GBP ${url} failed: ${response.status}`,
      outcome,
      platform: 'gbp',
      raw: upstream,
      retryable: outcome === 'failed' && RETRYABLE_STATUS_CODES.has(response.status),
      statusCode: response.status,
      upstreamCode: typeof errorBody?.status === 'string' ? errorBody.status : response.status,
      upstreamMessage: typeof errorBody?.message === 'string' ? errorBody.message : text,
    })
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
