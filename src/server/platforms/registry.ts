import type {
  NormalizedPluginOptions,
  PlatformAdapter,
  PlatformAdapterRegistry,
  PlatformId,
} from '../../types/index.js'

import { PLATFORM_IDS, PLUGIN_SLUG } from '../../constants.js'
import { NotFoundError, PluginError } from '../utilities/errors.js'
import { createFacebookAdapter } from './facebook/adapter.js'
import { createGbpAdapter } from './gbp/adapter.js'
import { createInstagramAdapter } from './instagram/adapter.js'
import { createPinterestAdapter } from './pinterest/adapter.js'

/**
 * Platform adapter registry. Plugin entrypoint calls `initPlatformRegistry`
 * once during normalization; subsequent lookups by id are O(1).
 *
 * Each adapter is instantiated lazily: only platforms with `enabled: true`
 * in their config get an instance, so a host that only uses Pinterest pays
 * no cost for Meta/GBP wiring.
 */

const adaptersByOptions = new WeakMap<NormalizedPluginOptions, Map<PlatformId, PlatformAdapter>>()

type AdapterFactory = (options: NormalizedPluginOptions) => PlatformAdapter

const FACTORIES: Record<PlatformId, AdapterFactory> = {
  facebook: (opts) => createFacebookAdapter(opts),
  gbp: (opts) => createGbpAdapter(opts),
  instagram: (opts) => createInstagramAdapter(opts),
  pinterest: (opts) => createPinterestAdapter(opts),
}

const isPlatformEnabled = (options: NormalizedPluginOptions, id: PlatformId): boolean =>
  options.platforms[id].enabled === true

export const initPlatformRegistry = (options: NormalizedPluginOptions): void => {
  const adapters = new Map<PlatformId, PlatformAdapter>()
  for (const id of PLATFORM_IDS) {
    if (!isPlatformEnabled(options, id)) {
      continue
    }
    const factory = FACTORIES[id]
    const adapter = factory(options)
    if (adapter.id !== id) {
      throw new PluginError(
        `adapter factory for ${id} returned an adapter with id "${adapter.id}"`,
        500,
      )
    }
    adapters.set(id, adapter)
  }
  adaptersByOptions.set(options, adapters)
}

const getAdapters = (options: NormalizedPluginOptions): Map<PlatformId, PlatformAdapter> => {
  let adapters = adaptersByOptions.get(options)
  if (!adapters) {
    initPlatformRegistry(options)
    adapters = adaptersByOptions.get(options)
  }
  if (!adapters) {
    throw new PluginError('platform registry failed to initialize', 500)
  }
  return adapters
}

export const getPlatformAdapter = (
  id: PlatformId,
  options: NormalizedPluginOptions,
): PlatformAdapter => {
  const adapters = getAdapters(options)
  const adapter = adapters.get(id)
  if (!adapter) {
    throw new NotFoundError(`${PLUGIN_SLUG}: platform "${id}" is not enabled in plugin options`)
  }
  return adapter
}

export const listEnabledPlatforms = (options: NormalizedPluginOptions): readonly PlatformId[] =>
  Array.from(getAdapters(options).keys())

export const getEnabledAdapters = (options: NormalizedPluginOptions): PlatformAdapterRegistry => {
  const out: PlatformAdapterRegistry = {}
  for (const [id, adapter] of getAdapters(options).entries()) {
    out[id] = adapter
  }
  return out
}

/** Test-only escape hatch. */
export const __resetPlatformRegistry = (): void => {
  // WeakMap entries are isolated by normalized options and expire naturally.
}
