import type { PayloadRequest } from 'payload'

import { createHash, timingSafeEqual } from 'node:crypto'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { UnauthorizedError } from './errors.js'

/**
 * Constant-time API-key comparison. Two strings of different length are not
 * equal but we STILL run a timing-safe compare against their sha-256 digests
 * to keep timing observability flat — otherwise an attacker can learn the
 * expected key's length from response time.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length === bufB.length) {
    return timingSafeEqual(bufA, bufB)
  }
  const hashA = createHash('sha256').update(bufA).digest()
  const hashB = createHash('sha256').update(bufB).digest()
  timingSafeEqual(hashA, hashB)
  return false
}

const HEADER_NAMES = ['x-socials-api-key', 'x-api-key', 'authorization'] as const

const extractApiKey = (req: PayloadRequest): string | undefined => {
  const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers
  if (!headers) {
    return undefined
  }

  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      const v = headers.get(name)
      return v === null ? undefined : v
    }
    const v = headers[name]
    return typeof v === 'string' ? v : undefined
  }

  for (const name of HEADER_NAMES) {
    const value = getHeader(name)
    if (typeof value === 'string' && value.length > 0) {
      if (name === 'authorization') {
        // Accept either `Bearer <key>` or the raw key in the header.
        const match = value.match(/^Bearer\s+(\S.*)$/i)
        if (match) {
          return match[1].trim()
        }
        return value.trim()
      }
      return value.trim()
    }
  }
  return undefined
}

/**
 * Gate an endpoint by the host-supplied scheduler API key. Used for the
 * `internal` routes that external schedulers (AWS EventBridge, Vercel cron,
 * GitHub Actions, etc.) call to trigger work — those callers don't have a
 * Payload session, so role-based access doesn't apply.
 */
export const assertSchedulerApiKey = (
  req: PayloadRequest,
  options: NormalizedPluginOptions,
): void => {
  const expected = options.scheduling.internalApiKey
  if (!expected) {
    // Plugin explicitly disabled this endpoint — fail closed.
    throw new UnauthorizedError(
      'internal scheduler endpoints require scheduling.internalApiKey to be configured',
    )
  }
  const provided = extractApiKey(req)
  if (!provided || !constantTimeEqual(provided, expected)) {
    throw new UnauthorizedError('invalid or missing scheduler API key')
  }
}
