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

/**
 * Marker for errors that originated upstream from a third-party API. The
 * adapter layer wraps platform-specific errors in this so the publish
 * pipeline can classify them uniformly.
 */
export class PlatformApiError extends PluginError {
  readonly platform: string
  readonly raw?: unknown
  readonly retryable: boolean
  readonly upstreamCode?: number | string
  readonly upstreamMessage?: string

  constructor(args: {
    message: string
    platform: string
    raw?: unknown
    retryable?: boolean
    statusCode?: number
    upstreamCode?: number | string
    upstreamMessage?: string
  }) {
    super(args.message, args.statusCode ?? 502)
    this.name = 'PlatformApiError'
    this.platform = args.platform
    this.upstreamCode = args.upstreamCode
    this.upstreamMessage = args.upstreamMessage
    this.retryable = args.retryable ?? false
    this.raw = args.raw
  }
}
