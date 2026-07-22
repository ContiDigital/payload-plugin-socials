export const serializePinterestAuthorizationScopes = (scopes: readonly string[]): string =>
  scopes.join(',')

export const parsePinterestTokenResponseScopes = (scope: string | undefined): string[] =>
  (scope ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
