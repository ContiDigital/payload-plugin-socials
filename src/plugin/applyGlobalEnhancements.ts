import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { SOCIALS_CONNECTIONS_GLOBAL_SLUG } from '../constants.js'
import { buildSocialsConnectionsGlobal } from '../globals/socialsConnections.js'

export const applyGlobalEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.globals) {
    config.globals = []
  }
  if (!config.globals.some((g) => g.slug === SOCIALS_CONNECTIONS_GLOBAL_SLUG)) {
    config.globals.push(buildSocialsConnectionsGlobal(options.authorize))
  }
  return config
}
