import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import {
  PINTEREST_RETRY_AFTER_CAP_SEC,
  PINTEREST_TOKEN_REFRESH_LOCK_TTL_MS,
  RETRYABLE_STATUS_CODES,
} from '../../../constants.js'
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
 * Pinterest HTTP client with token caching and bounded retry policy.
 *
 *   1. **Access-token cache.** The access token is cached in process memory keyed
 *      by `(payload instance, environment)`, valid for `expires_in - 60s`.
 *      Falls back to a fresh refresh on cache miss or 401.
 *
 *   2. **Structured retry.** Safe methods honor retryable statuses; mutation
 *      requests retry explicit throttling only. Ambiguous writes are surfaced
 *      without replay.
 *
 * Retry-After remains clamped to 1..30 seconds.
 */

const PROD_BASE = 'https://api.pinterest.com'
const SANDBOX_BASE = 'https://api-sandbox.pinterest.com'

export const getPinterestApiBase = (environment: 'production' | 'sandbox'): string =>
  environment === 'sandbox' ? SANDBOX_BASE : PROD_BASE

type CachedAccessToken = { expiresAtMs: number; token: string }
const tokenCache = new WeakMap<Payload, Map<string, CachedAccessToken>>()
const refreshPromises = new WeakMap<Payload, Map<string, Promise<string>>>()

const cacheKey = (options: NormalizedPluginOptions): string =>
  `pinterest:${options.platforms.pinterest.environment}`

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
  // Refresh 60s before stated expiry to avoid edge-of-window 401s.
  const safetyWindowMs = 60_000
  const expiresAtMs =
    Date.now() + Math.max(safetyWindowMs, expiresInSeconds * 1000 - safetyWindowMs)
  cache.set(key, { expiresAtMs, token })
}

const invalidateCachedToken = (payload: Payload, key: string): void => {
  tokenCache.get(payload)?.delete(key)
}

export const clearPinterestTokenCache = (payload: Payload): void => {
  tokenCache.delete(payload)
  refreshPromises.delete(payload)
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

const refreshPinterestAccessTokenUnlocked = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<string> => {
  const cfg = options.platforms.pinterest
  const credentials = await getCredentials(payload, options, 'pinterest')
  if (!credentials?.refreshToken) {
    throw new PlatformApiError({
      message: 'No Pinterest refresh token available — reconnect the account.',
      platform: 'pinterest',
      retryable: false,
      statusCode: 401,
      upstreamCode: 'no_refresh_token',
    })
  }

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_on: 'true',
    refresh_token: credentials.refreshToken,
  })

  const response = await policyFetch({
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

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err = new PlatformApiError({
      message: `Pinterest refresh failed: ${response.status}`,
      platform: 'pinterest',
      raw: text,
      retryable: response.status >= 500,
      statusCode: response.status === 401 ? 401 : 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, 'pinterest', err)
    throw err
  }

  const data = (await response.json()) as PinterestTokenResponse
  if (!data.access_token) {
    throw new PlatformApiError({
      message: 'Pinterest refresh returned no access_token',
      platform: 'pinterest',
      raw: data,
      retryable: false,
      statusCode: 502,
    })
  }

  // Continuous-refresh tokens may rotate the refresh_token. Always persist
  // the most recent one even when only access_token would have sufficed.
  await saveCredentials(payload, options, 'pinterest', {
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt:
      data.refresh_token_expires_at !== undefined
        ? new Date(data.refresh_token_expires_at * 1000).toISOString()
        : data.refresh_token_expires_in !== undefined
          ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
          : undefined,
    scopes: data.scope
      ? data.scope
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    updateAccount: false,
  })

  setCachedToken(payload, cacheKey(options), data.access_token, data.expires_in)
  return data.access_token
}

export const refreshPinterestAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<string> => {
  const run = () => refreshPinterestAccessTokenUnlocked(payload, options)
  const withLock = options.coordination?.withLock
  if (!withLock) {
    return run()
  }
  const cfg = options.platforms.pinterest
  return withLock({
    key: `payload-plugin-socials:pinterest:${cfg.environment}:${cfg.clientId}:token-refresh`,
    run,
    ttlMs: PINTEREST_TOKEN_REFRESH_LOCK_TTL_MS,
  })
}

export const getAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<string> => {
  const key = cacheKey(options)
  const cached = getCachedToken(payload, key)
  if (cached) {
    return cached
  }
  let byKey = refreshPromises.get(payload)
  if (!byKey) {
    byKey = new Map()
    refreshPromises.set(payload, byKey)
  }
  const inFlight = byKey.get(key)
  if (inFlight) {
    return inFlight
  }
  const refresh = refreshPinterestAccessToken(payload, options)
  byKey.set(key, refresh)
  try {
    return await refresh
  } finally {
    byKey.delete(key)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const parseRetryAfter = (headerValue: null | string, fallbackSeconds = 5): number => {
  const numeric = Number(headerValue)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(Math.max(1, Math.floor(numeric)), PINTEREST_RETRY_AFTER_CAP_SEC)
  }
  if (headerValue) {
    const asDate = Date.parse(headerValue)
    if (!Number.isNaN(asDate)) {
      const seconds = Math.ceil((asDate - Date.now()) / 1000)
      return Math.min(Math.max(1, seconds), PINTEREST_RETRY_AFTER_CAP_SEC)
    }
  }
  return Math.min(Math.max(1, fallbackSeconds), PINTEREST_RETRY_AFTER_CAP_SEC)
}

export type PinterestRequestOptions = {
  /** Override the base fetch init (headers, body, etc.). */
  init?: RequestInit
  /** Maximum retry attempts for failures eligible under the request policy. */
  maxRetries?: number
}

/**
 * Make an authenticated Pinterest API request. Handles token refresh on
 * 401 token refresh plus request-policy-controlled retries.
 */
export const makePinterestRequest = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  path: string,
  requestOptions: PinterestRequestOptions = {},
): Promise<Response> => {
  const log = createPluginLogger(payload.logger, { path, platform: 'pinterest' })
  const cfg = options.platforms.pinterest
  const apiBase = getPinterestApiBase(cfg.environment)
  const maxRetries = requestOptions.maxRetries ?? 1
  const safeToRetry = isSafeToRetryRequest(requestOptions.init)
  let attempt = 0
  let didRefresh = false

  while (true) {
    const accessToken = await getAccessToken(payload, options)
    const init: RequestInit = {
      ...requestOptions.init,
      headers: {
        ...(requestOptions.init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    }
    let response: Response
    try {
      response = await policyFetch({
        config: options.rateLimit,
        init,
        input: `${apiBase}${path}`,
        payload,
        scope: 'pinterest',
      })
    } catch (error) {
      if (safeToRetry && isRetryableNetworkError(error) && attempt < maxRetries) {
        const seconds = parseRetryAfter(null)
        log.warn(`Pinterest network failure; retrying in ${seconds}s`, { attempt })
        await sleep(seconds * 1000)
        attempt++
        continue
      }
      throw new PlatformApiError({
        message: 'Pinterest request failed before receiving a response',
        outcome: safeToRetry ? 'failed' : 'unknown',
        platform: 'pinterest',
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
      // Cached token might be stale — force a refresh and retry once.
      invalidateCachedToken(payload, cacheKey(options))
      didRefresh = true
      continue
    }

    if (
      (safeToRetry || response.status === 429) &&
      RETRYABLE_STATUS_CODES.has(response.status) &&
      attempt < maxRetries
    ) {
      const seconds = parseRetryAfter(response.headers.get('retry-after'))
      log.warn(`Pinterest ${response.status}; honoring Retry-After=${seconds}s`)
      await sleep(seconds * 1000)
      attempt++
      continue
    }

    return response
  }
}

/** JSON convenience wrapper — throws PlatformApiError on non-2xx. */
export const pinterestJson = async <T>(
  payload: Payload,
  options: NormalizedPluginOptions,
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await makePinterestRequest(payload, options, path, { init })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let upstream: unknown = text
    try {
      upstream = JSON.parse(text) as unknown
    } catch {
      /* keep raw text */
    }
    const safeToRetry = isSafeToRetryRequest(init)
    const outcome =
      !safeToRetry && response.status !== 429 && RETRYABLE_STATUS_CODES.has(response.status)
        ? 'unknown'
        : 'failed'
    throw new PlatformApiError({
      message: `Pinterest ${path} failed: ${response.status}`,
      outcome,
      platform: 'pinterest',
      raw: upstream,
      retryable: outcome === 'failed' && RETRYABLE_STATUS_CODES.has(response.status),
      statusCode: response.status,
      upstreamCode:
        typeof upstream === 'object' && upstream !== null && 'code' in upstream
          ? (upstream as { code?: number }).code
          : response.status,
      upstreamMessage:
        typeof upstream === 'object' && upstream !== null && 'message' in upstream
          ? String((upstream as { message?: unknown }).message)
          : text,
    })
  }
  return (await response.json()) as T
}
