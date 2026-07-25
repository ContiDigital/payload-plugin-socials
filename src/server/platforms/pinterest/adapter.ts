import type {
  ConnectionState,
  NormalizedPluginOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PreviewArgs,
  PreviewResult,
  PublishArgs,
  PublishedRef,
  ValidationResult,
} from '../../../types/index.js'

import {
  PINTEREST_DESCRIPTION_MAX,
  PINTEREST_HASHTAGS_MAX,
  PINTEREST_MIN_IMAGE_WIDTH,
  PINTEREST_TITLE_MAX,
} from '../../../constants.js'
import { getImageFormatValidationIssue } from '../../assets/validateImageFormat.js'
import { getCredentials, recordConnectionError } from '../../services/connectionService.js'
import { ValidationError } from '../../utilities/errors.js'
import { refreshPinterestAccessToken } from './api.js'
import { getPinterestInsightsForRef } from './insights.js'
import { buildAuthorizeUrl, exchangeCodeForTokens } from './oauth.js'
import {
  buildPinterestPreview,
  deletePinterestPin,
  type PinterestPublishInput,
  publishPinterestPin,
} from './publish.js'

const CAPABILITIES: PlatformCapabilities = {
  carousel: false,
  image: true,
  limits: {
    captionMaxChars: PINTEREST_DESCRIPTION_MAX,
    hashtagsMax: PINTEREST_HASHTAGS_MAX,
    minImageWidthPx: PINTEREST_MIN_IMAGE_WIDTH,
    titleMaxChars: PINTEREST_TITLE_MAX,
  },
  oauth: true,
  scheduling: false,
  serviceAccount: false,
  stories: false,
  video: true,
}

export const createPinterestAdapter = (
  options: NormalizedPluginOptions,
): PlatformAdapter<PinterestPublishInput> => {
  return {
    id: 'pinterest',
    capabilities: CAPABILITIES,
    label: 'Pinterest',

    buildAuthorizeUrl({ state }) {
      return buildAuthorizeUrl(options, { state })
    },

    async exchangeCallback({ code, options: opts, payload, req }) {
      const result = await exchangeCodeForTokens({ code, options: opts, payload, req })
      const credentials = await getCredentials(payload, opts, 'pinterest')
      return {
        accessToken: credentials?.accessToken ?? '',
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        accountId: result.accountId,
        accountLabel: result.accountLabel,
        refreshToken: credentials?.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
        scopes: result.scopes,
      }
    },

    async isConnected({ options: opts, payload }): Promise<ConnectionState> {
      const credentials = await getCredentials(payload, opts, 'pinterest')
      if (!credentials?.refreshToken) {
        return {
          connected: false,
          lastError: 'No Pinterest refresh token persisted — start OAuth flow to connect.',
        }
      }
      return {
        accessTokenExpiresAt: credentials.accessTokenExpiresAt,
        accountLabel: credentials.accountLabel,
        connected: true,
        refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
        scopes: credentials.scopes,
      }
    },

    async refreshToken({ options: opts, payload }) {
      const accessToken = await refreshPinterestAccessToken(payload, opts)
      const credentials = await getCredentials(payload, opts, 'pinterest')
      return {
        accessToken,
        accessTokenExpiresAt: credentials?.accessTokenExpiresAt,
        refreshToken: credentials?.refreshToken,
        refreshTokenExpiresAt: credentials?.refreshTokenExpiresAt,
        scopes: credentials?.scopes,
      }
    },

    preview(args: PreviewArgs): Promise<PreviewResult> {
      const preview = buildPinterestPreview(args.ctx, options)
      return Promise.resolve({
        altText: preview.altText,
        body: preview.description,
        hashtags: preview.hashtags,
        imageUrl: preview.defaultImageUrl,
        link: preview.link,
        meta: {
          availableImages: preview.availableImages,
          environment: options.platforms.pinterest.environment,
          source: preview.source,
        },
        title: preview.title,
      })
    },

    validate(args): ValidationResult {
      const issues: ValidationResult['issues'] = []
      const { ctx, input } = args
      const mediaType = input?.mediaType ?? 'IMAGE'
      if (mediaType !== 'IMAGE' && mediaType !== 'VIDEO') {
        issues.push({
          field: 'mediaType',
          message: 'mediaType must be IMAGE or VIDEO',
          severity: 'error',
        })
      }
      if (mediaType === 'IMAGE' && !ctx.images.length && !input?.imageUrl) {
        issues.push({
          message: 'Pinterest image Pins require at least one image',
          severity: 'error',
        })
      }
      if (mediaType === 'VIDEO' && !input?.videoUrl && !input?.mediaId && !ctx.videos?.length) {
        issues.push({
          message: 'Pinterest video Pins require videoUrl or mediaId',
          severity: 'error',
        })
      }
      if (
        mediaType === 'VIDEO' &&
        !input?.coverImageUrl &&
        !ctx.videos?.[0]?.coverImageUrl &&
        !ctx.images.length
      ) {
        issues.push({ message: 'Pinterest video Pins require a cover image', severity: 'error' })
      }
      const chosenImageUrl = input?.imageUrl?.trim() ?? ''
      const primary = chosenImageUrl
        ? (ctx.images.find((img) => img.url === chosenImageUrl) ?? ctx.images[0])
        : ctx.images[0]
      if (mediaType === 'IMAGE' && primary?.belowMinWidth) {
        issues.push({
          field: 'image',
          message: `Image is below Pinterest's ${PINTEREST_MIN_IMAGE_WIDTH}px minimum width`,
          severity: 'error',
        })
      }

      // Image format pre-publish check.
      if (mediaType === 'IMAGE') {
        const imgFormat = primary?.format
        const formatIssue = getImageFormatValidationIssue(
          imgFormat,
          args.options,
          'pinterest',
          'Pinterest',
        )
        if (formatIssue) {
          issues.push({ field: 'imageUrl', message: formatIssue, severity: 'error' })
        }
      }

      if (!ctx.link && !input?.link) {
        issues.push({
          message: 'No outbound link set — pin will not drive traffic',
          severity: 'warning',
        })
      }
      if (!input?.boardId) {
        issues.push({ field: 'boardId', message: 'boardId is required', severity: 'error' })
      }
      const hasError = issues.some((i) => i.severity === 'error')
      return { issues, ok: !hasError }
    },

    async publish(args: PublishArgs<PinterestPublishInput>): Promise<PublishedRef> {
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
        throw new ValidationError(`Pinterest publish input invalid: ${errors}`)
      }
      try {
        // Pass the ORIGINAL input — image conversion happens inside publishPinterestPin,
        // only when constructing the outbound API request body, after keys are locked.
        const result = await publishPinterestPin({
          ctx: args.ctx,
          input: args.input,
          options: args.options,
          payload: args.payload,
          req: args.req,
        })
        return result.publishedRef
      } catch (error) {
        await recordConnectionError(args.payload, 'pinterest', error)
        throw error
      }
    },

    async delete({ options: opts, payload, publishedRef }) {
      await deletePinterestPin({ options: opts, payload, publishedRef })
    },

    async getInsights({ options: opts, payload, publishedRef, range }) {
      if (publishedRef.platform !== 'pinterest' || !publishedRef.externalId) {
        return {}
      }
      return getPinterestInsightsForRef({
        externalId: publishedRef.externalId,
        options: opts,
        payload,
        range,
      })
    },
  }
}
