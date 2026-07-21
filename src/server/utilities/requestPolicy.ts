import type { Payload } from 'payload'

import type { NormalizedRateLimitConfig } from '../../types/index.js'

import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RETRYABLE_ERROR_CODES,
} from '../../constants.js'
import { RateLimitedError } from './errors.js'

type PendingRequest = {
  resolve: () => void
}

type LimiterState = {
  active: number
  queue: PendingRequest[]
  starts: number[]
  timer?: ReturnType<typeof setTimeout>
}

const limiterRegistry = new WeakMap<Payload, Map<string, LimiterState>>()
const WINDOW_MS = 60_000

const RETRY_SAFE_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])

export const isSafeToRetryRequest = (init: RequestInit | undefined): boolean =>
  RETRY_SAFE_METHODS.has((init?.method ?? 'GET').toUpperCase())

const getLimiter = (payload: Payload, scope: string): LimiterState => {
  let byScope = limiterRegistry.get(payload)
  if (!byScope) {
    byScope = new Map()
    limiterRegistry.set(payload, byScope)
  }
  let state = byScope.get(scope)
  if (!state) {
    state = { active: 0, queue: [], starts: [] }
    byScope.set(scope, state)
  }
  return state
}

const pruneStarts = (state: LimiterState, now: number): void => {
  while (state.starts.length > 0 && state.starts[0] <= now - WINDOW_MS) {
    state.starts.shift()
  }
}

const drain = (state: LimiterState, config: NormalizedRateLimitConfig): void => {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  const now = Date.now()
  pruneStarts(state, now)
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxPerMinute = config.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE

  while (
    state.queue.length > 0 &&
    state.active < maxConcurrency &&
    state.starts.length < maxPerMinute
  ) {
    const next = state.queue.shift()
    if (!next) {
      break
    }
    state.active++
    state.starts.push(Date.now())
    next.resolve()
  }

  if (state.queue.length > 0 && state.starts.length >= maxPerMinute) {
    const delay = Math.max(1, state.starts[0] + WINDOW_MS - Date.now())
    state.timer = setTimeout(() => drain(state, config), delay)
  }
}

const acquireLocal = async (
  payload: Payload,
  scope: string,
  config: NormalizedRateLimitConfig | undefined,
): Promise<() => void> => {
  if (config?.enabled === false) {
    return () => {}
  }
  const state = getLimiter(payload, scope)
  if (state.queue.length >= DEFAULT_MAX_QUEUE_SIZE) {
    throw new RateLimitedError('outbound request queue is full', 1)
  }
  await new Promise<void>((resolve) => {
    state.queue.push({ resolve })
    drain(state, config ?? ({} as NormalizedRateLimitConfig))
  })
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    state.active = Math.max(0, state.active - 1)
    drain(state, config ?? ({} as NormalizedRateLimitConfig))
  }
}

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(init.signal?.reason)
  if (init.signal?.aborted) {
    abortFromCaller()
  } else {
    init.signal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  )
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const policyFetch = async (args: {
  config: NormalizedRateLimitConfig | undefined
  init?: RequestInit
  input: RequestInfo | URL
  payload: Payload
  scope: string
}): Promise<Response> => {
  const releaseLocal = await acquireLocal(args.payload, args.scope, args.config)
  let releaseDistributed: (() => Promise<void> | void) | undefined
  try {
    if (args.config?.acquireRequestLease) {
      const lease = await args.config.acquireRequestLease({
        maxConcurrency: args.config.maxConcurrency,
        maxRequestsPerMinute: args.config.maxRequestsPerMinute,
        scope: args.scope,
      })
      releaseDistributed = lease.release
    }
    return await fetchWithTimeout(
      args.input,
      args.init ?? {},
      args.config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    )
  } finally {
    try {
      await releaseDistributed?.()
    } finally {
      releaseLocal()
    }
  }
}

export const isRetryableNetworkError = (error: unknown): boolean => {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return true
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  const directCode = 'code' in error ? String((error as { code?: unknown }).code) : ''
  const cause = 'cause' in error ? (error as { cause?: unknown }).cause : undefined
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : ''
  return RETRYABLE_ERROR_CODES.has(directCode) || RETRYABLE_ERROR_CODES.has(causeCode)
}
