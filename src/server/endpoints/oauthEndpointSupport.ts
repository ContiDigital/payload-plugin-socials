import type { PayloadRequest } from 'payload'

/**
 * Shared helpers for the platform OAuth endpoint factories
 * (`createPinterestOauthEndpoints`, `createMetaOauthEndpoints`,
 * `createGbpOauthEndpoints`).
 *
 * These are the security-sensitive pieces of the Authorization Code flow:
 * reading the state cookie + state param off the callback request, and
 * minting / clearing the HttpOnly state cookie. Keeping them in one place
 * means the cookie hardening (HttpOnly, SameSite=Lax, Secure) is defined
 * once and audited once, instead of being copy-pasted per platform.
 */

/** Read a single cookie value from the request's `Cookie` header. */
export const readRequestCookie = (req: PayloadRequest, name: string): string | undefined => {
  const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers
  if (!headers) {
    return undefined
  }
  const raw = headers instanceof Headers ? headers.get('cookie') : headers.cookie
  if (!raw || typeof raw !== 'string') {
    return undefined
  }
  for (const pair of raw.split(';')) {
    const [key, value] = pair.trim().split('=')
    if (key === name && typeof value === 'string') {
      return decodeURIComponent(value)
    }
  }
  return undefined
}

/**
 * Read a query-string parameter, tolerating either a pre-parsed
 * `req.searchParams` (Payload populates this) or a raw `req.url` fallback.
 */
export const getSearchParam = (req: PayloadRequest, key: string): string | undefined => {
  const search = (req as unknown as { searchParams?: URLSearchParams }).searchParams
  if (search instanceof URLSearchParams) {
    return search.get(key) ?? undefined
  }
  const url = (req as unknown as { url?: string }).url
  if (typeof url === 'string') {
    try {
      return new URL(url, 'http://localhost').searchParams.get(key) ?? undefined
    } catch {
      /* malformed URL — fall through */
    }
  }
  return undefined
}

/** Build a hardened `Set-Cookie` value that stores an OAuth state token. */
export const buildStateCookie = (name: string, state: string, ttlSeconds: number): string =>
  [
    `${name}=${state}`,
    'Path=/',
    `Max-Age=${ttlSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ')

/** Build a `Set-Cookie` value that immediately expires an OAuth state cookie. */
export const clearStateCookie = (name: string): string =>
  `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
