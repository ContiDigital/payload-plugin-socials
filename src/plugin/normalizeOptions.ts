import type {
  AdminMode,
  FacebookPluginConfig,
  GbpPluginConfig,
  InstagramPluginConfig,
  NormalizedAssetsConfig,
  NormalizedFacebookConfig,
  NormalizedGbpConfig,
  NormalizedPinterestConfig,
  NormalizedPluginOptions,
  NormalizedSchedulingConfig,
  PayloadPluginSocialsConfig,
  PinterestPluginConfig,
  SocialCopyFieldTransforms,
  SocialsAdminConfig,
  SocialsAssetsConfig,
  SocialsMediaLibraryConfig,
  SocialsSchedulingConfig,
  SocialsTransformations,
} from '../types/index.js'

import {
  DEFAULT_ADMIN_NAV_LABEL,
  DEFAULT_ADMIN_ROUTE_PATH,
  DEFAULT_API_BASE_PATH,
  DEFAULT_ASSET_FETCH_TIMEOUT_MS,
  DEFAULT_BASE_RETRY_DELAY_MS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_CONCURRENT_CONVERSIONS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_PINTEREST_VIDEO_UPLOAD_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_ENABLED,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_JITTER_FACTOR,
  MAX_SOURCE_IMAGE_BYTES,
  PLUGIN_SLUG,
  SOCIALS_QUEUE_NAME,
} from '../constants.js'
import { coerceEncryptionKey } from '../server/utilities/encryption.js'
import { SOCIAL_COPY_FIELD_KEYS } from '../types/index.js'

const ONE_DAY_SECONDS = 24 * 60 * 60
const THIRTY_DAYS_SECONDS = 30 * ONE_DAY_SECONDS

const normalizeScheduling = (
  config: SocialsSchedulingConfig | undefined,
): NormalizedSchedulingConfig => {
  const out: NormalizedSchedulingConfig = {
    connectionRefreshWindowSeconds: normalizePositiveInteger(
      config?.connectionRefreshWindowSeconds,
      ONE_DAY_SECONDS,
    ),
    drainBatchSize: normalizePositiveInteger(config?.drainBatchSize, 100),
    insightsRefreshWindowSeconds: normalizePositiveInteger(
      config?.insightsRefreshWindowSeconds,
      THIRTY_DAYS_SECONDS,
    ),
    internalApiKey: config?.internalApiKey?.trim() || undefined,
    queue: normalizeNonEmptyString(config?.queue, SOCIALS_QUEUE_NAME),
    sweepBatchSize: normalizePositiveInteger(config?.sweepBatchSize, 100),
  }
  // Register the autoRun block when ANY cron is present — each of the three
  // crons attaches an independent Payload task `schedule`, so setting only the
  // refresh crons (without a sweep cron) must not silently drop the whole block.
  const auto = config?.autoRun
  if (auto && (auto.cron || auto.insightsRefreshCron || auto.connectionRefreshCron)) {
    out.autoRun = {
      connectionRefreshCron: auto.connectionRefreshCron,
      cron: auto.cron,
      insightsRefreshCron: auto.insightsRefreshCron,
    }
  }
  return out
}

const normalizeAssets = (config: SocialsAssetsConfig | undefined): NormalizedAssetsConfig => {
  const preflight = config?.preflight !== false
  const autoConvert = config?.autoConvert === true
  const renditionCollection = config?.renditionCollection?.trim() || undefined

  if (autoConvert && !renditionCollection) {
    throw new Error(
      `${PLUGIN_SLUG}: assets.autoConvert requires assets.renditionCollection to be set`,
    )
  }

  const normalize = config?.normalize === true
  if (normalize && !autoConvert) {
    throw new Error(`${PLUGIN_SLUG}: assets.normalize requires assets.autoConvert to be enabled`)
  }

  const rawQuality = config?.jpegQuality
  let jpegQuality = 82
  if (typeof rawQuality === 'number' && Number.isFinite(rawQuality)) {
    jpegQuality = Math.max(1, Math.min(100, Math.round(rawQuality)))
  }

  const renditionData = config?.renditionData ?? {}
  if (typeof renditionData !== 'object' || renditionData === null || Array.isArray(renditionData)) {
    throw new Error(`${PLUGIN_SLUG}: assets.renditionData must be a plain object`)
  }

  const trustedRemoteHosts = Array.from(
    new Set(
      (config?.trustedRemoteHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    ),
  )
  for (const host of trustedRemoteHosts) {
    if (host.includes('/') || host.includes(':') || host === 'localhost') {
      throw new Error(
        `${PLUGIN_SLUG}: assets.trustedRemoteHosts must contain exact DNS hostnames without ports`,
      )
    }
  }

  return {
    autoConvert,
    jpegQuality,
    maxConcurrentConversions: normalizePositiveInteger(
      config?.maxConcurrentConversions,
      DEFAULT_MAX_CONCURRENT_CONVERSIONS,
    ),
    maxSourceImageBytes: normalizePositiveInteger(
      config?.maxSourceImageBytes,
      MAX_SOURCE_IMAGE_BYTES,
    ),
    normalize,
    preflight,
    remoteFetchTimeoutMs: normalizePositiveInteger(
      config?.remoteFetchTimeoutMs,
      DEFAULT_ASSET_FETCH_TIMEOUT_MS,
    ),
    renditionCollection,
    renditionData: { ...renditionData },
    trustedRemoteHosts,
  }
}

const normalizeMediaLibrary = (
  config: SocialsMediaLibraryConfig | undefined,
): SocialsMediaLibraryConfig | undefined => {
  if (!config) {
    return undefined
  }
  const collectionSlugs = Array.from(
    new Set((config.collectionSlugs ?? []).map((slug) => slug.trim()).filter(Boolean)),
  )
  const out: SocialsMediaLibraryConfig = {}
  if (collectionSlugs.length > 0) {
    out.collectionSlugs = collectionSlugs
  }
  if (config.filterOptions && typeof config.filterOptions === 'object') {
    out.filterOptions = config.filterOptions
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// Transformations normalizer
// ---------------------------------------------------------------------------

const isValidTransformValue = (value: unknown): value is ((ctx: unknown) => unknown) | string => {
  if (typeof value === 'function') {
    return true
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return true
  }
  return false
}

const normalizeFieldTransforms = (
  raw: Record<string, unknown> | undefined,
): SocialCopyFieldTransforms => {
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  // Accumulate validated entries into a Partial<SocialCopyFieldTransforms> to
  // avoid a cast at the return site; SOCIAL_COPY_FIELD_KEYS guards unknown keys.
  const out: Partial<SocialCopyFieldTransforms> = {}
  for (const key of SOCIAL_COPY_FIELD_KEYS) {
    const value = raw[key]
    if (!isValidTransformValue(value)) {
      continue
    }
    if (key === 'pinterestHashtags') {
      // pinterestHashtags uses SocialHashtagsTransform (string | fn returning string[])
      out.pinterestHashtags = value as SocialCopyFieldTransforms['pinterestHashtags']
    } else {
      out[key] = value as SocialCopyFieldTransforms[typeof key]
    }
  }
  return Object.freeze(out) as SocialCopyFieldTransforms
}

/**
 * Normalize the operator-supplied `transformations` config option.
 *
 * - Returns `{}` (frozen) when the input is absent or not an object.
 * - Drops any key that is not in `SOCIAL_COPY_FIELD_KEYS` (tolerant).
 * - Drops values that are neither a non-empty string nor a function.
 * - Freezes the top-level map and each per-kind sub-map.
 */
export const normalizeTransformations = (
  input: SocialsTransformations | undefined,
): SocialsTransformations => {
  if (!input || typeof input !== 'object') {
    return Object.freeze({}) as SocialsTransformations
  }

  const result: Record<string, SocialCopyFieldTransforms> = {}

  for (const kind of Object.keys(input)) {
    const raw = (input as Record<string, unknown>)[kind]
    if (raw && typeof raw === 'object') {
      const normalized = normalizeFieldTransforms(raw as Record<string, unknown>)
      // Only include the kind entry if at least one field survived.
      if (Object.keys(normalized).length > 0) {
        result[kind] = normalized
      }
    }
  }

  return Object.freeze(result) as SocialsTransformations
}

// ---------------------------------------------------------------------------
// Primitive normalizers
// ---------------------------------------------------------------------------

const normalizePath = (value: string): `/${string}` => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`
  }
  return trimmed as `/${string}`
}

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.floor(value))
}

const normalizeFloat01 = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.min(1, value))
}

const normalizeNonEmptyString = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback
  }
  return value.trim()
}

const normalizeAdminMode = (value: string | undefined): AdminMode => {
  if (value === 'route' || value === 'dashboard' || value === 'both' || value === 'headless') {
    return value
  }
  return 'route'
}

// ---------------------------------------------------------------------------
// Per-platform normalizers
// ---------------------------------------------------------------------------

const DEFAULT_PINTEREST_SCOPES = [
  'user_accounts:read',
  'pins:read',
  'pins:write',
  'boards:read',
  'boards:write',
] as const

const DEFAULT_INSTAGRAM_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
] as const

const DEFAULT_FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
] as const

const normalizePinterest = (
  config: PinterestPluginConfig | undefined,
): NormalizedPinterestConfig => {
  if (!config || !config.enabled) {
    return {
      allowedVideoHosts: [],
      clientId: '',
      clientSecret: '',
      enabled: false,
      environment: 'production',
      redirectUri: '',
      scopes: DEFAULT_PINTEREST_SCOPES,
      videoUploadTimeoutMs: DEFAULT_PINTEREST_VIDEO_UPLOAD_TIMEOUT_MS,
    }
  }
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error(
      `${PLUGIN_SLUG}: platforms.pinterest requires clientId, clientSecret, and redirectUri when enabled`,
    )
  }
  if (
    config.environment !== undefined &&
    config.environment !== 'production' &&
    config.environment !== 'sandbox'
  ) {
    throw new Error(
      `${PLUGIN_SLUG}: platforms.pinterest.environment must be "production" or "sandbox"`,
    )
  }
  return {
    allowedVideoHosts: Object.freeze(
      (config.allowedVideoHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    ),
    clientId: config.clientId.trim(),
    clientSecret: config.clientSecret,
    enabled: true,
    environment: config.environment === 'sandbox' ? 'sandbox' : 'production',
    redirectUri: config.redirectUri.trim(),
    scopes:
      config.scopes && config.scopes.length > 0
        ? Object.freeze([...config.scopes])
        : DEFAULT_PINTEREST_SCOPES,
    videoUploadTimeoutMs: normalizePositiveInteger(
      config.videoUploadTimeoutMs,
      DEFAULT_PINTEREST_VIDEO_UPLOAD_TIMEOUT_MS,
    ),
  }
}

const normalizeMeta = (
  config: FacebookPluginConfig | InstagramPluginConfig | undefined,
  defaultScopes: readonly string[],
  surfaceName: 'facebook' | 'instagram',
): NormalizedFacebookConfig => {
  if (!config || !config.enabled) {
    return {
      apiVersion: 'v25.0',
      appId: '',
      appSecret: '',
      enabled: false,
      redirectUri: '',
      scopes: defaultScopes,
      systemUserAccessToken: '',
    }
  }
  // Either appId+appSecret (OAuth flow) or systemUserAccessToken must be set.
  const hasOauthCreds = Boolean(config.appId && config.appSecret)
  const hasSystemUserToken = Boolean(config.systemUserAccessToken)
  if (!hasOauthCreds && !hasSystemUserToken) {
    throw new Error(
      `${PLUGIN_SLUG}: platforms.${surfaceName} requires either (appId + appSecret) or systemUserAccessToken when enabled`,
    )
  }
  const apiVersion = normalizeNonEmptyString(config.apiVersion, 'v25.0')
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error(`${PLUGIN_SLUG}: platforms.${surfaceName}.apiVersion must look like "v25.0"`)
  }
  return {
    apiVersion,
    appId: (config.appId ?? '').trim(),
    appSecret: config.appSecret ?? '',
    enabled: true,
    redirectUri: (config.redirectUri ?? '').trim(),
    scopes:
      config.scopes && config.scopes.length > 0 ? Object.freeze([...config.scopes]) : defaultScopes,
    systemUserAccessToken: config.systemUserAccessToken ?? '',
  }
}

const normalizeGbp = (config: GbpPluginConfig | undefined): NormalizedGbpConfig => {
  if (!config || !config.enabled) {
    return {
      clientId: '',
      clientSecret: '',
      enabled: false,
      redirectUri: '',
    }
  }
  const hasOauthCreds = Boolean(config.clientId && config.clientSecret && config.redirectUri)
  const hasServiceAccount = Boolean(
    config.serviceAccount?.clientEmail && config.serviceAccount?.privateKey,
  )
  if (!hasOauthCreds && !hasServiceAccount) {
    throw new Error(
      `${PLUGIN_SLUG}: platforms.gbp requires either (clientId + clientSecret + redirectUri) or serviceAccount.{clientEmail, privateKey} when enabled`,
    )
  }
  return {
    clientId: (config.clientId ?? '').trim(),
    clientSecret: config.clientSecret ?? '',
    enabled: true,
    redirectUri: (config.redirectUri ?? '').trim(),
    serviceAccount: config.serviceAccount
      ? {
          clientEmail: config.serviceAccount.clientEmail.trim(),
          impersonate: config.serviceAccount.impersonate?.trim(),
          privateKey: config.serviceAccount.privateKey,
        }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const normalizePluginOptions = (
  options: PayloadPluginSocialsConfig,
): NormalizedPluginOptions => {
  if (!options.sources || Object.keys(options.sources).length === 0) {
    throw new Error(`${PLUGIN_SLUG}: sources must be a non-empty object mapping kind → resolver`)
  }
  // Disabled mode bypasses secrets and runtime credentials, but schema-driving
  // source kinds remain mandatory so toggling the plugin cannot mutate the
  // social-templates sourceKind select.
  if (options.disabled) {
    return buildNormalizedOptions(options, { disabled: true })
  }

  if (typeof options.authorize !== 'function') {
    throw new Error(`${PLUGIN_SLUG}: authorize must be a function`)
  }
  if (!options.platforms || Object.keys(options.platforms).length === 0) {
    throw new Error(`${PLUGIN_SLUG}: platforms must declare at least one entry`)
  }
  if (!options.encryptionKey) {
    throw new Error(
      `${PLUGIN_SLUG}: encryptionKey is required (32 bytes, hex/base64 string or Buffer)`,
    )
  }
  // Validate encryption key shape immediately so a misconfigured host fails
  // at boot rather than on the first publish.
  coerceEncryptionKey(options.encryptionKey)

  return buildNormalizedOptions(options, { disabled: false })
}

const buildNormalizedOptions = (
  options: PayloadPluginSocialsConfig,
  overrides: { disabled: boolean },
): NormalizedPluginOptions => {
  const adminConfig: SocialsAdminConfig = options.admin ?? {}
  const encryptionKey = overrides.disabled
    ? Buffer.alloc(32)
    : coerceEncryptionKey(options.encryptionKey)
  const previousEncryptionKeys = overrides.disabled
    ? []
    : (options.previousEncryptionKeys ?? [])
        .map(coerceEncryptionKey)
        .filter(
          (key, index, keys) =>
            !key.equals(encryptionKey) &&
            keys.findIndex((candidate) => candidate.equals(key)) === index,
        )
  return {
    admin: {
      // adminBase is populated to '/admin' by default here; applyAdminEnhancements
      // overwrites it with the actual value derived from config.routes.admin.
      adminBase: '/admin',
      injectInto: adminConfig.injectInto ?? [],
      mediaLibrary: normalizeMediaLibrary(adminConfig.mediaLibrary),
      mode: normalizeAdminMode(adminConfig.mode),
      navLabel: normalizeNonEmptyString(adminConfig.navLabel, DEFAULT_ADMIN_NAV_LABEL),
      route: normalizePath(adminConfig.route ?? DEFAULT_ADMIN_ROUTE_PATH),
    },
    api: {
      basePath: normalizePath(options.api?.basePath ?? DEFAULT_API_BASE_PATH),
    },
    assets: normalizeAssets(options.assets),
    authCollection: options.authCollection?.trim() || undefined,
    authorize: options.authorize ?? (() => Promise.resolve(false)),
    coordination: options.coordination ?? {},
    copyOverrides: options.copyOverrides ?? {},
    disabled: overrides.disabled,
    encryptionKey,
    platforms: {
      facebook: normalizeMeta(options.platforms?.facebook, DEFAULT_FACEBOOK_SCOPES, 'facebook'),
      gbp: normalizeGbp(options.platforms?.gbp),
      instagram: normalizeMeta(options.platforms?.instagram, DEFAULT_INSTAGRAM_SCOPES, 'instagram'),
      pinterest: normalizePinterest(options.platforms?.pinterest),
    },
    previousEncryptionKeys,
    rateLimit: {
      acquireRequestLease: options.coordination?.acquireRequestLease,
      baseRetryDelayMs: normalizePositiveInteger(
        options.rateLimit?.baseRetryDelayMs,
        DEFAULT_BASE_RETRY_DELAY_MS,
      ),
      enabled: options.rateLimit?.enabled ?? DEFAULT_RATE_LIMIT_ENABLED,
      jitterFactor: normalizeFloat01(options.rateLimit?.jitterFactor, DEFAULT_RETRY_JITTER_FACTOR),
      maxConcurrency: normalizePositiveInteger(
        options.rateLimit?.maxConcurrency,
        DEFAULT_MAX_CONCURRENCY,
      ),
      maxRequestsPerMinute: normalizePositiveInteger(
        options.rateLimit?.maxRequestsPerMinute,
        DEFAULT_MAX_REQUESTS_PER_MINUTE,
      ),
      maxRetries: normalizeNonNegativeInteger(options.rateLimit?.maxRetries, DEFAULT_MAX_RETRIES),
      maxRetryDelayMs: normalizePositiveInteger(
        options.rateLimit?.maxRetryDelayMs,
        DEFAULT_MAX_RETRY_DELAY_MS,
      ),
      requestTimeoutMs: normalizePositiveInteger(
        options.rateLimit?.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
    },
    scheduling: normalizeScheduling(options.scheduling),
    sources: options.sources ?? {},
    testMode: Boolean(options.testMode),
    transformations: overrides.disabled
      ? (Object.freeze({}) as SocialsTransformations)
      : normalizeTransformations(options.transformations),
    webhooks: options.webhooks?.meta?.verifyToken.trim()
      ? {
          meta: {
            onEvent: options.webhooks.meta.onEvent,
            verifyToken: options.webhooks.meta.verifyToken.trim(),
          },
        }
      : {},
  }
}
