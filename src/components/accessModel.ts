/**
 * Pure, framework-free helpers behind the client-side access probe. The React
 * hook that consumes them lives in `useSocialsAccess.tsx`; keeping the branching
 * here makes it unit-testable without a DOM.
 */

export type AccessProbe = {
  admin: boolean
  publisher: boolean
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/**
 * Coerce the `{basePath}/access` response into a strict boolean probe. Any
 * non-ok response, missing body, or non-boolean field reads as `false` so the
 * caller fails closed (renders nothing) rather than open.
 */
export const parseAccessResponse = (ok: boolean, body: unknown): AccessProbe => {
  const record = asRecord(body)
  if (!ok || !record) {
    return { admin: false, publisher: false }
  }
  return {
    admin: record.admin === true,
    publisher: record.publisher === true,
  }
}

/**
 * Rebuild the plugin's endpoint base (`{apiRoute}{basePath}`) from the browser
 * config the same way every composer surface does. Reads `admin.custom.socials`
 * (the client-serialized path) with the documented `/api` and `/socials`
 * fallbacks.
 */
export const resolveSocialsEndpointBase = (config: unknown): string => {
  const root = asRecord(config)
  const routes = asRecord(root?.routes)
  const socials = asRecord(asRecord(asRecord(root?.admin)?.custom)?.socials)
  const apiRoute = typeof routes?.api === 'string' ? routes.api : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  return `${apiRoute.replace(/\/$/, '')}${basePath}`
}
