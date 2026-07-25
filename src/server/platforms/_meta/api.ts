import type { Payload } from 'payload'

import { createHmac } from 'node:crypto'

import type {
  NormalizedFacebookConfig,
  NormalizedPluginOptions,
  PlatformId,
} from '../../../types/index.js'

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
import { sleep } from '../../utilities/sleep.js'

/**
 * Shared HTTP client for the Meta Graph API surface — used by both the
 * Instagram and Facebook adapters because Meta exposes both products on the
 * same host (`graph.facebook.com`) with the same auth model.
 *
 * Auth precedence:
 *
 *   1. System user access token from plugin config (preferred for backend
 *      deployments). Either platform may have its own.
 *   2. Long-lived user access token persisted in the `socials-connections`
 *      global (60-day expiry; refreshed via `fb_exchange_token`).
 *
 * Wire-format niceties:
 *
 *   - `appsecret_proof` header (HMAC-SHA256 of token with app_secret) is
 *     attached automatically when the app has `clientSecret` set. Required
 *     when "Require App Secret" is enabled on the Meta app dashboard.
 *   - API version pin: every URL is prefixed with `/v{version}/`. Default
 *     `v25.0`; configurable per-platform.
 *   - `X-App-Usage` and `X-Business-Use-Case-Usage` are parsed when present
 *     and surfaced to the logger so ops can watch for quota burn.
 *   - 400 + error code 190 → invalidate cached token and retry once.
 *   - 4/17/32/613/800xx → exponential backoff w/ jitter, capped retries.
 */

const GRAPH_HOST = 'https://graph.facebook.com'

type MetaPlatform = Extract<PlatformId, 'facebook' | 'instagram'>

type MetaPlatformConfig = NormalizedFacebookConfig

const getPlatformConfig = (
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): MetaPlatformConfig =>
  platform === 'instagram' ? options.platforms.instagram : options.platforms.facebook

// ---------------------------------------------------------------------------
// Access-token cache
// ---------------------------------------------------------------------------

type CachedAccessToken = { expiresAtMs: number; token: string }
const tokenCache = new WeakMap<Payload, Map<string, CachedAccessToken>>()

const cacheKey = (platform: MetaPlatform, tokenKind: 'system' | 'user'): string =>
  `meta:${platform}:${tokenKind}`

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
  // 60s safety buffer before expiry — same pattern as Pinterest/GBP.
  const safetyWindowMs = 60_000
  cache.set(key, {
    expiresAtMs: Date.now() + Math.max(safetyWindowMs, expiresInSeconds * 1000 - safetyWindowMs),
    token,
  })
}

const invalidateCachedToken = (payload: Payload, key: string): void => {
  tokenCache.get(payload)?.delete(key)
}

export const clearMetaTokenCache = (payload: Payload, platform: MetaPlatform): void => {
  invalidateCachedToken(payload, cacheKey(platform, 'system'))
  invalidateCachedToken(payload, cacheKey(platform, 'user'))
}

const SYSTEM_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 365 * 5 // 5 years; treated as never-expires.

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

type LongLivedUserTokenResponse = {
  access_token: string
  expires_in?: number
  token_type: 'bearer'
}

const exchangeForLongLivedUserToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> => {
  const cfg = getPlatformConfig(options, platform)
  const params = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    fb_exchange_token: shortLivedToken,
    grant_type: 'fb_exchange_token',
  })
  const url = `${GRAPH_HOST}/${cfg.apiVersion}/oauth/access_token?${params.toString()}`
  const response = await policyFetch({
    config: options.rateLimit,
    init: { method: 'GET' },
    input: url,
    payload,
    scope: `meta:${platform}:oauth`,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err = new PlatformApiError({
      message: `Meta long-lived token exchange failed: ${response.status}`,
      platform,
      retryable: false,
      statusCode: response.status === 401 ? 401 : 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
    await recordConnectionError(payload, platform, err)
    throw err
  }
  const data = (await response.json()) as LongLivedUserTokenResponse
  if (!data.access_token) {
    throw new PlatformApiError({
      message: 'Meta long-lived token exchange returned no access_token',
      platform,
      retryable: false,
      statusCode: 502,
    })
  }
  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in ?? 60 * 60 * 24 * 60, // 60 days fallback
  }
}

/**
 * Refresh the stored user access token. Meta long-lived tokens DON'T have a
 * refresh-token concept — the existing token is re-exchanged
 * long-lived token before it expires to extend the window.
 */
const refreshUserAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Promise<null | string> => {
  const credentials = await getCredentials(payload, options, platform)
  if (!credentials?.accessToken) {
    return null
  }

  const { accessToken, expiresInSeconds } = await exchangeForLongLivedUserToken(
    payload,
    options,
    platform,
    credentials.accessToken,
  )

  const expiresAtIso = new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  await saveCredentials(payload, options, platform, {
    accessToken,
    accessTokenExpiresAt: expiresAtIso,
    updateAccount: false,
  })

  setCachedToken(payload, cacheKey(platform, 'user'), accessToken, expiresInSeconds)
  return accessToken
}

export const refreshMetaAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Promise<null | string> => refreshUserAccessToken(payload, options, platform)

/**
 * Returns the best available access token for the platform.
 *
 * Order:
 *   1. System user token from plugin config (cached forever)
 *   2. User token from persisted credentials (cached until 60s before expiry)
 *   3. Refresh path (re-exchange long-lived token)
 *
 * Throws `PlatformApiError(401)` if no credentials are available.
 */
export const getMetaAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Promise<string> => {
  const cfg = getPlatformConfig(options, platform)

  if (cfg.systemUserAccessToken) {
    const key = cacheKey(platform, 'system')
    let cached = getCachedToken(payload, key)
    if (!cached) {
      cached = cfg.systemUserAccessToken
      setCachedToken(payload, key, cached, SYSTEM_TOKEN_LIFETIME_SECONDS)
    }
    return cached
  }

  const userKey = cacheKey(platform, 'user')
  const cachedUser = getCachedToken(payload, userKey)
  if (cachedUser) {
    return cachedUser
  }

  const credentials = await getCredentials(payload, options, platform)
  if (credentials?.accessToken) {
    // If we have a stored access token and a meaningful expiry, prefer it.
    const expiresAt = credentials.accessTokenExpiresAt
      ? Date.parse(credentials.accessTokenExpiresAt)
      : NaN
    if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
      const seconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
      setCachedToken(payload, userKey, credentials.accessToken, seconds)
      return credentials.accessToken
    }
  }

  const refreshed = await refreshUserAccessToken(payload, options, platform)
  if (refreshed) {
    return refreshed
  }

  throw new PlatformApiError({
    message: `No Meta access token available for ${platform} — connect via OAuth or configure a system-user token.`,
    platform,
    retryable: false,
    statusCode: 401,
    upstreamCode: 'no_credentials',
  })
}

// ---------------------------------------------------------------------------
// appsecret_proof
// ---------------------------------------------------------------------------

const computeAppsecretProof = (accessToken: string, appSecret: string): string =>
  createHmac('sha256', appSecret).update(accessToken).digest('hex')

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

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

const TOKEN_EXPIRED_CODE = 190
const TOKEN_EXPIRED_SUBCODES = new Set([460, 463, 467, 492])

type MetaError = {
  code?: number
  error_subcode?: number
  fbtrace_id?: string
  message?: string
  type?: string
}

type MetaErrorEnvelope = { error?: MetaError }

const parseUsageHeader = (raw: null | string): null | Record<string, unknown> => {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

const isRetryableMetaError = (status: number, errorCode?: number): boolean => {
  if (RETRYABLE_STATUS_CODES.has(status)) {
    return true
  }
  if (errorCode === 4 || errorCode === 17 || errorCode === 32 || errorCode === 613) {
    return true
  }
  // 80000–80008 are BUC throttles.
  if (errorCode !== undefined && errorCode >= 80000 && errorCode <= 80099) {
    return true
  }
  return false
}

export type MetaRequestOptions = {
  /** Use an explicitly scoped token (for example a Facebook Page token). */
  accessToken?: string
  /** Override the underlying fetch init. */
  init?: RequestInit
  /** Override retry count. Default = options.rateLimit.maxRetries. */
  maxRetries?: number
  /** When true, do not attach `appsecret_proof`. Useful for `/oauth/*` calls. */
  skipAppsecretProof?: boolean
}

const buildUrl = (
  cfg: MetaPlatformConfig,
  path: string,
  accessToken: string,
  skipAppsecretProof: boolean,
): string => {
  // Allow callers to pass absolute URLs (rare; used for /upload:{session}).
  const isAbsolute = path.startsWith('http://') || path.startsWith('https://')
  const versionedPath = isAbsolute
    ? path
    : `${GRAPH_HOST}/${cfg.apiVersion}${path.startsWith('/') ? path : `/${path}`}`
  const url = new URL(versionedPath)
  // appsecret_proof is most reliable as a query parameter — POST bodies vary
  // (form vs JSON vs multipart) and Meta's parser sometimes misses it in
  // header-only mode.
  if (!skipAppsecretProof && cfg.appSecret) {
    url.searchParams.set('appsecret_proof', computeAppsecretProof(accessToken, cfg.appSecret))
  }
  return url.toString()
}

/**
 * Issue an authenticated request against the Meta Graph API.
 *
 * Returns the raw `Response`. Caller decides how to parse — many Graph
 * endpoints return 200 with embedded `{error: ...}` envelopes for partial
 * failures, so callers should always inspect both status AND body.
 */
export const makeMetaRequest = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
  path: string,
  requestOptions: MetaRequestOptions = {},
): Promise<Response> => {
  const cfg = getPlatformConfig(options, platform)
  const log = createPluginLogger(payload.logger, { path, platform })
  const rl = options.rateLimit
  const maxRetries = requestOptions.maxRetries ?? rl.maxRetries
  const safeToRetry = isSafeToRetryRequest(requestOptions.init)
  let attempt = 0
  let didRefresh = false

  while (true) {
    const accessToken =
      requestOptions.accessToken ?? (await getMetaAccessToken(payload, options, platform))
    const url = buildUrl(cfg, path, accessToken, requestOptions.skipAppsecretProof ?? false)

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
        config: rl,
        init,
        input: url,
        payload,
        scope: `meta:${platform}`,
      })
    } catch (error) {
      if (safeToRetry && isRetryableNetworkError(error) && attempt < maxRetries) {
        const delayMs = computeBackoffMs(
          attempt,
          rl.baseRetryDelayMs,
          rl.maxRetryDelayMs,
          rl.jitterFactor,
        )
        log.warn(`Meta network failure; backing off ${delayMs}ms`, { attempt })
        await sleep(delayMs)
        attempt++
        continue
      }
      throw new PlatformApiError({
        message: `Meta ${path} failed before receiving a response`,
        outcome: safeToRetry ? 'failed' : 'unknown',
        platform,
        raw: error,
        retryable: safeToRetry && isRetryableNetworkError(error),
        statusCode: 502,
        upstreamCode: error instanceof Error ? error.name : 'network_error',
        upstreamMessage: error instanceof Error ? error.message : String(error),
      })
    }

    // Watch quota burn — log if any usage header crosses 75%.
    const appUsage = parseUsageHeader(response.headers.get('x-app-usage'))
    const bucUsage = parseUsageHeader(response.headers.get('x-business-use-case-usage'))
    if (appUsage || bucUsage) {
      const callCount =
        (appUsage?.call_count as number | undefined) ??
        ((bucUsage &&
          (Object.values(bucUsage)[0] as Array<Record<string, unknown>> | undefined))?.[0]
          ?.call_count as number | undefined)
      if (typeof callCount === 'number' && callCount >= 75) {
        log.warn(`Meta quota at ${callCount}%`, { appUsage, bucUsage })
      }
    }

    if (response.ok) {
      return response
    }

    // Try to parse the error envelope to make smart retry decisions.
    let errorEnvelope: MetaErrorEnvelope = {}
    let bodyText = ''
    try {
      bodyText = await response.clone().text()
      errorEnvelope = JSON.parse(bodyText) as MetaErrorEnvelope
    } catch {
      /* keep raw text */
    }
    const errorCode = errorEnvelope.error?.code
    const errorSubcode = errorEnvelope.error?.error_subcode

    // Token expired → invalidate cache and retry once.
    if (
      !requestOptions.accessToken &&
      !didRefresh &&
      errorCode === TOKEN_EXPIRED_CODE &&
      (errorSubcode === undefined || TOKEN_EXPIRED_SUBCODES.has(errorSubcode))
    ) {
      invalidateCachedToken(payload, cacheKey(platform, 'user'))
      invalidateCachedToken(payload, cacheKey(platform, 'system'))
      didRefresh = true
      continue
    }

    if (
      (safeToRetry || response.status === 429) &&
      isRetryableMetaError(response.status, errorCode) &&
      attempt < maxRetries
    ) {
      const delayMs = computeBackoffMs(
        attempt,
        rl.baseRetryDelayMs,
        rl.maxRetryDelayMs,
        rl.jitterFactor,
      )
      log.warn(`Meta ${response.status} (code ${String(errorCode)}); backing off ${delayMs}ms`, {
        attempt,
        fbtrace_id: errorEnvelope.error?.fbtrace_id,
      })
      await sleep(delayMs)
      attempt++
      continue
    }

    // Re-attach a body so the caller can read it.
    return new Response(bodyText, { headers: response.headers, status: response.status })
  }
}

/** JSON convenience — throws PlatformApiError on non-2xx. */
export const metaJson = async <T>(
  payload: Payload,
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
  path: string,
  init?: RequestInit,
  requestOptions?: Omit<MetaRequestOptions, 'init'>,
): Promise<T> => {
  const response = await makeMetaRequest(payload, options, platform, path, {
    ...requestOptions,
    init,
  })
  let parsed: unknown
  let text = ''
  try {
    text = await response.text()
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = undefined
  }

  const envelope = parsed && typeof parsed === 'object' ? (parsed as MetaErrorEnvelope) : {}
  const embeddedError = envelope.error
  if (!response.ok) {
    const error = embeddedError
    const safeToRetry = isSafeToRetryRequest(init)
    const outcome =
      !safeToRetry && response.status !== 429 && isRetryableMetaError(response.status, error?.code)
        ? 'unknown'
        : 'failed'
    throw new PlatformApiError({
      message: `Meta ${path} failed: ${response.status}${error?.message ? ` — ${error.message}` : ''}`,
      outcome,
      platform,
      raw: { ...envelope, fbtrace_id: error?.fbtrace_id },
      retryable: outcome === 'failed' && isRetryableMetaError(response.status, error?.code),
      statusCode: response.status,
      upstreamCode: error?.code ?? response.status,
      upstreamMessage: error?.message ?? text,
    })
  }
  if (embeddedError) {
    throw new PlatformApiError({
      message: `Meta ${path} returned an embedded error${embeddedError.message ? ` — ${embeddedError.message}` : ''}`,
      platform,
      raw: { ...envelope, fbtrace_id: embeddedError.fbtrace_id },
      retryable: isRetryableMetaError(response.status, embeddedError.code),
      statusCode: 502,
      upstreamCode: embeddedError.code ?? 'embedded_error',
      upstreamMessage: embeddedError.message,
    })
  }
  if (parsed === undefined) {
    throw new PlatformApiError({
      message: `Meta ${path} returned invalid JSON`,
      platform,
      retryable: false,
      statusCode: 502,
      upstreamMessage: text,
    })
  }
  return parsed as T
}
