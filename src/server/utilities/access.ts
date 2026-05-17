import type { PayloadRequest } from 'payload'

import type { AccessScope, NormalizedPluginOptions } from '../../types/index.js'

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
