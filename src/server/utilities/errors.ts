import type { PublishedRef } from '../../types/index.js'

import { PLUGIN_SLUG } from '../../constants.js'

/**
 * Custom error classes the endpoint handlers throw. Each carries a
 * `statusCode` property the response helper turns into an HTTP status.
 *
 * The `statusCode` convention (not the Web standard `status`) matches
 * Payload's own custom-error classes.
 */

export class PluginError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 500) {
    super(`${PLUGIN_SLUG}: ${message}`)
    this.name = 'PluginError'
    this.statusCode = statusCode
  }
}

export class ValidationError extends PluginError {
  constructor(message: string) {
    super(message, 400)
    this.name = 'ValidationError'
  }
}

export class UnauthorizedError extends PluginError {
  constructor(message = 'unauthenticated') {
    super(message, 401)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends PluginError {
  constructor(message = 'forbidden') {
    super(message, 403)
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends PluginError {
  constructor(message = 'not found') {
    super(message, 404)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends PluginError {
  constructor(message: string) {
    super(message, 409)
    this.name = 'ConflictError'
  }
}

export class RateLimitedError extends PluginError {
  /** Seconds the caller should wait before retrying (when known). */
  readonly retryAfterSeconds?: number
  constructor(message = 'rate limited', retryAfterSeconds?: number) {
    super(message, 429)
    this.name = 'RateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** One field-level message a provider returned with a rejected request. */
export type PlatformFieldViolation = { field?: string; message: string; reason?: string }

/**
 * Marker for errors that originated upstream from a third-party API. The
 * adapter layer wraps platform-specific errors in this so the publish
 * pipeline can classify them uniformly.
 */
export class PlatformApiError extends PluginError {
  readonly fieldViolations?: PlatformFieldViolation[]
  readonly outcome: 'failed' | 'unknown'
  readonly platform: string
  readonly raw?: unknown
  readonly retryable: boolean
  readonly upstreamCode?: number | string
  readonly upstreamMessage?: string

  constructor(args: {
    fieldViolations?: PlatformFieldViolation[]
    message: string
    outcome?: 'failed' | 'unknown'
    platform: string
    raw?: unknown
    retryable?: boolean
    statusCode?: number
    upstreamCode?: number | string
    upstreamMessage?: string
  }) {
    super(args.message, args.statusCode ?? 502)
    this.name = 'PlatformApiError'
    this.fieldViolations = args.fieldViolations
    this.outcome = args.outcome ?? 'failed'
    this.platform = args.platform
    this.upstreamCode = args.upstreamCode
    this.upstreamMessage = args.upstreamMessage
    this.retryable = args.retryable ?? false
    this.raw = args.raw
  }
}

export class PublicationPersistenceError extends PluginError {
  readonly cause: unknown
  readonly outcome = 'unknown'
  readonly publishedRef: PublishedRef

  constructor(publishedRef: PublishedRef, cause: unknown) {
    super(
      'The provider accepted the publication, but its local audit record could not be finalized.',
      500,
    )
    this.name = 'PublicationPersistenceError'
    this.cause = cause
    this.publishedRef = publishedRef
  }
}

export const hasUnknownPublicationOutcome = (error: unknown): boolean =>
  error instanceof PublicationPersistenceError ||
  (error instanceof PlatformApiError && error.outcome === 'unknown')

export const getUnknownPublicationRef = (error: unknown): PublishedRef | undefined =>
  error instanceof PublicationPersistenceError ? error.publishedRef : undefined
