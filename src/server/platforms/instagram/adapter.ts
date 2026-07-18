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

import { INSTAGRAM_CAPTION_MAX_CHARS, INSTAGRAM_CAPTION_MAX_HASHTAGS } from '../../../constants.js'
import { PLATFORM_IMAGE_CONSTRAINTS } from '../../assets/imagePreflight.js'
import { resolveConfiguredText } from '../../copy/resolveConfiguredCopy.js'
import { getCredentials, recordConnectionError } from '../../services/connectionService.js'
import { ValidationError } from '../../utilities/errors.js'
import { refreshMetaAccessToken } from '../_meta/api.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../_meta/oauth.js'
import { revokeMetaAuthorization } from '../_meta/revoke.js'
import { buildDefaultInstagramCaption, countHashtags, countMentions } from './copy.js'
import { getInstagramInsightsForRef } from './insights.js'
import {
  deleteInstagramMedia,
  INSTAGRAM_MEDIA_TYPES,
  type InstagramPublishInput,
  publishInstagramMedia,
} from './publish.js'

const CAPABILITIES: PlatformCapabilities = {
  carousel: true,
  image: true,
  limits: {
    captionMaxChars: INSTAGRAM_CAPTION_MAX_CHARS,
    hashtagsMax: INSTAGRAM_CAPTION_MAX_HASHTAGS,
    minImageWidthPx: 320,
  },
  oauth: true,
  scheduling: false,
  serviceAccount: true,
  stories: true,
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
  const allowed = PLATFORM_IMAGE_CONSTRAINTS.instagram.formats as readonly string[]
  if (allowed.includes(format)) {
    return undefined
  }
  if (options.assets.autoConvert) {
    return undefined
  }
  return (
    `Image format "${format}" is not accepted by Instagram (allowed: ${allowed.join(', ')}). ` +
    `Configure a JPEG imageSize on your upload collection or enable assets.autoConvert.`
  )
}

export const createInstagramAdapter = (
  options: NormalizedPluginOptions,
): PlatformAdapter<InstagramPublishInput> => {
  return {
    id: 'instagram',
    capabilities: CAPABILITIES,
    label: 'Instagram',

    buildAuthorizeUrl({ state }) {
      return buildAuthorizeUrl(options, { platform: 'instagram', state })
    },

    async exchangeCallback({ code, options: opts, payload, req }) {
      const result = await exchangeCodeForTokens({
        code,
        options: opts,
        payload,
        platform: 'instagram',
        req,
      })
      const credentials = await getCredentials(payload, opts, 'instagram')
      return {
        accessToken: credentials?.accessToken ?? '',
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        scopes: result.scopes,
      }
    },

    async isConnected({ options: opts, payload }): Promise<ConnectionState> {
      if (opts.platforms.instagram.systemUserAccessToken) {
        return { accountLabel: 'Meta system user', connected: true, managedByConfig: true }
      }
      const credentials = await getCredentials(payload, opts, 'instagram')
      if (!credentials?.accessToken) {
        return {
          connected: false,
          lastError:
            'No Instagram access token — start OAuth flow or configure a system-user token.',
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
      const accessToken = await refreshMetaAccessToken(payload, opts, 'instagram')
      if (!accessToken) {
        throw new ValidationError('Instagram access token is unavailable')
      }
      const credentials = await getCredentials(payload, opts, 'instagram')
      return {
        accessToken,
        accessTokenExpiresAt: credentials?.accessTokenExpiresAt,
        scopes: credentials?.scopes,
      }
    },

    revokeAuthorization({ options: opts, payload }) {
      return revokeMetaAuthorization({ options: opts, payload, platform: 'instagram' })
    },

    preview(args: PreviewArgs): Promise<PreviewResult> {
      const caption = resolveConfiguredText(
        'instagramCaption',
        args.ctx,
        options,
        buildDefaultInstagramCaption,
      )
      const primary = args.ctx.images[0]
      return Promise.resolve({
        body: caption,
        imageUrl: primary?.url,
        link: args.ctx.link,
        meta: {
          captionStats: {
            chars: caption.length,
            hashtags: countHashtags(caption),
            mentions: countMentions(caption),
          },
          supportedMediaTypes: INSTAGRAM_MEDIA_TYPES,
        },
        title: args.ctx.baseTitle,
      })
    },

    validate(args): ValidationResult {
      const issues: ValidationResult['issues'] = []
      const { ctx, input } = args
      const mediaType = input?.mediaType ?? 'IMAGE'

      if (!input?.igUserId) {
        issues.push({ field: 'igUserId', message: 'igUserId is required', severity: 'error' })
      }

      if (!INSTAGRAM_MEDIA_TYPES.includes(mediaType)) {
        issues.push({
          field: 'mediaType',
          message: `mediaType must be one of: ${INSTAGRAM_MEDIA_TYPES.join(', ')}`,
          severity: 'error',
        })
      }

      if (mediaType === 'IMAGE' && !input?.imageUrl) {
        issues.push({ field: 'imageUrl', message: 'IMAGE requires imageUrl', severity: 'error' })
      }
      if (mediaType === 'REELS' && !input?.videoUrl) {
        issues.push({ field: 'videoUrl', message: 'REELS requires videoUrl', severity: 'error' })
      }
      if (mediaType === 'STORIES' && !input?.imageUrl && !input?.videoUrl) {
        issues.push({
          message: 'STORIES requires imageUrl or videoUrl',
          severity: 'error',
        })
      }
      if (mediaType === 'CAROUSEL') {
        if (!input?.carouselChildren) {
          issues.push({
            field: 'carouselChildren',
            message: 'CAROUSEL requires carouselChildren',
            severity: 'error',
          })
        } else {
          if (input.carouselChildren.length < 2 || input.carouselChildren.length > 10) {
            issues.push({
              message: 'CAROUSEL requires 2–10 children',
              severity: 'error',
            })
          }
        }
      }

      // Image format pre-publish check (only surfaces when autoConvert is off).
      if (mediaType === 'IMAGE' && input?.imageUrl) {
        const imgMeta = ctx.images.find((img) => img.url === input.imageUrl)
        const formatIssue = checkFormatIssue(imgMeta?.format, args.options)
        if (formatIssue) {
          issues.push({ field: 'imageUrl', message: formatIssue, severity: 'error' })
        }
      }

      // Caption validation -- only when applicable.
      if (mediaType !== 'STORIES') {
        const caption =
          input?.caption ??
          resolveConfiguredText('instagramCaption', ctx, options, buildDefaultInstagramCaption)
        if (caption.length > INSTAGRAM_CAPTION_MAX_CHARS) {
          issues.push({
            field: 'caption',
            message: `Caption is ${caption.length} chars (max ${INSTAGRAM_CAPTION_MAX_CHARS})`,
            severity: 'error',
          })
        }
        if (countHashtags(caption) > INSTAGRAM_CAPTION_MAX_HASHTAGS) {
          issues.push({
            field: 'caption',
            message: `Too many hashtags (max ${INSTAGRAM_CAPTION_MAX_HASHTAGS})`,
            severity: 'error',
          })
        }
        if (countMentions(caption) > 20) {
          issues.push({
            field: 'caption',
            message: 'Too many @mentions (max 20)',
            severity: 'error',
          })
        }
      }

      const hasError = issues.some((i) => i.severity === 'error')
      return { issues, ok: !hasError }
    },

    async publish(args: PublishArgs<InstagramPublishInput>): Promise<PublishedRef> {
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
        throw new ValidationError(`Instagram publish input invalid: ${errors}`)
      }
      try {
        // Pass the ORIGINAL input — image conversion happens inside publishInstagramMedia,
        // only when constructing the outbound API container body, after keys are locked.
        const result = await publishInstagramMedia({
          ctx: args.ctx,
          input: args.input,
          options: args.options,
          payload: args.payload,
          req: args.req,
        })
        return result.publishedRef
      } catch (error) {
        await recordConnectionError(args.payload, 'instagram', error)
        throw error
      }
    },

    async delete({ options: opts, payload, publishedRef }) {
      await deleteInstagramMedia({ options: opts, payload, publishedRef })
    },

    async getInsights({ options: opts, payload, publishedRef }) {
      if (publishedRef.platform !== 'instagram' || !publishedRef.externalId) {
        return {}
      }
      return getInstagramInsightsForRef({
        options: opts,
        payload,
        publishedRef,
      })
    },
  }
}
