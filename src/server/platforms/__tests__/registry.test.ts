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
    expect(listEnabledPlatforms()).toEqual(['pinterest'])
    expect(Object.keys(getEnabledAdapters())).toEqual(['pinterest'])
  })

  it('returns the adapter for an enabled platform with the matching id', () => {
    initPlatformRegistry(options)
    const adapter = getPlatformAdapter('pinterest')
    expect(adapter.id).toBe('pinterest')
  })

  it('throws NotFoundError for a disabled platform', () => {
    initPlatformRegistry(options)
    expect(() => getPlatformAdapter('facebook')).toThrow(NotFoundError)
  })

  it('throws NotFoundError when nothing has been initialized', () => {
    expect(() => getPlatformAdapter('pinterest')).toThrow(NotFoundError)
  })

  it('re-initialization clears the prior set', () => {
    initPlatformRegistry(options)
    initPlatformRegistry(
      normalizePluginOptions({ ...baseOptions, platforms: { pinterest: { enabled: false } } }),
    )
    expect(listEnabledPlatforms()).toEqual([])
  })
})
