import type { Payload, PayloadRequest } from 'payload'

import type {
  SocialSourceContext,
  SocialSourceKind,
  SourceContextResolver,
  SourceResolverRegistry,
} from '../../types/index.js'

import { PLUGIN_SLUG } from '../../constants.js'
import { NotFoundError, PluginError } from '../utilities/errors.js'

/**
 * Source resolver registry. The host registers `(kind, resolver)` pairs via
 * the plugin's `sources` option; the plugin's endpoints dispatch on `kind`
 * to load the channel-agnostic `SocialSourceContext` for an entity.
 *
 * The registry is keyed by `string` rather than a closed enum so hosts can
 * introduce arbitrary new source kinds without a plugin release.
 */

const resolvers = new Map<SocialSourceKind, SourceContextResolver>()

export const registerSourceResolvers = (registry: SourceResolverRegistry): void => {
  resolvers.clear()
  for (const [kind, resolver] of Object.entries(registry)) {
    if (typeof resolver !== 'function') {
      throw new PluginError(`source resolver for kind "${kind}" must be a function`, 500)
    }
    resolvers.set(kind, resolver)
  }
}

export const getRegisteredSourceKinds = (): readonly SocialSourceKind[] =>
  Array.from(resolvers.keys())

export const hasSourceResolver = (kind: SocialSourceKind): boolean => resolvers.has(kind)

/**
 * Resolve a source context. Throws `NotFoundError` (404) when the requested
 * kind has no registered resolver — that maps to a clean admin-UI error
 * rather than a 500.
 */
export const resolveSourceContext = async (args: {
  id: number | string
  kind: SocialSourceKind
  payload: Payload
  req?: PayloadRequest
}): Promise<SocialSourceContext> => {
  const resolver = resolvers.get(args.kind)
  if (!resolver) {
    throw new NotFoundError(`${PLUGIN_SLUG}: no source resolver registered for kind "${args.kind}"`)
  }
  const context = await resolver({ id: args.id, payload: args.payload, req: args.req })
  if (!context || typeof context !== 'object') {
    throw new PluginError(`source resolver for kind "${args.kind}" returned no context`, 500)
  }
  if (context.sourceKind !== args.kind) {
    throw new PluginError(
      `source resolver for kind "${args.kind}" returned sourceKind "${context.sourceKind}"`,
      500,
    )
  }
  if (!context.sourceId || !context.baseTitle || !Array.isArray(context.images)) {
    throw new PluginError(
      `source resolver for kind "${args.kind}" returned an incomplete context`,
      500,
    )
  }
  return context
}

/**
 * Test-only escape hatch — clears every registered resolver. Never call
 * this from runtime code.
 */
export const __resetSourceResolverRegistry = (): void => {
  resolvers.clear()
}
