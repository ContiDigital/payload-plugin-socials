import { describe, expect, it } from 'vitest'

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlatformApiError,
  PluginError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../errors.js'

describe('PluginError taxonomy', () => {
  it('prefixes the message with the plugin slug and defaults to 500', () => {
    const err = new PluginError('something broke')
    expect(err).toBeInstanceOf(Error)
    expect(err.statusCode).toBe(500)
    expect(err.message).toContain('payload-plugin-socials:')
    expect(err.message).toContain('something broke')
  })

  it('honours an explicit status code', () => {
    expect(new PluginError('teapot', 418).statusCode).toBe(418)
  })

  it.each([
    [new ValidationError('bad input'), 400, 'ValidationError'],
    [new UnauthorizedError(), 401, 'UnauthorizedError'],
    [new ForbiddenError(), 403, 'ForbiddenError'],
    [new NotFoundError(), 404, 'NotFoundError'],
    [new ConflictError('dup'), 409, 'ConflictError'],
  ])('%s maps to the right status and name', (err, status, name) => {
    expect(err).toBeInstanceOf(PluginError)
    expect(err.statusCode).toBe(status)
    expect(err.name).toBe(name)
  })

  it('RateLimitedError carries an optional retryAfterSeconds', () => {
    const err = new RateLimitedError('slow down', 30)
    expect(err.statusCode).toBe(429)
    expect(err.retryAfterSeconds).toBe(30)
    expect(new RateLimitedError().retryAfterSeconds).toBeUndefined()
  })
})

describe('PlatformApiError', () => {
  it('defaults statusCode to 502 and retryable to false', () => {
    const err = new PlatformApiError({ message: 'upstream down', platform: 'pinterest' })
    expect(err).toBeInstanceOf(PluginError)
    expect(err.statusCode).toBe(502)
    expect(err.platform).toBe('pinterest')
    expect(err.retryable).toBe(false)
  })

  it('carries upstream metadata and the retryable flag', () => {
    const err = new PlatformApiError({
      message: 'rate limited',
      platform: 'instagram',
      raw: { code: 4 },
      retryable: true,
      statusCode: 429,
      upstreamCode: 4,
      upstreamMessage: 'too many calls',
    })
    expect(err.statusCode).toBe(429)
    expect(err.retryable).toBe(true)
    expect(err.upstreamCode).toBe(4)
    expect(err.upstreamMessage).toBe('too many calls')
    expect(err.raw).toEqual({ code: 4 })
  })
})
