import type { PayloadRequest } from 'payload'

import { describe, expect, it } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { assertSchedulerApiKey } from '../apiKeyAuth.js'
import { UnauthorizedError } from '../errors.js'

const KEY = 'super-secret-scheduler-key'

const optionsWith = (internalApiKey?: string): NormalizedPluginOptions =>
  ({ scheduling: { internalApiKey } }) as unknown as NormalizedPluginOptions

const reqWithHeaders = (headers: Headers | Record<string, string>): PayloadRequest =>
  ({ headers }) as unknown as PayloadRequest

describe('assertSchedulerApiKey', () => {
  it('fails closed when no internalApiKey is configured', () => {
    expect(() => assertSchedulerApiKey(reqWithHeaders({}), optionsWith())).toThrow(
      UnauthorizedError,
    )
  })

  it('accepts the key via the x-socials-api-key header (plain object)', () => {
    expect(() =>
      assertSchedulerApiKey(reqWithHeaders({ 'x-socials-api-key': KEY }), optionsWith(KEY)),
    ).not.toThrow()
  })

  it('accepts the key via the x-api-key header (Headers instance)', () => {
    expect(() =>
      assertSchedulerApiKey(reqWithHeaders(new Headers({ 'x-api-key': KEY })), optionsWith(KEY)),
    ).not.toThrow()
  })

  it('accepts an Authorization: Bearer <key> header', () => {
    expect(() =>
      assertSchedulerApiKey(
        reqWithHeaders(new Headers({ authorization: `Bearer ${KEY}` })),
        optionsWith(KEY),
      ),
    ).not.toThrow()
  })

  it('accepts a raw key in the Authorization header', () => {
    expect(() =>
      assertSchedulerApiKey(reqWithHeaders({ authorization: KEY }), optionsWith(KEY)),
    ).not.toThrow()
  })

  it('rejects a wrong key', () => {
    expect(() =>
      assertSchedulerApiKey(reqWithHeaders({ 'x-api-key': 'nope' }), optionsWith(KEY)),
    ).toThrow(UnauthorizedError)
  })

  it('rejects when no key header is present', () => {
    expect(() => assertSchedulerApiKey(reqWithHeaders({}), optionsWith(KEY))).toThrow(
      UnauthorizedError,
    )
  })
})
