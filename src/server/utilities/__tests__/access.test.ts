import type { PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { AuthorizeFn, NormalizedPluginOptions } from '../../../types/index.js'

import { assertAccess, checkAccess, evaluateAuthorize } from '../access.js'
import { ForbiddenError, UnauthorizedError } from '../errors.js'

const fakeReq = (overrides: Record<string, unknown> = {}): PayloadRequest =>
  ({ payload: {}, ...overrides }) as unknown as PayloadRequest

const optionsWith = (authorize: NormalizedPluginOptions['authorize']): NormalizedPluginOptions =>
  ({ authorize }) as unknown as NormalizedPluginOptions

describe('assertAccess', () => {
  it('throws UnauthorizedError when there is no user on the request', async () => {
    const options = optionsWith(vi.fn().mockResolvedValue(true))
    await expect(assertAccess(fakeReq(), options, 'publisher')).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })

  it('throws ForbiddenError when the host denies', async () => {
    const options = optionsWith(vi.fn().mockResolvedValue(false))
    await expect(
      assertAccess(fakeReq({ user: { id: 1 } }), options, 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('resolves when authenticated and the host allows', async () => {
    const options = optionsWith(vi.fn().mockResolvedValue(true))
    await expect(
      assertAccess(fakeReq({ user: { id: 1 } }), options, 'publisher'),
    ).resolves.toBeUndefined()
  })

  it('passes the requested scope and request through to authorize', async () => {
    const authorize = vi.fn().mockResolvedValue(true)
    const req = fakeReq({ user: { id: 9 } })
    await assertAccess(req, optionsWith(authorize), 'admin')
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ req, scope: 'admin' }))
  })
})

describe('evaluateAuthorize', () => {
  it('returns false for an unauthenticated request and never invokes authorize', async () => {
    const authorize = vi.fn().mockResolvedValue(true) as unknown as AuthorizeFn
    await expect(evaluateAuthorize(fakeReq(), authorize, 'publisher')).resolves.toBe(false)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('returns true when authenticated and the host allows', async () => {
    const authorize = vi.fn().mockResolvedValue(true) as unknown as AuthorizeFn
    await expect(evaluateAuthorize(fakeReq({ user: { id: 1 } }), authorize, 'admin')).resolves.toBe(
      true,
    )
  })

  it('coerces a truthy non-boolean return (the resolved user) to true', async () => {
    const authorize = vi.fn().mockResolvedValue({ id: 1 }) as unknown as AuthorizeFn
    await expect(
      evaluateAuthorize(fakeReq({ user: { id: 1 } }), authorize, 'publisher'),
    ).resolves.toBe(true)
  })

  it('returns false when the host denies', async () => {
    const authorize = vi.fn().mockResolvedValue(false) as unknown as AuthorizeFn
    await expect(
      evaluateAuthorize(fakeReq({ user: { id: 1 } }), authorize, 'publisher'),
    ).resolves.toBe(false)
  })

  it('swallows anything the host authorize throws and returns false', async () => {
    const authorize = vi.fn().mockRejectedValue(new Error('boom')) as unknown as AuthorizeFn
    await expect(evaluateAuthorize(fakeReq({ user: { id: 1 } }), authorize, 'admin')).resolves.toBe(
      false,
    )
  })
})

describe('checkAccess', () => {
  it('delegates to the options.authorize function', async () => {
    const authorize = vi.fn().mockResolvedValue(true)
    const req = fakeReq({ user: { id: 5 } })
    await expect(checkAccess(req, optionsWith(authorize), 'admin')).resolves.toBe(true)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ req, scope: 'admin' }))
  })
})
