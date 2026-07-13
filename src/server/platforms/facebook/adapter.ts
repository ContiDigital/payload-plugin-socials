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

import { PLATFORM_IMAGE_CONSTRAINTS } from '../../assets/imagePreflight.js'
import { resolvePlatformImageUrl } from '../../assets/resolvePlatformImage.js'
import { getCredentials, recordConnectionError } from '../../services/connectionService.js'
import { ValidationError } from '../../utilities/errors.js'
import { refreshMetaAccessToken } from '../_meta/api.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../_meta/oauth.js'
import { revokeMetaAuthorization } from '../_meta/revoke.js'
import { buildDefaultFacebookMessage } from './copy.js'
import { getFacebookInsightsForRef } from './insights.js'
import {
  deleteFacebookPost,
  FACEBOOK_FORMATS,
  type FacebookPublishInput,
  publishFacebookPost,
} from './publish.js'

const CAPABILITIES: PlatformCapabilities = {
  carousel: true, // multi-photo via attached_media
  image: true,
  limits: {
    minImageWidthPx: 320,
  },
  oauth: true,
  scheduling: true,
  serviceAccount: true,
  stories: false,
  video: true,
}

/**
 * Check whether a declared format is disallowed for this platform.
 * Used in validate() to surface a pre-publish error when autoConvert is off.
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
  const allowed = PLATFORM_IMAGE_CONSTRAINTS.facebook.formats as readonly string[]
  if (allowed.includes(format)) {
    return undefined
  }
  if (options.assets.autoConvert) {
    return undefined
  }
  return (
    `Image format "${format}" is not accepted by Facebook (allowed: ${allowed.join(', ')}). ` +
    `Configure a JPEG imageSize on your upload collection or enable assets.autoConvert.`
  )
}

export const createFacebookAdapter = (
  options: NormalizedPluginOptions,
): PlatformAdapter<FacebookPublishInput> => {
  return {
    id: 'facebook',
    capabilities: CAPABILITIES,
    label: 'Facebook',

    buildAuthorizeUrl({ state }) {
      return buildAuthorizeUrl(options, { platform: 'facebook', state })
    },

    async exchangeCallback({ code, options: opts, payload, req }) {
      const result = await exchangeCodeForTokens({
        code,
        options: opts,
        payload,
        platform: 'facebook',
        req,
      })
      const credentials = await getCredentials(payload, opts, 'facebook')
      return {
        accessToken: credentials?.accessToken ?? '',
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        scopes: result.scopes,
      }
    },

    async isConnected({ options: opts, payload }): Promise<ConnectionState> {
      if (opts.platforms.facebook.systemUserAccessToken) {
        return { accountLabel: 'Meta system user', connected: true, managedByConfig: true }
      }
      const credentials = await getCredentials(payload, opts, 'facebook')
      if (!credentials?.accessToken) {
        return {
          connected: false,
          lastError:
            'No Facebook access token — start OAuth flow or configure a system-user token.',
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
      const accessToken = await refreshMetaAccessToken(payload, opts, 'facebook')
      if (!accessToken) {
        throw new ValidationError('Facebook access token is unavailable')
      }
      const credentials = await getCredentials(payload, opts, 'facebook')
      return {
        accessToken,
        accessTokenExpiresAt: credentials?.accessTokenExpiresAt,
        scopes: credentials?.scopes,
      }
    },

    revokeAuthorization({ options: opts, payload }) {
      return revokeMetaAuthorization({ options: opts, payload, platform: 'facebook' })
    },

    preview(args: PreviewArgs): Promise<PreviewResult> {
      const message =
        options.copyOverrides.facebookMessage?.(args.ctx) ?? buildDefaultFacebookMessage(args.ctx)
      const primary = args.ctx.images[0]
      return Promise.resolve({
        body: message,
        imageUrl: primary?.url,
        link: args.ctx.link,
        meta: { supportedFormats: FACEBOOK_FORMATS },
        title: args.ctx.baseTitle,
      })
    },

    validate(args): ValidationResult {
      const issues: ValidationResult['issues'] = []
      const { ctx, input } = args
      if (!input?.pageId) {
        issues.push({ field: 'pageId', message: 'pageId is required', severity: 'error' })
      }
      const format = input?.format ?? 'LINK'
      if (!FACEBOOK_FORMATS.includes(format)) {
        issues.push({
          field: 'format',
          message: `format must be one of: ${FACEBOOK_FORMATS.join(', ')}`,
          severity: 'error',
        })
      }
      if (format === 'PHOTO' && !input?.imageUrl) {
        issues.push({ field: 'imageUrl', message: 'PHOTO requires imageUrl', severity: 'error' })
      }
      if (format === 'PHOTO_MULTI') {
        if (!input?.imageUrls || input.imageUrls.length < 2 || input.imageUrls.length > 10) {
          issues.push({
            field: 'imageUrls',
            message: 'PHOTO_MULTI requires 2–10 entries in imageUrls',
            severity: 'error',
          })
        }
      }
      if (format === 'VIDEO' && !input?.videoUrl) {
        issues.push({ field: 'videoUrl', message: 'VIDEO requires videoUrl', severity: 'error' })
      }
      if (format === 'LINK') {
        const link = input?.link ?? ctx.link
        const message =
          input?.message?.trim() ||
          options.copyOverrides.facebookMessage?.(ctx) ||
          buildDefaultFacebookMessage(ctx)
        if (!link && !message) {
          issues.push({
            message: 'LINK posts need either a link or a non-empty message',
            severity: 'error',
          })
        }
      }

      // Image format pre-publish check.
      if (format === 'PHOTO' && input?.imageUrl) {
        const imgMeta = ctx.images.find((img) => img.url === input.imageUrl)
        const formatIssue = checkFormatIssue(imgMeta?.format, args.options)
        if (formatIssue) {
          issues.push({ field: 'imageUrl', message: formatIssue, severity: 'error' })
        }
      }

      const hasError = issues.some((i) => i.severity === 'error')
      return { issues, ok: !hasError }
    },

    async publish(args: PublishArgs<FacebookPublishInput>): Promise<PublishedRef> {
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
        throw new ValidationError(`Facebook publish input invalid: ${errors}`)
      }
      try {
        const resolvedInput = await resolveFacebookImages(args)
        const result = await publishFacebookPost({
          ctx: args.ctx,
          input: resolvedInput,
          options: args.options,
          payload: args.payload,
          req: args.req,
        })
        return result.publishedRef
      } catch (error) {
        await recordConnectionError(args.payload, 'facebook', error)
        throw error
      }
    },

    async delete({ options: opts, payload, publishedRef }) {
      await deleteFacebookPost({ options: opts, payload, publishedRef })
    },

    async getInsights({ options: opts, payload, publishedRef }) {
      if (publishedRef.platform !== 'facebook' || !publishedRef.externalId) {
        return {}
      }
      return getFacebookInsightsForRef({
        options: opts,
        payload,
        publishedRef,
      })
    },
  }
}

/**
 * Resolve all image URLs in the Facebook publish input through the platform
 * image format safety layer.
 */
const resolveFacebookImages = async (
  args: PublishArgs<FacebookPublishInput>,
): Promise<FacebookPublishInput> => {
  const { input, options, payload } = args
  const format = input.format ?? 'LINK'
  const resolved = { ...input }

  if (format === 'PHOTO' && input.imageUrl) {
    const result = await resolvePlatformImageUrl({
      imageUrl: input.imageUrl,
      options,
      payload,
      platform: 'facebook',
    })
    resolved.imageUrl = result.url
  }

  if (format === 'PHOTO_MULTI' && input.imageUrls) {
    resolved.imageUrls = await Promise.all(
      input.imageUrls.map(async (url) => {
        const result = await resolvePlatformImageUrl({
          imageUrl: url,
          options,
          payload,
          platform: 'facebook',
        })
        return result.url
      }),
    )
  }

  return resolved
}
