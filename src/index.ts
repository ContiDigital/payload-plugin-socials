import type { Config } from 'payload'

import type { PayloadPluginSocialsConfig } from './types/index.js'

import { applyAdminEnhancements } from './plugin/applyAdminEnhancements.js'
import { applyCollectionEnhancements } from './plugin/applyCollectionEnhancements.js'
import { applyEndpointEnhancements } from './plugin/applyEndpointEnhancements.js'
import { applyGlobalEnhancements } from './plugin/applyGlobalEnhancements.js'
import { applyScheduledSync } from './plugin/applyScheduledSync.js'
import { applyJobEnhancements } from './plugin/jobTasks.js'
import { normalizePluginOptions } from './plugin/normalizeOptions.js'
import { initPlatformRegistry } from './server/platforms/registry.js'
import { validateSourceResolvers } from './server/sources/registry.js'

const PLUGIN_APPLIED = Symbol.for('payload-plugin-socials.applied')

const assertNotApplied = (config: Config): void => {
  if ((config as Record<PropertyKey, unknown>)[PLUGIN_APPLIED] === true) {
    throw new Error(
      'payload-plugin-socials: only one plugin instance may be applied to a Payload config',
    )
  }
}

const markApplied = (config: Config): Config => {
  Object.defineProperty(config, PLUGIN_APPLIED, {
    configurable: true,
    enumerable: false,
    value: true,
  })
  return config
}

/**
 * `payload-plugin-socials` — multi-platform social publishing for Payload CMS.
 *
 * Curried factory. The outer call takes user options; the inner call receives
 * the Payload `Config` and returns the augmented config.
 *
 * Apply pipeline order is load-bearing:
 *   1. normalize options + register source resolvers + init platform registry
 *   2. collection enhancements (plugin-owned + host-collection tab injection)
 *   3. global enhancements (socials-connections)
 *   4. job task enhancements (register socialPostPublish + sweep + retry + insights + connection refresh)
 *   5. endpoint enhancements (REST surface incl. internal scheduler endpoints)
 *   6. admin enhancements (nav link, dashboard widget, custom config)
 *   7. scheduled-sync wiring (task schedules + operator startup notice)
 *
 * When `disabled`, only the schema-contributing steps (2 collections + 3 global)
 * run so host migrations remain stable; all runtime wiring is skipped.
 */
export const payloadPluginSocials =
  (incomingOptions: PayloadPluginSocialsConfig) =>
  (incomingConfig: Config): Config => {
    assertNotApplied(incomingConfig)
    const options = normalizePluginOptions(incomingOptions)

    if (options.disabled) {
      // Still register the plugin-owned collections and global so a host that
      // runs `payload migrate:create` while the plugin is disabled (e.g. the
      // encryption key is unavailable at build time) does not generate a
      // migration that DROPs social-posts / social-templates / socials-connections
      // and destroys audit history + encrypted tokens. All runtime wiring
      // (endpoints, jobs, admin, scheduling) is skipped.
      let config = applyCollectionEnhancements(incomingConfig, options, { schemaOnly: true })
      config = applyGlobalEnhancements(config, options, { schemaOnly: true })
      return markApplied(config)
    }

    // Eager initialization keeps hooks, jobs, and endpoints on one option-scoped registry.
    validateSourceResolvers(options.sources)
    initPlatformRegistry(options)

    let config = applyCollectionEnhancements(incomingConfig, options)
    config = applyGlobalEnhancements(config, options)
    config = applyJobEnhancements(config, options)
    config = applyEndpointEnhancements(config, options)
    config = applyAdminEnhancements(config, options)
    config = applyScheduledSync(config, options)
    return markApplied(config)
  }

// ---------------------------------------------------------------------------
// Public exports — helpers + types host code may want
// ---------------------------------------------------------------------------

export {
  PLATFORM_IDS,
  PLATFORM_LABELS,
  PLUGIN_SLUG,
  SOCIAL_CONNECTION_REFRESH_TASK_SLUG,
  SOCIAL_INSIGHTS_REFRESH_TASK_SLUG,
  SOCIAL_POST_PUBLISH_TASK_SLUG,
  SOCIAL_POST_RETRY_TASK_SLUG,
  SOCIAL_POST_SWEEP_TASK_SLUG,
  SOCIAL_POSTS_SLUG,
  SOCIAL_PUBLISH_ASYNC_HEADER,
  SOCIAL_PUBLISH_REQUESTS_SEGMENT,
  SOCIAL_PUBLISH_STATUS_HEADER,
  SOCIAL_PUBLISH_STATUS_PENDING,
  SOCIAL_TEMPLATES_SLUG,
  SOCIALS_CONNECTIONS_GLOBAL_SLUG,
  SOCIALS_QUEUE_NAME,
  STANDALONE_SOURCE_KIND,
} from './constants.js'

export {
  getSocialsField,
  getSocialsTab,
  SocialsUIPlaceholder,
} from './plugin/applyCollectionEnhancements.js'

// Scheduling helpers — hosts use these directly from their own worker
// processes, server actions, or admin pages when they want to bypass the
// HTTP `/internal` endpoints.
export {
  queueSocialConnectionRefresh,
  queueSocialInsightsRefresh,
  queueSocialPostPublish,
  queueSocialPostRetry,
  queueSocialPostSweep,
  runQueuedSocialsJobs,
  scheduleSocialPostPublish,
  sweepDueSocialPosts,
} from './plugin/jobQueue.js'

export { TASK_SLUGS_OWNED_BY_PLUGIN } from './plugin/jobTasks.js'

export { normalizePluginOptions } from './plugin/normalizeOptions.js'

// Per-platform image preflight + crop-target resolution. `transformImage`
// executes a resolved spec with sharp (an optional peer dependency).
export {
  PLATFORM_IMAGE_CONSTRAINTS,
  preflightImage,
  resolveTargetDimensions,
} from './server/assets/imagePreflight.js'

export type {
  ImageConstraints,
  ImageFormat,
  ImageMeta,
  PreflightIssue,
  PreflightResult,
  TargetDimensions,
} from './server/assets/imagePreflight.js'
export { resolveNormalizedCanvas } from './server/assets/resolvePlatformImage.js'
export type { ImagePresentation, NormalizedCanvas } from './server/assets/resolvePlatformImage.js'
export { transformImage } from './server/assets/transformImage.js'

export type { TransformOutputFormat, TransformSpec } from './server/assets/transformImage.js'
// Standalone cross-channel composer core: build a context from inline content
// and publish to many channels with per-channel error isolation.
export { composeAndPublish } from './server/compose/composePublish.js'
export type {
  ComposeResult,
  ComposeResultItem,
  ComposeTarget,
} from './server/compose/composePublish.js'
export { buildSocialDraft } from './server/compose/socialDraft.js'
export { buildStandaloneContext } from './server/compose/standaloneContext.js'

export type { StandaloneComposeInput } from './server/compose/standaloneContext.js'
// Reusable post-template interpolation. Hosts can drive copyOverrides from a
// stored template: `pinterestTitle: (ctx) => renderTemplate(tpl, buildTemplateScope(ctx))`.
export { buildTemplateScope, renderTemplate } from './server/templates/renderTemplate.js'
export { resolveTemplateCopy } from './server/templates/resolveTemplateCopy.js'
export type {
  ResolvedTemplateCopy,
  SocialTemplateFields,
} from './server/templates/resolveTemplateCopy.js'

export {
  coerceEncryptionKey,
  decryptString,
  decryptStringWithKeyring,
  encryptString,
} from './server/utilities/encryption.js'

export { ACCESS_SCOPES } from './types/index.js'

export type {
  AccessScope,
  AdminMode,
  AuthorizeFn,
  ConnectionState,
  EncryptedValue,
  FacebookPluginConfig,
  GbpPluginConfig,
  InstagramPluginConfig,
  NormalizedPluginOptions,
  NormalizedSchedulingConfig,
  PayloadPluginSocialsConfig,
  PinterestPluginConfig,
  PlatformAdapter,
  PlatformAdapterRegistry,
  PlatformCapabilities,
  PlatformId,
  PlatformPublicationStatus,
  Plugin,
  PostStatus,
  PreviewArgs,
  PreviewResult,
  PublishArgs,
  PublishedRef,
  SocialCopyFieldKey,
  SocialCopyFieldTransforms,
  SocialCopyTransform,
  SocialDraft,
  SocialDraftMedia,
  SocialHashtagsTransform,
  SocialImage,
  SocialImageFormat,
  SocialImageRole,
  SocialsAcquireRequestLease,
  SocialsAdminConfig,
  SocialsApiConfig,
  SocialsAssetsConfig,
  SocialsAutoRunConfig,
  SocialsCoordinationConfig,
  SocialsCopyOverrides,
  SocialsDistributedLock,
  SocialsMediaLibraryConfig,
  SocialSource,
  SocialSourceContext,
  SocialSourceKind,
  SocialsRateLimitConfig,
  SocialsRequestLease,
  SocialsSchedulingConfig,
  SocialsTransformations,
  SocialsWebhookConfig,
  SocialVideo,
  SourceContextResolver,
  SourceResolverRegistry,
  ValidationIssue,
  ValidationResult,
} from './types/index.js'

export default payloadPluginSocials
