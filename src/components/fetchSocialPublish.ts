import {
  SOCIAL_PUBLISH_ASYNC_HEADER,
  SOCIAL_PUBLISH_POLL_DEADLINE_MS,
  SOCIAL_PUBLISH_POLL_DEFAULT_SECONDS,
  SOCIAL_PUBLISH_POLL_MAX_SECONDS,
  SOCIAL_PUBLISH_POLL_MIN_SECONDS,
  SOCIAL_PUBLISH_REQUESTS_SEGMENT,
  SOCIAL_PUBLISH_STATUS_HEADER,
  SOCIAL_PUBLISH_STATUS_PENDING,
} from '../constants.js'

export type FetchSocialPublishOptions = {
  /** The plugin REST base, for example `/api/socials`; status URLs must live under it. */
  endpointBase: string
}

const UNCERTAIN =
  'Publishing is still being processed or could not be checked. Check the post history before retrying.'
const INVALID_STATUS_URL = 'Invalid publishing status URL. Check the post history before retrying.'

const isPending = (response: Response): boolean =>
  response.status === 202 &&
  response.headers.get(SOCIAL_PUBLISH_STATUS_HEADER) === SOCIAL_PUBLISH_STATUS_PENDING

const wait = (milliseconds: number, signal: AbortSignal | null | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      const reason: unknown = signal?.reason
      reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })

// The status URL comes from the response, so only a same-origin URL under the
// plugin's own requests path with a numeric id and no query or fragment is polled.
const resolveStatusUrl = (
  location: null | string,
  origin: URL,
  endpointBase: string,
): undefined | URL => {
  if (!location) {
    return undefined
  }
  const candidate = new URL(location, origin)
  const expectedPath = `${endpointBase.replace(/\/$/, '')}/${SOCIAL_PUBLISH_REQUESTS_SEGMENT}/`
  if (
    candidate.origin !== origin.origin ||
    !candidate.pathname.startsWith(expectedPath) ||
    !/^\d+$/.test(candidate.pathname.slice(expectedPath.length)) ||
    candidate.search ||
    candidate.hash
  ) {
    return undefined
  }
  return candidate
}

const retryDelayMs = (response: Response): number => {
  const seconds = Number(response.headers.get('Retry-After')) || SOCIAL_PUBLISH_POLL_DEFAULT_SECONDS
  return (
    Math.min(SOCIAL_PUBLISH_POLL_MAX_SECONDS, Math.max(SOCIAL_PUBLISH_POLL_MIN_SECONDS, seconds)) *
    1000
  )
}

/**
 * Submit a publish request and, when the host defers it, keep polling the
 * status URL until the original provider response is available. The request
 * is submitted exactly once; polling only reads.
 */
export const fetchSocialPublish = async (
  url: string,
  init: RequestInit,
  { endpointBase }: FetchSocialPublishOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set(SOCIAL_PUBLISH_ASYNC_HEADER, '1')
  let response = await fetch(url, { ...init, headers })

  const origin = new URL(url, window.location.href)
  const deadline = Date.now() + SOCIAL_PUBLISH_POLL_DEADLINE_MS

  while (isPending(response)) {
    if (Date.now() >= deadline) {
      throw new Error(UNCERTAIN)
    }
    const statusUrl = resolveStatusUrl(response.headers.get('Location'), origin, endpointBase)
    if (!statusUrl) {
      throw new Error(INVALID_STATUS_URL)
    }
    await wait(retryDelayMs(response), init.signal)
    try {
      response = await fetch(statusUrl.href, {
        cache: 'no-store',
        credentials: 'same-origin',
        method: 'GET',
        signal: init.signal,
      })
    } catch (error) {
      if (init.signal?.aborted) {
        throw error
      }
      throw new Error(UNCERTAIN)
    }
  }
  return response
}
