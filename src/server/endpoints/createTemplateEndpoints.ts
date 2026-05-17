import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'
import type { SocialTemplateFields } from '../templates/resolveTemplateCopy.js'

import { SOCIAL_TEMPLATES_SLUG } from '../../constants.js'
import { resolveSourceContext } from '../sources/registry.js'
import { resolveTemplateCopy } from '../templates/resolveTemplateCopy.js'
import { assertAccess } from '../utilities/access.js'
import { errorResponse, getRouteParam, jsonResponse } from '../utilities/http.js'
import { requireIdentifier, requireString } from '../utilities/validation.js'

type SocialTemplateRow = {
  appliesTo?: null | PlatformId[]
  description?: null | string
  id: number | string
  name: string
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
      })
      const result = await req.payload.find({
        collection: SOCIAL_TEMPLATES_SLUG as never,
        depth: 0,
        limit: 100,
        overrideAccess: true,
        sort: 'name',
        where: { enabled: { equals: true } },
      })
      const templates = (result.docs as unknown as SocialTemplateRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        appliesTo: row.appliesTo ?? [],
        description: row.description ?? undefined,
        resolved: resolveTemplateCopy(row.templates ?? {}, ctx),
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

export const createTemplateEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  createResolvedTemplatesEndpoint(options),
]
