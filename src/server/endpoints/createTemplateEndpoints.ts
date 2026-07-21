import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'
import type { SocialTemplateFields } from '../templates/resolveTemplateCopy.js'

import { SOCIAL_TEMPLATES_SLUG } from '../../constants.js'
import { resolveSourceContext } from '../sources/registry.js'
import { buildTemplateScope } from '../templates/renderTemplate.js'
import { resolveTemplateCopy } from '../templates/resolveTemplateCopy.js'
import { assertAccess } from '../utilities/access.js'
import { errorResponse, getRouteParam, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { requireIdentifier, requireString } from '../utilities/validation.js'

type SocialTemplateRow = {
  appliesTo?: null | PlatformId[]
  description?: null | string
  id: number | string
  isDefault?: boolean | null
  name: string
  sourceKind?: null | string
  templates?: null | SocialTemplateFields
}

export const createResolvedTemplatesEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const sourceKind = requireString(getRouteParam(req, 'sourceKind'), 'sourceKind')
      const sourceId = requireIdentifier(getRouteParam(req, 'sourceId'), 'sourceId')
      const ctx = await resolveSourceContext({
        id: sourceId,
        kind: sourceKind,
        payload: req.payload,
        req,
        sources: options.sources,
      })
      const result = await req.payload.find({
        collection: SOCIAL_TEMPLATES_SLUG as never,
        depth: 0,
        limit: 100,
        overrideAccess: true,
        sort: 'name',
        // Templates are bound to a source kind — only return the ones authored
        // for the collection the composer is publishing from.
        where: {
          and: [{ enabled: { equals: true } }, { sourceKind: { equals: sourceKind } }],
        },
      })
      const templates = (result.docs as unknown as SocialTemplateRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        appliesTo: row.appliesTo ?? [],
        description: row.description ?? undefined,
        isDefault: row.isDefault === true,
        resolved: resolveTemplateCopy(row.templates ?? {}, ctx),
        sourceKind: row.sourceKind ?? sourceKind,
      }))

      return jsonResponse({
        source: { id: String(sourceId), kind: sourceKind },
        templates,
      })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/templates/:sourceKind/:sourceId`,
})

/**
 * POST {basePath}/templates/preview
 *
 * Body: { sourceKind: string; sourceId: string; fields: Record<string, string> }
 *
 * Returns the resolved copy for the supplied per-field draft template strings
 * plus the full list of scope keys (including discovered metadata.* keys) so
 * the admin UI can populate the token picker.
 *
 * Gated with `assertAccess(req, options, 'admin')` — template authoring is an
 * admin-level operation, matching who authors templates.
 */
export const createTemplatePreviewEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')

      const body = await parseRequestBody(req)
      const sourceKind = requireString(body.sourceKind, 'sourceKind')
      const sourceId = requireIdentifier(body.sourceId, 'sourceId')
      const fields =
        body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
          ? (body.fields as Record<string, string>)
          : {}

      const ctx = await resolveSourceContext({
        id: sourceId,
        kind: sourceKind,
        payload: req.payload,
        req,
        sources: options.sources,
      })

      const resolved = resolveTemplateCopy(fields as SocialTemplateFields, ctx)

      // Build the full scope to expose all available token keys (including
      // every key in metadata.*) so the client can populate the token picker.
      const scope = buildTemplateScope(ctx)
      const rawMetadata: unknown = scope.metadata
      const metadataKeys =
        rawMetadata && typeof rawMetadata === 'object'
          ? Object.keys(rawMetadata as Record<string, unknown>).map((key) => `metadata.${key}`)
          : []

      const staticKeys = Object.keys(scope).filter((k) => k !== 'metadata')
      const scopeKeys = [...staticKeys, ...metadataKeys]

      return jsonResponse({ resolved, scopeKeys })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/templates/preview`,
})

export const createTemplateEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  createResolvedTemplatesEndpoint(options),
  createTemplatePreviewEndpoint(options),
]
