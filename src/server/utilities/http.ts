import type { PayloadRequest } from 'payload'

import { hasUnknownPublicationOutcome, PluginError, ValidationError } from './errors.js'
import { createPluginLogger } from './logger.js'

/**
 * HTTP plumbing shared by every endpoint factory.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const

export const jsonResponse = (body: unknown, statusCode = 200, headers?: HeadersInit): Response => {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    headers: { ...JSON_HEADERS, ...(headers ?? {}) },
    status: statusCode,
  })
}

export const noContentResponse = (): Response => new Response(null, { status: 204 })

export const toResponse = (value: unknown, statusCode?: number): Response => {
  if (value instanceof Response) {
    return value
  }
  if (value === undefined) {
    return noContentResponse()
  }
  return jsonResponse(value, statusCode ?? 200)
}

/**
 * Convert any caught error into a structured HTTP response. 5xx errors are
 * logged with full detail server-side but stripped to a generic message
 * client-side; 4xx errors expose their message verbatim.
 */
export const errorResponse = (req: PayloadRequest, error: unknown): Response => {
  const fallbackCode = 500
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode: unknown }).statusCode) || fallbackCode
      : fallbackCode

  const message = error instanceof Error ? error.message : 'Internal server error'

  if (statusCode >= 500) {
    const log = createPluginLogger(req.payload?.logger, { operation: 'http:error' })
    const details: Record<string, unknown> = {
      error: message,
      errorName: error instanceof Error ? error.name : typeof error,
      statusCode,
    }
    if (error && typeof error === 'object') {
      if ('raw' in error) {
        details.raw = (error as { raw?: unknown }).raw
      }
      if ('upstreamCode' in error) {
        details.upstreamCode = (error as { upstreamCode?: unknown }).upstreamCode
      }
    }
    log.error('Request failed', details)
  }

  const clientMessage = publicErrorMessage(error)
  const extras: Record<string, unknown> = {}
  if (
    typeof error === 'object' &&
    error !== null &&
    'retryAfterSeconds' in error &&
    typeof (error as { retryAfterSeconds?: number }).retryAfterSeconds === 'number'
  ) {
    extras.retryAfterSeconds = (error as { retryAfterSeconds: number }).retryAfterSeconds
  }
  if (
    statusCode < 500 &&
    typeof error === 'object' &&
    error !== null &&
    'fieldViolations' in error &&
    Array.isArray((error as { fieldViolations?: unknown }).fieldViolations)
  ) {
    extras.fieldViolations = (error as { fieldViolations: unknown[] }).fieldViolations
  }

  return jsonResponse({ error: clientMessage, ...extras }, statusCode)
}

export const publicErrorMessage = (error: unknown): string => {
  if (hasUnknownPublicationOutcome(error)) {
    return 'Provider outcome unknown; review the social post before retrying.'
  }
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode: unknown }).statusCode) || 500
      : 500
  if (statusCode >= 500) {
    return 'Internal server error'
  }
  return error instanceof Error ? error.message : 'Request failed'
}

/**
 * Parse the request body as a JSON object. Defensive against Payload's
 * variable `req` shape — REST, GraphQL, and local API all expose it
 * differently. Throws `ValidationError` (400) on non-object payloads.
 */
export const parseRequestBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  if (req.data && typeof req.data === 'object' && !Array.isArray(req.data)) {
    return req.data as Record<string, unknown>
  }

  if (typeof (req as unknown as { json?: () => Promise<unknown> }).json === 'function') {
    try {
      const parsed = await (req as unknown as { json: () => Promise<unknown> }).json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError('Request body must be a JSON object')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof PluginError) {
        throw error
      }
      throw new ValidationError('Request body is not valid JSON')
    }
  }

  return {}
}

/**
 * Extract a path (route) parameter from the request. Works around the fact that
 * `req.routeParams` is typed loosely on Payload's side. Returns undefined when
 * the parameter is absent or not a string. This is the single route-param
 * reader for every endpoint factory in the plugin.
 */
export const getRouteParam = (req: PayloadRequest, name: string): string | undefined => {
  const routeParams = (req as unknown as { routeParams?: Record<string, unknown> }).routeParams
  if (routeParams && typeof routeParams[name] === 'string') {
    return routeParams[name]
  }
  return undefined
}
