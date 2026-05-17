import type { Payload } from 'payload'

import type { NormalizedPluginOptions, PlatformId } from '../../../types/index.js'

import { getCredentials } from '../../services/connectionService.js'
import { PlatformApiError } from '../../utilities/errors.js'
import { makeMetaRequest } from './api.js'

type MetaPlatform = Extract<PlatformId, 'facebook' | 'instagram'>

export const revokeMetaAuthorization = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  platform: MetaPlatform
}): Promise<{ affectedPlatforms: PlatformId[] }> => {
  const credentials = await getCredentials(args.payload, args.options, args.platform)
  if (!credentials?.accessToken) {
    return { affectedPlatforms: [args.platform] }
  }
  const response = await makeMetaRequest(
    args.payload,
    args.options,
    args.platform,
    '/me/permissions',
    { accessToken: credentials.accessToken, init: { method: 'DELETE' } },
  )
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new PlatformApiError({
      message: `Meta authorization revocation failed: HTTP ${response.status}`,
      platform: args.platform,
      raw,
      retryable: response.status >= 500 || response.status === 429,
      statusCode: 502,
      upstreamCode: response.status,
    })
  }

  const appId = args.options.platforms[args.platform].appId
  const sibling: MetaPlatform = args.platform === 'facebook' ? 'instagram' : 'facebook'
  const siblingConfig = args.options.platforms[sibling]
  const affectsSibling = Boolean(
    appId &&
    siblingConfig.enabled &&
    siblingConfig.appId === appId &&
    !siblingConfig.systemUserAccessToken,
  )
  return { affectedPlatforms: affectsSibling ? [args.platform, sibling] : [args.platform] }
}
