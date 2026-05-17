import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { getCredentials } from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { policyFetch } from '../../utilities/requestPolicy.js'

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const revokeGbpAuthorization = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<void> => {
  const credentials = await getCredentials(payload, options, 'gbp')
  const token = credentials?.refreshToken ?? credentials?.accessToken
  if (!token) {
    return
  }
  const response = await policyFetch({
    config: options.rateLimit,
    init: {
      body: new URLSearchParams({ token }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    input: GOOGLE_REVOKE_URL,
    payload,
    scope: 'gbp:oauth',
  })
  if (response.ok) {
    return
  }
  const raw = await response.text().catch(() => '')
  if (response.status === 400 && raw.includes('invalid_token')) {
    return
  }
  throw new PlatformApiError({
    message: `Google authorization revocation failed: HTTP ${response.status}`,
    platform: 'gbp',
    raw,
    retryable: response.status >= 500 || response.status === 429,
    statusCode: 502,
    upstreamCode: response.status,
  })
}
