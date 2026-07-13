import type {
  ConnectionState,
  NormalizedPluginOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PreviewArgs,
  PreviewResult,
  PublishArgs,
  PublishedRef,
  SocialImageFormat,
  ValidationResult,
} from '../../../types/index.js'

import { GBP_SUMMARY_MAX_CHARS } from '../../../constants.js'
import { PLATFORM_IMAGE_CONSTRAINTS } from '../../assets/imagePreflight.js'
import { resolvePlatformImageUrl } from '../../assets/resolvePlatformImage.js'
import { getCredentials, recordConnectionError } from '../../services/connectionService.js'
import { ValidationError } from '../../utilities/errors.js'
import { refreshGbpAccessToken } from './api.js'
import { buildDefaultGbpSummary } from './copy.js'
import { getGbpInsightsForRef } from './insights.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from './oauth.js'
import {
  deleteGbpLocalPost,
  type GbpPublishInput,
  type GbpTopicType,
  publishGbpLocalPost,
  TOPIC_TYPES,
} from './publish.js'
import { revokeGbpAuthorization } from './revoke.js'

const CAPABILITIES: PlatformCapabilities = {
  carousel: false,
  image: true,
  limits: {
    captionMaxChars: GBP_SUMMARY_MAX_CHARS,
    minImageWidthPx: 250,
  },
  oauth: true,
  scheduling: true,
  serviceAccount: true,
  stories: false,
  video: false, // LocalPosts technically supports VIDEO but acceptance is spotty (CLAUDE.md §5.6).
}

/**
 * Check whether a declared format is disallowed for this platform.
 */
const checkFormatIssue = (
  format: SocialImageFormat | undefined,
  options: NormalizedPluginOptions,
): string | undefined => {
  if (!format) {
    return undefined
  }
  if (!options.assets.preflight) {
    return undefined
  }
  const allowed = PLATFORM_IMAGE_CONSTRAINTS.gbp.formats as readonly string[]
  if (allowed.includes(format)) {
    return undefined
  }
  if (options.assets.autoConvert) {
    return undefined
  }
  return (
    `Image format "${format}" is not accepted by Google Business Profile (allowed: ${allowed.join(', ')}). ` +
    `Configure a JPEG imageSize on your upload collection or enable assets.autoConvert.`
  )
}

export const createGbpAdapter = (
  options: NormalizedPluginOptions,
): PlatformAdapter<GbpPublishInput> => {
  return {
    id: 'gbp',
    capabilities: CAPABILITIES,
    label: 'Google Business Profile',

    buildAuthorizeUrl({ state }) {
      return buildAuthorizeUrl(options, { state })
    },

    async exchangeCallback({ code, options: opts, payload, req }) {
      const result = await exchangeCodeForTokens({ code, options: opts, payload, req })
      const credentials = await getCredentials(payload, opts, 'gbp')
      return {
        accessToken: credentials?.accessToken ?? '',
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        refreshToken: credentials?.refreshToken,
        scopes: result.scopes,
      }
    },

    async isConnected({ options: opts, payload }): Promise<ConnectionState> {
      if (opts.platforms.gbp.serviceAccount) {
        return {
          accountLabel: opts.platforms.gbp.serviceAccount.clientEmail,
          connected: true,
          managedByConfig: true,
        }
      }

      const credentials = await getCredentials(payload, opts, 'gbp')
      if (!credentials?.refreshToken) {
        return {
          connected: false,
          lastError:
            'No GBP refresh token persisted — start OAuth flow or configure a service account.',
        }
      }
      return {
        accessTokenExpiresAt: credentials.accessTokenExpiresAt,
        accountLabel: credentials.accountLabel,
        connected: true,
        scopes: credentials.scopes,
      }
    },

    async refreshToken({ options: opts, payload }) {
      const accessToken = await refreshGbpAccessToken(payload, opts)
      if (!accessToken) {
        throw new ValidationError('GBP refresh token is unavailable')
      }
      const credentials = await getCredentials(payload, opts, 'gbp')
      return {
        accessToken,
        accessTokenExpiresAt: credentials?.accessTokenExpiresAt,
        refreshToken: credentials?.refreshToken,
        scopes: credentials?.scopes,
      }
    },

    async revokeAuthorization({ options: opts, payload }) {
      await revokeGbpAuthorization(payload, opts)
      return { affectedPlatforms: ['gbp'] }
    },

    preview(args: PreviewArgs): Promise<PreviewResult> {
      const summary =
        options.copyOverrides.gbpSummary?.(args.ctx) ?? buildDefaultGbpSummary(args.ctx)
      const primary = args.ctx.images[0]
      return Promise.resolve({
        body: summary,
        imageUrl: primary?.url,
        link: args.ctx.link,
        meta: {
          supportedTopicTypes: TOPIC_TYPES,
          topicType: 'STANDARD',
        },
        title: args.ctx.baseTitle,
      })
    },

    validate(args): ValidationResult {
      const issues: ValidationResult['issues'] = []
      const { ctx, input } = args
      const summary =
        input?.summary?.trim() ||
        options.copyOverrides.gbpSummary?.(ctx) ||
        buildDefaultGbpSummary(ctx)
      if (!summary.trim()) {
        issues.push({ message: 'GBP requires a non-empty summary', severity: 'error' })
      }
      if (summary.length > GBP_SUMMARY_MAX_CHARS) {
        issues.push({
          field: 'summary',
          message: `Summary is ${summary.length} chars (max ${GBP_SUMMARY_MAX_CHARS})`,
          severity: 'error',
        })
      }
      if (!input?.locationResourceName) {
        issues.push({
          field: 'locationResourceName',
          message: 'locationResourceName is required (use "accounts/{a}/locations/{l}")',
          severity: 'error',
        })
      }
      const topic: GbpTopicType = input?.topicType ?? 'STANDARD'
      if (!TOPIC_TYPES.includes(topic)) {
        issues.push({
          field: 'topicType',
          message: `topicType must be one of: ${TOPIC_TYPES.join(', ')}`,
          severity: 'error',
        })
      }
      // Topic-specific structural checks happen inside `publishGbpLocalPost`
      // -- we only warn here for UI feedback.
      if ((topic === 'EVENT' || topic === 'OFFER') && !input?.event) {
        issues.push({
          message: `${topic} posts require an event block`,
          severity: 'error',
        })
      }
      if (topic === 'OFFER' && !input?.offer) {
        issues.push({
          message: 'OFFER posts require an offer block',
          severity: 'error',
        })
      }
      if (topic === 'ALERT' && !input?.alertType) {
        issues.push({
          message: 'ALERT posts require alertType (e.g. "COVID_19")',
          severity: 'error',
        })
      }

      // Image format pre-publish check.
      if (input?.imageUrl) {
        const imgMeta = ctx.images.find((img) => img.url === input.imageUrl)
        const formatIssue = checkFormatIssue(imgMeta?.format, args.options)
        if (formatIssue) {
          issues.push({ field: 'imageUrl', message: formatIssue, severity: 'error' })
        }
      }

      const hasError = issues.some((i) => i.severity === 'error')
      return { issues, ok: !hasError }
    },

    async publish(args: PublishArgs<GbpPublishInput>): Promise<PublishedRef> {
      const validation = this.validate({
        ctx: args.ctx,
        input: args.input,
        options: args.options,
      }) as ValidationResult
      if (!validation.ok) {
        const errors = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')
        throw new ValidationError(`GBP publish input invalid: ${errors}`)
      }
      try {
        const resolvedInput = await resolveGbpImages(args)
        const result = await publishGbpLocalPost({
          ctx: args.ctx,
          input: resolvedInput,
          options: args.options,
          payload: args.payload,
          req: args.req,
        })
        return result.publishedRef
      } catch (error) {
        await recordConnectionError(args.payload, 'gbp', error)
        throw error
      }
    },

    async delete({ options: opts, payload, publishedRef }) {
      await deleteGbpLocalPost({ options: opts, payload, publishedRef })
    },

    async getInsights({ options: opts, payload, publishedRef, range }) {
      if (publishedRef.platform !== 'gbp' || !publishedRef.externalId) {
        return {}
      }
      return getGbpInsightsForRef({
        options: opts,
        payload,
        publishedRef,
        range,
      })
    },
  }
}

/**
 * Resolve image URL for the GBP publish input through the platform
 * image format safety layer.
 */
const resolveGbpImages = async (args: PublishArgs<GbpPublishInput>): Promise<GbpPublishInput> => {
  const { ctx, input, options, payload } = args
  const resolved = { ...input }

  if (input.imageUrl) {
    const imgMeta = ctx.images.find((img) => img.url === input.imageUrl)
    const result = await resolvePlatformImageUrl({
      declaredFormat: imgMeta?.format,
      imageUrl: input.imageUrl,
      options,
      payload,
      platform: 'gbp',
    })
    resolved.imageUrl = result.url
  }

  return resolved
}
