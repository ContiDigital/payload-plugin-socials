import type { Payload } from 'payload'

import { LOG_PREFIX } from '../../constants.js'

type LogLevel = 'debug' | 'error' | 'info' | 'warn'
type LogMethod = (...args: unknown[]) => void

export type PluginLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

type PayloadLogger = null | Payload['logger'] | undefined

// Exact key names to redact (case-insensitive). Covers request/response
// headers and keys the suffix rule below does not catch (e.g. encryption_key,
// which ends in a generic `key` we deliberately do not treat as a suffix).
const REDACT_EXACT = new Set([
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'app_secret',
  'appsecret',
  'appsecret_proof',
  'authorization',
  'client_secret',
  'clientsecret',
  'cookie',
  'encryption_key',
  'encryptionkey',
  'password',
  'private_key',
  'privatekey',
  'refresh_token',
  'refreshtoken',
  'set-cookie',
])

// Any key whose alphanumeric-compacted form ENDS WITH one of these is redacted,
// so prefixed variants never slip through: `pinAccessToken`, `systemUserAccessToken`,
// `pageAccessToken`, `clientSecret`, `x-api-key`, `saPrivateKey`, and so on. The
// suffixes are chosen to leave safe keys intact: `idempotencyKey`, `sortKey`,
// and `tokenCount` are all preserved.
const REDACT_SUFFIXES = ['token', 'secret', 'password', 'passphrase', 'apikey', 'privatekey']

const shouldRedactKey = (key: string): boolean => {
  const lower = key.toLowerCase()
  if (REDACT_EXACT.has(lower)) {
    return true
  }
  const compact = lower.replace(/[^a-z0-9]/g, '')
  return REDACT_SUFFIXES.some((suffix) => compact.endsWith(suffix))
}

export const redactSecretString = (value: string): string =>
  value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:access_token|refresh_token|client_secret|app_secret|appsecret_proof|api_key|private_key|encryption_key|password|authorization|cookie|set-cookie)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /("(?:access_token|refresh_token|client_secret|app_secret|appsecret_proof|api_key|private_key|encryption_key|password|authorization|cookie|set-cookie)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    )

const noop: LogMethod = () => {}

const resolveLogMethod = (logger: PayloadLogger, level: LogLevel): LogMethod => {
  if (!logger) {
    return noop
  }
  const method = (logger as Record<LogLevel, unknown>)[level]
  if (typeof method !== 'function') {
    return noop
  }
  return method.bind(logger) as LogMethod
}

const redact = (input: unknown, depth = 0): unknown => {
  if (depth > 8) {
    return '[truncated]'
  }
  if (input === null || input === undefined) {
    return input
  }
  if (Array.isArray(input)) {
    return input.map((v) => redact(v, depth + 1))
  }
  if (typeof input === 'string') {
    return redactSecretString(input)
  }
  if (typeof input !== 'object') {
    return input
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (shouldRedactKey(key)) {
      out[key] = '[REDACTED]'
      continue
    }
    out[key] = redact(value, depth + 1)
  }
  return out
}

export const createPluginLogger = (
  payloadLogger: PayloadLogger,
  context?: Record<string, unknown>,
): PluginLogger => {
  if (!payloadLogger) {
    return { debug: noop, error: noop, info: noop, warn: noop }
  }

  const wrap = (level: LogLevel): PluginLogger[LogLevel] => {
    const method = resolveLogMethod(payloadLogger, level)
    return (message: string, meta?: Record<string, unknown>) => {
      try {
        const merged = context || meta ? { ...context, ...meta } : undefined
        const safeMessage = `${LOG_PREFIX} ${redactSecretString(message)}`
        if (merged) {
          method(redact(merged), safeMessage)
        } else {
          method(safeMessage)
        }
      } catch {
        // Host logging failures must never change the business operation outcome.
      }
    }
  }

  return {
    debug: wrap('debug'),
    error: wrap('error'),
    info: wrap('info'),
    warn: wrap('warn'),
  }
}

/**
 * Helper for the common case of logging an unhandled async failure inside a
 * fire-and-forget block. Never throws.
 */
export const logAsyncOperationFailure = (
  payload: null | Payload | undefined,
  operation: string,
  error: unknown,
): void => {
  const log = createPluginLogger(payload?.logger, { operation })
  const message = error instanceof Error ? error.message : String(error)
  log.error('Async operation failed', { error: message })
}
