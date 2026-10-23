import type { Endpoint } from 'payload'

import type {
  NormalizedPluginOptions,
  SocialImageFormat,
  SocialSourceContext,
} from '../../types/index.js'
import type { ComposeTarget } from '../compose/composePublish.js'
import type { StandaloneComposeInput } from '../compose/standaloneContext.js'

import { PLATFORM_IDS } from '../../constants.js'
import { composeAndPublish, validateComposeTargets } from '../compose/composePublish.js'
import { buildStandaloneContext } from '../compose/standaloneContext.js'
import { assertAccess } from '../utilities/access.js'
import { ValidationError } from '../utilities/errors.js'
import { errorResponse, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { requireOneOf, requireString } from '../utilities/validation.js'

/**
 * Standalone composer endpoint.
 *
 *   POST {basePath}/compose/publish
 *
 * Body: `{ content: { title, body?, imageUrl?, images?, link?, metadata? },
 *          targets: [{ platform, input }] }`
 *
 * Composes one post from inline content (no source record) and publishes it to
 * every selected channel with per-channel error isolation. Returns 200 when at
 * least one channel published, 502 when every channel failed; per-channel
 * results carry each channel's published ref or error.
 */

const VALID_IMAGE_FORMATS: readonly string[] = ['avif', 'bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp']

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const coerceFormat = (value: unknown): SocialImageFormat | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const lower = value.trim().toLowerCase()
  return VALID_IMAGE_FORMATS.includes(lower) ? (lower as SocialImageFormat) : undefined
}

const coerceImages = (raw: unknown): StandaloneComposeInput['images'] => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const images = raw
    .map((item) => asRecord(item))
    .map((item) => ({
      format: coerceFormat(item.format),
      height: typeof item.height === 'number' ? item.height : undefined,
      role: optionalString(item.role),
      url: optionalString(item.url) ?? '',
      width: typeof item.width === 'number' ? item.width : undefined,
    }))
    .filter((img) => img.url.length > 0)
  return images.length > 0 ? images : undefined
}

/** Parse the shared compose body into a standalone context and its per-platform targets. */
const parseComposeRequest = (
  body: Record<string, unknown>,
): { ctx: SocialSourceContext; targets: ComposeTarget[] } => {
  const content = asRecord(body.content)
  const title = requireString(content.title, 'content.title')

  const rawTargets = Array.isArray(body.targets) ? body.targets : []
  if (rawTargets.length === 0) {
    throw new ValidationError('targets must be a non-empty array')
  }
  const targets = rawTargets.map((raw, index) => {
    const target = asRecord(raw)
    const platform = requireOneOf(target.platform, PLATFORM_IDS, `targets[${index}].platform`)
    return { input: asRecord(target.input), platform }
  })

  const ctx = buildStandaloneContext({
    body: optionalString(content.body),
    images: coerceImages(content.images),
    imageUrl: optionalString(content.imageUrl),
    link: optionalString(content.link),
    metadata: content.metadata ? asRecord(content.metadata) : undefined,
    modelLabel: optionalString(content.modelLabel),
    title,
  })
  return { ctx, targets }
}

export const createComposeEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const { ctx, targets } = parseComposeRequest(await parseRequestBody(req))

      const result = await composeAndPublish({
        ctx,
        options,
        payload: req.payload,
        req,
        targets,
      })

      return jsonResponse(
        { ...result, source: { id: ctx.sourceId, kind: ctx.sourceKind } },
        result.anyPublished ? 200 : 502,
      )
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/compose/publish`,
})

/**
 *   POST {basePath}/compose/validate
 *
 * Same body as `compose/publish`. Runs every target's adapter validation and returns
 * `{ ok, results: [{ platform, validation }], source }` (always 200 for a well-formed body). Never
 * reserves a `social-posts` row and never contacts a platform.
 */
export const createComposeValidateEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const { ctx, targets } = parseComposeRequest(await parseRequestBody(req))
      const result = await validateComposeTargets({ ctx, options, targets })
      return jsonResponse({ ...result, source: { id: ctx.sourceId, kind: ctx.sourceKind } })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/compose/validate`,
})

export const createComposeEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  createComposeEndpoint(options),
  createComposeValidateEndpoint(options),
]
