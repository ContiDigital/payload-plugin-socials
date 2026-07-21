import { beforeEach, describe, expect, it } from 'vitest'

import type { PayloadPluginSocialsConfig } from '../../../types/index.js'

import { normalizePluginOptions } from '../../../plugin/normalizeOptions.js'
import { NotFoundError } from '../../utilities/errors.js'
import {
  __resetPlatformRegistry,
  getEnabledAdapters,
  getPlatformAdapter,
  initPlatformRegistry,
  listEnabledPlatforms,
} from '../registry.js'

const baseOptions: PayloadPluginSocialsConfig = {
  authorize: () => Promise.resolve(true),
  encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  platforms: {
    pinterest: {
      clientId: 'c',
      clientSecret: 's',
      enabled: true,
      redirectUri: 'https://example.com/cb',
    },
  },
  sources: { product: () => Promise.reject(new Error('stub')) },
}

const options = normalizePluginOptions(baseOptions)

beforeEach(() => {
  __resetPlatformRegistry()
})

describe('platform adapter registry', () => {
  it('instantiates only enabled platforms', () => {
    initPlatformRegistry(options)
    expect(listEnabledPlatforms(options)).toEqual(['pinterest'])
    expect(Object.keys(getEnabledAdapters(options))).toEqual(['pinterest'])
  })

  it('returns the adapter for an enabled platform with the matching id', () => {
    initPlatformRegistry(options)
    const adapter = getPlatformAdapter('pinterest', options)
    expect(adapter.id).toBe('pinterest')
  })

  it('throws NotFoundError for a disabled platform', () => {
    initPlatformRegistry(options)
    expect(() => getPlatformAdapter('facebook', options)).toThrow(NotFoundError)
  })

  it('initializes lazily for one isolated options object', () => {
    expect(getPlatformAdapter('pinterest', options).id).toBe('pinterest')
  })

  it('re-initialization clears the prior set', () => {
    initPlatformRegistry(options)
    const disabledOptions = normalizePluginOptions({
      ...baseOptions,
      platforms: { pinterest: { enabled: false } },
    })
    initPlatformRegistry(disabledOptions)
    expect(listEnabledPlatforms(disabledOptions)).toEqual([])
    expect(listEnabledPlatforms(options)).toEqual(['pinterest'])
  })
})
