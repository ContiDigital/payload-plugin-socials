import type { PayloadRequest } from 'payload'

import type { AccessScope, AuthorizeFn, NormalizedPluginOptions } from '../../types/index.js'

import { ForbiddenError, UnauthorizedError } from './errors.js'

/**
 * Gate an endpoint by delegating to the host-supplied `authorize` function.
 * Throws `UnauthorizedError` (401) if no user is on the request, and
 * `ForbiddenError` (403) if the host denies.
 */
export const assertAccess = async (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
  scope: AccessScope,
): Promise<void> => {
  if (!req.user) {
    throw new UnauthorizedError('authentication required')
  }
  const allowed = await options.authorize({ payload: req.payload, req, scope })
  if (!allowed) {
    throw new ForbiddenError(`access denied (scope=${scope})`)
  }
}

/**
 * Non-throwing capability probe. Resolves to `true` only when a user is on the
 * request AND the host `authorize` returns a truthy value for the scope.
 * Anything thrown by the host function, or an unauthenticated request, resolves
 * to `false`. This is what drives admin-UI visibility: a surface renders only
 * when its scope probe is `true`. Never use this to gate a mutation — that is
 * `assertAccess`'s job (it preserves the 401 vs 403 distinction).
 */
export const evaluateAuthorize = async (
  req: PayloadRequest,
  authorize: AuthorizeFn,
  scope: AccessScope,
): Promise<boolean> => {
  if (!req.user) {
    return false
  }
  try {
    return Boolean(await authorize({ payload: req.payload, req, scope }))
  } catch {
    return false
  }
}

/** `evaluateAuthorize` bound to the plugin's normalized options. */
export const checkAccess = (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
  scope: AccessScope,
): Promise<boolean> => evaluateAuthorize(req, options.authorize, scope)
