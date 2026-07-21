// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

export const PLUGIN_SLUG = 'payload-plugin-socials'

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORM_IDS = ['pinterest', 'instagram', 'facebook', 'gbp'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  facebook: 'Facebook',
  gbp: 'Google Business Profile',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
}

// ---------------------------------------------------------------------------
// Admin / API path defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ADMIN_ROUTE_PATH = '/socials'
export const DEFAULT_ADMIN_NAV_LABEL = 'Socials'
export const DEFAULT_API_BASE_PATH = '/socials'

// ---------------------------------------------------------------------------
// Plugin-owned collection + global slugs
// ---------------------------------------------------------------------------

export const SOCIAL_POSTS_SLUG = 'social-posts'
export const SOCIAL_TEMPLATES_SLUG = 'social-templates'
export const SOCIALS_CONNECTIONS_GLOBAL_SLUG = 'socials-connections'

// Reserved source kind for standalone composer posts — content typed directly
// into the composer rather than transposed from a host source record.
export const STANDALONE_SOURCE_KIND = 'standalone'
export const SOCIAL_DRAFT_VERSION = 1

// ---------------------------------------------------------------------------
// Jobs / tasks
// ---------------------------------------------------------------------------

export const SOCIALS_QUEUE_NAME = 'socials'
export const SOCIAL_POST_PUBLISH_TASK_SLUG = 'socialPostPublish'
export const SOCIAL_POST_RETRY_TASK_SLUG = 'socialPostRetry'
export const SOCIAL_POST_SWEEP_TASK_SLUG = 'socialPostSweep'
export const SOCIAL_INSIGHTS_REFRESH_TASK_SLUG = 'socialInsightsRefresh'
export const SOCIAL_CONNECTION_REFRESH_TASK_SLUG = 'socialConnectionRefresh'

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM)
// ---------------------------------------------------------------------------
//
// The plugin stores OAuth refresh tokens (and other secrets) on the
// `socials-connections` global. Plaintext storage is a non-starter.
// Host MUST supply a 32-byte encryption key via `options.encryptionKey`.

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
export const ENCRYPTION_KEY_BYTES = 32
export const ENCRYPTION_IV_BYTES = 12 // 96-bit nonce per NIST SP 800-38D
export const ENCRYPTION_AUTH_TAG_BYTES = 16
export const ENCRYPTION_PAYLOAD_VERSION = 1

// ---------------------------------------------------------------------------
// Rate limiting / retry defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RATE_LIMIT_ENABLED = true
export const DEFAULT_MAX_CONCURRENCY = 4
export const DEFAULT_MAX_QUEUE_SIZE = 200
export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_BASE_RETRY_DELAY_MS = 500
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000
export const DEFAULT_RETRY_JITTER_FACTOR = 0.25
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
export const DEFAULT_ASSET_FETCH_TIMEOUT_MS = 15_000
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_REMOTE_ASSET_REDIRECTS = 3
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024

// HTTP status codes that warrant an exponential-backoff retry.
export const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])

// Node socket errors that warrant a retry (network blip, not a real fault).
export const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

// ---------------------------------------------------------------------------
// Pinterest compatibility defaults retained for existing publication behavior.
// ---------------------------------------------------------------------------

export const PINTEREST_TITLE_MAX = 100
export const PINTEREST_DESCRIPTION_MAX = 500 // OpenAPI allows 800; UI caps at 500
export const PINTEREST_ALT_TEXT_MAX = 500
export const PINTEREST_HASHTAGS_MAX = 5
export const PINTEREST_MIN_IMAGE_WIDTH = 600
export const PINTEREST_RETRY_AFTER_CAP_SEC = 30
export const PINTEREST_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_PINTEREST_VIDEO_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000
export const PINTEREST_MEDIA_POLL_INTERVAL_MS = 5_000
export const PINTEREST_MEDIA_POLL_TIMEOUT_MS = 10 * 60 * 1000
export const PINTEREST_TOKEN_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000

// ---------------------------------------------------------------------------
// Instagram limits (per Meta Graph API v25.0)
// ---------------------------------------------------------------------------

export const INSTAGRAM_CAPTION_MAX_CHARS = 2200
export const INSTAGRAM_CAPTION_MAX_HASHTAGS = 30
export const INSTAGRAM_CAPTION_MAX_MENTIONS = 20
export const INSTAGRAM_CAROUSEL_MIN_CHILDREN = 2
export const INSTAGRAM_CAROUSEL_MAX_CHILDREN = 10
export const INSTAGRAM_CONTAINER_LIFETIME_HOURS = 24

// ---------------------------------------------------------------------------
// GBP LocalPost limits
// ---------------------------------------------------------------------------

export const GBP_SUMMARY_MAX_CHARS = 1500

// ---------------------------------------------------------------------------
// Post lifecycle states
// ---------------------------------------------------------------------------

export const POST_STATUSES = [
  'draft',
  'queued',
  'scheduled',
  'publishing',
  'unknown',
  'published',
  'failed',
  'cancelled',
  'deleted',
] as const
export type PostStatus = (typeof POST_STATUSES)[number]

export const PLATFORM_PUBLICATION_STATUSES = [
  'pending',
  'publishing',
  'unknown',
  'published',
  'failed',
  'skipped',
] as const
export type PlatformPublicationStatus = (typeof PLATFORM_PUBLICATION_STATUSES)[number]

// ---------------------------------------------------------------------------
// Logger prefix
// ---------------------------------------------------------------------------

export const LOG_PREFIX = '[Socials]'
