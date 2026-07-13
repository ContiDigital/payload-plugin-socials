import type { CollectionSlug, Config, Payload, PayloadRequest } from 'payload'

import type { PlatformId, PlatformPublicationStatus, PostStatus } from '../constants.js'

export type { PlatformId, PlatformPublicationStatus, PostStatus }

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export const ACCESS_SCOPES = ['publisher', 'admin'] as const
export type AccessScope = (typeof ACCESS_SCOPES)[number]

/**
 * Host-supplied authorization function. The plugin invokes this on every
 * endpoint to gate access. Returning `false`/`null`/`undefined` denies; a
 * truthy return (the resolved user, or `true`) allows. Host implementations
 * map their own role system onto the `scope` argument.
 */
export type AuthorizeFn = (args: {
  payload: Payload
  req: PayloadRequest
  scope: AccessScope
}) => boolean | null | Promise<boolean | null | undefined> | undefined

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export type EncryptedValue = {
  /** Base64-encoded 16-byte GCM authentication tag. */
  authTag: string
  /** Base64-encoded ciphertext (no tag concatenated). */
  ciphertext: string
  /** Base64-encoded 12-byte initialization vector. */
  iv: string
  /** Always `1` for the v1 envelope. Bump when the encoding changes. */
  version: number
}

// ---------------------------------------------------------------------------
// Source abstraction
//
// The plugin doesn't know what a "source" is in the host application — it
// could be a product, a project, a blog post, anything. Each source kind is
// registered by the host with a resolver function that loads the entity and
// returns a normalized `SocialSourceContext` the channel adapters consume.
// ---------------------------------------------------------------------------

export type SocialSourceKind = string

export type SocialSource = {
  id: number | string
  kind: SocialSourceKind
}

export type SocialImageRole =
  'after' | 'before' | 'detail' | 'install' | 'lifestyle' | 'main' | ({} & string)

export interface SocialImage {
  alt?: string
  /** True when below Pinterest's 600px minimum width (informational). */
  belowMinWidth?: boolean
  height?: number
  role: SocialImageRole
  url: string
  width?: number
}

export interface SocialVideo {
  coverImageUrl?: string
  durationSeconds?: number
  height?: number
  url: string
  width?: number
}

export interface SocialSourceContext {
  /** Channel-agnostic body text. Each channel adapter wraps it in its own copy. */
  baseDescription: string
  /** Channel-agnostic title; channel adapters truncate per their own limits. */
  baseTitle: string
  /** Optional segment slugs / channel-specific routing hints supplied by host. */
  hints?: {
    [key: string]: unknown
    instagramHashtags?: string[]
    pinterestSegments?: string[]
  }
  /** Source images in preference order. Plugin honours order; UI surfaces all. */
  images: SocialImage[]
  /** Outbound URL (already UTM-baked by the host if desired). */
  link: string
  /** Free-form metadata the host wants channel-side copy builders to use. */
  metadata?: Record<string, unknown>
  /** Optional secondary label (e.g. product.modelId for Pinterest title suffix). */
  modelLabel?: null | string
  /** Stable identifier for the source entity (always stringified). */
  sourceId: string
  /** The kind discriminator (e.g. `product`, `project`, `blogPost`). */
  sourceKind: SocialSourceKind
  /** Optional videos. */
  videos?: SocialVideo[]
}

export type SocialDraftMedia = {
  altText?: string
  coverImageUrl?: string
  durationSeconds?: number
  height?: number
  role?: SocialImageRole
  type: 'image' | 'video'
  url: string
  width?: number
}

/**
 * Stable, editor-independent authoring model used by the custom composer.
 * Host rich-text documents and custom blocks stay behind SourceContextResolver;
 * adapters only ever receive the deliberately constrained social representation.
 */
export type SocialDraft = {
  content: {
    body: string
    link: string
    title: string
  }
  media: SocialDraftMedia[]
  source: {
    id: string
    kind: SocialSourceKind
  }
  version: 1
}

/**
 * Host-supplied resolver. The plugin calls this whenever it needs to load
 * the channel-agnostic context for a `(kind, id)` pair. Resolvers throw a
 * clear error for unsupported ids so the admin UI can surface it.
 */
export type SourceContextResolver = (args: {
  id: number | string
  payload: Payload
  req?: PayloadRequest
}) => Promise<SocialSourceContext>

export type SourceResolverRegistry = Record<SocialSourceKind, SourceContextResolver>

// ---------------------------------------------------------------------------
// Platform adapter contract
//
// Every platform (Pinterest, Instagram, Facebook, GBP) implements this same
// interface. Adapters are stateless factories; their methods receive whatever
// runtime context they need explicitly.
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  /** Whether the adapter supports multi-asset carousels. */
  carousel: boolean
  /** Whether the adapter supports static images. */
  image: boolean
  /** Per-platform soft caps the UI uses to grey out images/copy. */
  limits: {
    captionMaxChars?: number
    hashtagsMax?: number
    minImageHeightPx?: number
    minImageWidthPx?: number
    titleMaxChars?: number
  }
  /** Whether the adapter supports OAuth-based connections. */
  oauth: boolean
  /** Whether the adapter supports scheduled publishing. */
  scheduling: boolean
  /** Whether the adapter supports service-account / system-user tokens. */
  serviceAccount: boolean
  /** Whether the adapter supports ephemeral stories. */
  stories: boolean
  /** Whether the adapter supports video posts. */
  video: boolean
}

export type ValidationIssue = {
  field?: string
  message: string
  severity: 'error' | 'warning'
}

export type ValidationResult = {
  issues: ValidationIssue[]
  ok: boolean
}

export type PreviewArgs = {
  ctx: SocialSourceContext
  options: NormalizedPluginOptions
  /** Host-provided per-platform overrides (free-form). */
  overrides?: Record<string, unknown>
  payload: Payload
  req?: PayloadRequest
}

export type PreviewResult = {
  altText?: string
  body?: string
  hashtags?: string[]
  imageUrl?: string
  link?: string
  /** Free-form platform-specific preview details. */
  meta?: Record<string, unknown>
  title?: string
}

export type PublishArgs<TInput = unknown> = {
  ctx: SocialSourceContext
  input: TInput
  options: NormalizedPluginOptions
  payload: Payload
  postId: number | string
  req?: PayloadRequest
}

export type PublishedRef = {
  /** Platform-side id (pin id, fb post id, ig media id, gbp localPost name). */
  externalId: string
  /** Public URL where the post is visible (when known). */
  externalUrl?: string
  /** Additional platform-specific data the plugin persists for later read. */
  meta?: Record<string, unknown>
  platform: PlatformId
}

export type ConnectionState = {
  /** ISO timestamp when the underlying access token will expire. */
  accessTokenExpiresAt?: string
  /** Display name of the connected account (when known). */
  accountLabel?: string
  /** True when the adapter currently holds a usable token. */
  connected: boolean
  /** Last connection error (when not connected). */
  lastError?: string
  /** True when credentials come from immutable host configuration. */
  managedByConfig?: boolean
  /** ISO timestamp when the refresh token will expire. */
  refreshTokenExpiresAt?: string
  /** Granted OAuth scopes (when known). */
  scopes?: string[]
}

export interface PlatformAdapter<TPublishInput = unknown> {
  /** Returns the OAuth authorize URL (when applicable). */
  buildAuthorizeUrl?(args: {
    options: NormalizedPluginOptions
    payload: Payload
    /** Random opaque state value the plugin generated. */
    state: string
  }): Promise<string> | string
  readonly capabilities: PlatformCapabilities
  /** Optional channel-side delete. */
  delete?(args: {
    options: NormalizedPluginOptions
    payload: Payload
    publishedRef: PublishedRef
    req?: PayloadRequest
  }): Promise<void>

  /**
   * Handle the OAuth callback. Exchanges code for tokens, validates scopes,
   * persists the encrypted credential payload. The plugin owns the cookie
   * verification and storage; the adapter just owns the token exchange.
   */
  exchangeCallback?(args: {
    code: string
    options: NormalizedPluginOptions
    payload: Payload
    req: PayloadRequest
  }): Promise<{
    accessToken: string
    accessTokenExpiresAt?: string
    accountId?: string
    accountLabel?: string
    raw?: Record<string, unknown>
    refreshToken?: string
    refreshTokenExpiresAt?: string
    scopes?: string[]
  }>

  /** Optional channel-side analytics fetch. */
  getInsights?(args: {
    options: NormalizedPluginOptions
    payload: Payload
    publishedRef: PublishedRef
    range: { end: string; start: string }
  }): Promise<Record<string, unknown>>

  readonly id: PlatformId

  /** Inspect the current connection state without making a privileged call. */
  isConnected(args: {
    options: NormalizedPluginOptions
    payload: Payload
  }): Promise<ConnectionState>

  readonly label: string

  /**
   * Build a channel-specific preview payload from the normalized source
   * context. Host `copyOverrides` may have already populated bits of this.
   */
  preview(args: PreviewArgs): Promise<PreviewResult>

  /**
   * Perform the actual publish. Should be idempotent — callers may retry on
   * transient failures. Adapters surface idempotency by reusing the `postId`
   * argument to dedupe via the `social-posts` collection.
   */
  publish(args: PublishArgs<TPublishInput>): Promise<PublishedRef>

  /** Refresh the access token using the persisted refresh token. */
  refreshToken?(args: {
    options: NormalizedPluginOptions
    payload: Payload
    refreshToken?: string
  }): Promise<{
    accessToken: string
    accessTokenExpiresAt?: string
    raw?: Record<string, unknown>
    refreshToken?: string
    refreshTokenExpiresAt?: string
    scopes?: string[]
  }>

  /** Revoke the upstream OAuth grant before local credentials are erased. */
  revokeAuthorization?(args: {
    options: NormalizedPluginOptions
    payload: Payload
  }): Promise<{ affectedPlatforms?: PlatformId[] } | void>

  /** Channel-specific input validation. */
  validate(args: {
    ctx: SocialSourceContext
    input: TPublishInput
    options: NormalizedPluginOptions
  }): Promise<ValidationResult> | ValidationResult
}

export type PlatformAdapterRegistry = Partial<Record<PlatformId, PlatformAdapter>>

// ---------------------------------------------------------------------------
// Per-platform plugin options
// ---------------------------------------------------------------------------

export type PinterestPluginConfig = {
  /** HTTPS hosts the plugin may fetch video bytes from for Pinterest upload. */
  allowedVideoHosts?: readonly string[]
  clientId?: string
  clientSecret?: string
  enabled?: boolean
  /** Pinterest environment: `production` (default) or `sandbox`. */
  environment?: 'production' | 'sandbox'
  redirectUri?: string
  /** OAuth scopes to request. Sensible default in normalizer. */
  scopes?: readonly string[]
  /** End-to-end timeout for the remote-video to Pinterest transfer. */
  videoUploadTimeoutMs?: number
}

export type InstagramPluginConfig = {
  /** Graph API version pin (default `v25.0`). */
  apiVersion?: string
  appId?: string
  appSecret?: string
  enabled?: boolean
  /** OAuth redirect URI when using user-token flow. */
  redirectUri?: string
  /** Required Meta scopes. */
  scopes?: readonly string[]
  /** Optional pre-provisioned system-user token (preferred for backend). */
  systemUserAccessToken?: string
}

export type FacebookPluginConfig = {
  apiVersion?: string
  appId?: string
  appSecret?: string
  enabled?: boolean
  redirectUri?: string
  scopes?: readonly string[]
  systemUserAccessToken?: string
}

export type GbpPluginConfig = {
  clientId?: string
  clientSecret?: string
  enabled?: boolean
  redirectUri?: string
  /** Optional service-account JSON for the SA-managed flow. */
  serviceAccount?: {
    clientEmail: string
    /** When using domain-wide delegation, the Workspace user to impersonate. */
    impersonate?: string
    privateKey: string
  }
}

// ---------------------------------------------------------------------------
// Copy transformations
// ---------------------------------------------------------------------------

/**
 * The seven canonical copy fields the plugin manages across all platforms.
 * Use this tuple as the single source of truth for any code that iterates
 * over copy fields.
 */
export const SOCIAL_COPY_FIELD_KEYS = [
  'pinterestTitle',
  'pinterestDescription',
  'pinterestAltText',
  'pinterestHashtags',
  'instagramCaption',
  'facebookMessage',
  'gbpSummary',
] as const

export type SocialCopyFieldKey = (typeof SOCIAL_COPY_FIELD_KEYS)[number]

/**
 * A transformation for a single string copy field. Provide either:
 *   - A template string with `{{ variable | filter }}` placeholders (rendered
 *     by the plugin's interpolation engine against the source context), or
 *   - A function that receives the full `SocialSourceContext` and returns
 *     the final string value.
 */
export type SocialCopyTransform = ((ctx: SocialSourceContext) => string) | string

/**
 * A transformation for `pinterestHashtags`. Provide either:
 *   - A space- or comma-separated string of hashtag tokens (normalized by
 *     the plugin's `splitHashtags` helper), or
 *   - A function that receives the `SocialSourceContext` and returns a
 *     `string[]` of `#tag` values.
 */
export type SocialHashtagsTransform = ((ctx: SocialSourceContext) => string[]) | string

/**
 * Per-field transformation map for a single source kind (or the wildcard
 * `'*'` fallback). Every key is optional — only the fields you care about
 * need entries. For all seven fields except `pinterestHashtags` the value
 * is a `SocialCopyTransform`; `pinterestHashtags` accepts a
 * `SocialHashtagsTransform`.
 */
export type SocialCopyFieldTransforms = {
  facebookMessage?: SocialCopyTransform
  gbpSummary?: SocialCopyTransform
  instagramCaption?: SocialCopyTransform
  pinterestAltText?: SocialCopyTransform
  pinterestDescription?: SocialCopyTransform
  pinterestHashtags?: SocialHashtagsTransform
  pinterestTitle?: SocialCopyTransform
}

/**
 * Config-first, source-kind-aware copy transformation map.
 *
 * Keyed by `SocialSourceKind` (e.g. `'product'`, `'blogPost'`). The
 * optional `'*'` key is a fallback that applies to any source kind not
 * explicitly listed.
 *
 * Precedence (highest to lowest):
 *   1. `transformations[ctx.sourceKind][field]`   — kind-specific
 *   2. `transformations['*'][field]`               — wildcard fallback
 *   3. `copyOverrides[field]`                      — function-only legacy
 *   4. Built-in default builder                   — plugin default
 *
 * String values are rendered through the plugin's `{{ variable | filter }}`
 * template engine. Function values receive the `SocialSourceContext` directly.
 */
export type SocialsTransformations = {
  '*'?: SocialCopyFieldTransforms
} & Record<SocialSourceKind, SocialCopyFieldTransforms>

// ---------------------------------------------------------------------------
// Public plugin options
// ---------------------------------------------------------------------------

export type AdminMode = 'both' | 'dashboard' | 'headless' | 'route'

export type SocialsAdminConfig = {
  /**
   * Optional list of host collections where the plugin should inject a
   * "Socials" tab. Each entry references a source kind that has a registered
   * resolver. Use `false` (or omit) to mount manually via `getSocialsTab()`.
   */
  injectInto?: Array<{
    collection: CollectionSlug
    label?: string
    sourceKind: SocialSourceKind
    tabPosition?: 'append' | 'before-last' | number
  }>
  mode?: AdminMode
  navLabel?: string
  route?: `/${string}`
}

export type SocialsApiConfig = {
  basePath?: `/${string}`
}

export type SocialsCopyOverrides = {
  facebookMessage?: (ctx: SocialSourceContext) => string
  gbpSummary?: (ctx: SocialSourceContext) => string
  instagramCaption?: (ctx: SocialSourceContext) => string
  pinterestAltText?: (ctx: SocialSourceContext) => string
  pinterestDescription?: (ctx: SocialSourceContext) => string
  pinterestHashtags?: (ctx: SocialSourceContext) => string[]
  /** Replace the default Pinterest title builder. */
  pinterestTitle?: (ctx: SocialSourceContext) => string
}

export type SocialsRateLimitConfig = {
  baseRetryDelayMs?: number
  enabled?: boolean
  jitterFactor?: number
  maxConcurrency?: number
  maxRequestsPerMinute?: number
  maxRetries?: number
  maxRetryDelayMs?: number
  requestTimeoutMs?: number
}

export type SocialsDistributedLock = <Result>(args: {
  /** Globally stable lock key. */
  key: string
  /** Work that must execute while the lease is exclusively held. */
  run: () => Promise<Result>
  /** Maximum lease duration. Providers should extend or fence long work. */
  ttlMs: number
}) => Promise<Result>

export type SocialsRequestLease = {
  release: () => Promise<void> | void
}

export type SocialsAcquireRequestLease = (args: {
  maxConcurrency: number
  maxRequestsPerMinute: number
  scope: string
}) => Promise<SocialsRequestLease>

export type SocialsCoordinationConfig = {
  /** Optional Redis/database-backed request quota shared by every process. */
  acquireRequestLease?: SocialsAcquireRequestLease
  /** Optional Redis/database-backed exclusive lock for rotating credentials. */
  withLock?: SocialsDistributedLock
}

export type MetaWebhookEvent = Record<string, unknown>

export type SocialsWebhookConfig = {
  meta?: {
    /** Called only after the X-Hub-Signature-256 body signature is verified. */
    onEvent?: (args: {
      event: MetaWebhookEvent
      payload: Payload
      platform: Extract<PlatformId, 'facebook' | 'instagram'>
      req: PayloadRequest
    }) => Promise<void> | void
    /** Opaque value Meta echoes during webhook subscription verification. */
    verifyToken: string
  }
}

// ---------------------------------------------------------------------------
// Scheduling
//
// The plugin defines task DEFINITIONS (TaskConfig for Payload's Jobs system)
// but does NOT own scheduling cadence — every host triggers work the way
// their infra supports:
//
//   - **Native Payload Jobs autoRun**: host sets `scheduling.autoRun.cron`
//     and the plugin registers an `autoRun` entry under the socials queue
//     during `applyScheduledSync`. Payload's built-in scheduler fires it.
//
//   - **External cron (AWS EventBridge / Vercel cron / GitHub Actions / etc.)**:
//     host hits the plugin's internal HTTP endpoints (`/socials/internal/jobs/sweep`,
//     `/socials/internal/jobs/run`, etc.) with the `scheduling.internalApiKey`.
//     The endpoint performs the sweep + drain inline.
//
//   - **Long-running worker process**: host imports `runQueuedSocialsJobs(payload)`
//     and `sweepDueSocialPosts(payload)` from `payload-plugin-socials` and
//     calls them in a loop. Useful for self-hosted ECS deployments.
//
//   - **Hybrid**: nothing precludes mixing — e.g. autoRun for the sweep,
//     external cron for insights/connection refresh.
// ---------------------------------------------------------------------------

export type SocialsAutoRunConfig = {
  /** Cron for the connection refresh task. Default: not registered. */
  connectionRefreshCron?: string
  /**
   * Cron string Payload's built-in scheduler uses to fire the sweep task.
   * Example: '*‌/5 * * * *' for every 5 minutes.
   *
   * The plugin defaults to NOT registering an autoRun entry — set this
   * when you want the plugin to take ownership of the cadence. Otherwise
   * trigger via the internal HTTP endpoints from your external scheduler.
   */
  cron: string
  /** Cron for the insights refresh task. Default: not registered. */
  insightsRefreshCron?: string
  /**
   * Optional Payload `Queue` name when the host wants to isolate socials
   * jobs onto a dedicated queue. Defaults to the plugin's own constant.
   */
  queue?: string
}

export type SocialsSchedulingConfig = {
  /** When set, plugin registers an autoRun entry under the socials queue. */
  autoRun?: SocialsAutoRunConfig
  /**
   * Refresh access tokens whose expiry is within this many seconds.
   * Default 86400 (24 hours).
   */
  connectionRefreshWindowSeconds?: number
  /**
   * Maximum jobs `runQueuedSocialsJobs` drains per invocation. Default 100.
   */
  drainBatchSize?: number
  /**
   * Refresh insights for posts published within this many seconds.
   * Default 30 days.
   */
  insightsRefreshWindowSeconds?: number
  /**
   * Pre-shared API key required for the internal scheduler endpoints.
   * When unset, those endpoints fail closed with a clear error message.
   */
  internalApiKey?: string
  /**
   * Maximum posts the sweep helper pulls per invocation. Default 100.
   * Bound this so a single sweep doesn't tie up the worker forever.
   */
  sweepBatchSize?: number
}

export type PayloadPluginSocialsConfig = {
  admin?: SocialsAdminConfig
  api?: SocialsApiConfig
  /** Host-supplied access control. */
  authorize: AuthorizeFn
  coordination?: SocialsCoordinationConfig
  /** Optional copy overrides; plugin defaults are used when omitted. */
  copyOverrides?: SocialsCopyOverrides
  disabled?: boolean
  /** Mandatory 32-byte (256-bit) encryption key for stored OAuth tokens. */
  encryptionKey: Buffer | string
  platforms: {
    facebook?: FacebookPluginConfig
    gbp?: GbpPluginConfig
    instagram?: InstagramPluginConfig
    pinterest?: PinterestPluginConfig
  }
  /** Old keys retained temporarily for zero-downtime credential rotation. */
  previousEncryptionKeys?: readonly (Buffer | string)[]
  rateLimit?: SocialsRateLimitConfig
  scheduling?: SocialsSchedulingConfig
  /** Per-source-kind resolvers; the host registers at least one. */
  sources: Record<SocialSourceKind, SourceContextResolver>
  /** Allow flipping every adapter to test mode (e.g. Pinterest sandbox). */
  testMode?: boolean
  /**
   * Config-first, source-kind-aware copy transformations.
   *
   * Declare per-field copy for each source kind (and an optional `'*'`
   * wildcard). Each value is either a template string (rendered through the
   * plugin's `{{ variable | filter }}` engine) or a function that receives
   * the full `SocialSourceContext`. This is the recommended way to customize
   * copy — it is source-kind-aware and takes precedence over `copyOverrides`.
   *
   * @example
   * ```ts
   * transformations: {
   *   product: {
   *     pinterestTitle: '{{ title | upper }} | {{ modelLabel | default:Shop Now }}',
   *     pinterestHashtags: (ctx) => ['#marble', `#${ctx.sourceKind}`],
   *   },
   *   '*': {
   *     facebookMessage: '{{ title }}\n\n{{ description | truncate:300 }}',
   *   },
   * }
   * ```
   */
  transformations?: SocialsTransformations
  webhooks?: SocialsWebhookConfig
}

// ---------------------------------------------------------------------------
// Normalized options (internal; every default resolved)
// ---------------------------------------------------------------------------

export type NormalizedPinterestConfig = {
  allowedVideoHosts: readonly string[]
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: readonly string[]
  videoUploadTimeoutMs: number
} & Required<Pick<PinterestPluginConfig, 'enabled' | 'environment'>>

type NormalizedInstagramConfig = {
  appId: string
  appSecret: string
  redirectUri: string
  scopes: readonly string[]
  systemUserAccessToken: string
} & Required<Pick<InstagramPluginConfig, 'apiVersion' | 'enabled'>>

export type NormalizedFacebookConfig = NormalizedInstagramConfig

export type NormalizedGbpConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  serviceAccount?: {
    clientEmail: string
    impersonate?: string
    privateKey: string
  }
} & Required<Pick<GbpPluginConfig, 'enabled'>>

export type NormalizedRateLimitConfig = {
  acquireRequestLease?: SocialsAcquireRequestLease
  baseRetryDelayMs: number
  enabled: boolean
  jitterFactor: number
  maxConcurrency: number
  maxRequestsPerMinute: number
  maxRetries: number
  maxRetryDelayMs: number
  requestTimeoutMs: number
}

export type NormalizedPluginOptions = {
  admin: {
    injectInto: NonNullable<SocialsAdminConfig['injectInto']>
    mode: AdminMode
    navLabel: string
    route: `/${string}`
  }
  api: {
    basePath: `/${string}`
  }
  authorize: AuthorizeFn
  coordination: SocialsCoordinationConfig
  copyOverrides: SocialsCopyOverrides
  disabled: boolean
  encryptionKey: Buffer
  platforms: {
    facebook: NormalizedFacebookConfig
    gbp: NormalizedGbpConfig
    instagram: NormalizedInstagramConfig
    pinterest: NormalizedPinterestConfig
  }
  previousEncryptionKeys: readonly Buffer[]
  rateLimit: NormalizedRateLimitConfig
  scheduling: NormalizedSchedulingConfig
  sources: SourceResolverRegistry
  testMode: boolean
  /** Always present after normalization; `{}` when no transformations were configured. */
  transformations: SocialsTransformations
  webhooks: SocialsWebhookConfig
}

export type NormalizedSchedulingConfig = {
  autoRun?: {
    connectionRefreshCron?: string
    cron: string
    insightsRefreshCron?: string
    queue: string
  }
  connectionRefreshWindowSeconds: number
  drainBatchSize: number
  insightsRefreshWindowSeconds: number
  internalApiKey?: string
  sweepBatchSize: number
}

// ---------------------------------------------------------------------------
// Plugin alias (matches the Payload signature)
// ---------------------------------------------------------------------------

export type Plugin = Exclude<Config['plugins'], undefined>[number]
