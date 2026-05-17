import type { Endpoint, PayloadRequest } from 'payload'

import { createHmac } from 'node:crypto'

import type { NormalizedPluginOptions, PlatformId } from '../../types/index.js'

import { MAX_WEBHOOK_BODY_BYTES } from '../../constants.js'
import { constantTimeEqual } from '../utilities/encryption.js'
import { ForbiddenError, ValidationError } from '../utilities/errors.js'
import { errorResponse, jsonResponse } from '../utilities/http.js'
import { getSearchParam } from './oauthEndpointSupport.js'

type MetaPlatform = Extract<PlatformId, 'facebook' | 'instagram'>

const readSignedBody = async (req: PayloadRequest): Promise<string> => {
  const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new ValidationError('webhook body exceeds 1 MB')
  }
  const raw =
    typeof req.text === 'function'
      ? await req.text()
      : JSON.stringify((req as { data?: unknown } & PayloadRequest).data ?? {})
  if (Buffer.byteLength(raw) > MAX_WEBHOOK_BODY_BYTES) {
    throw new ValidationError('webhook body exceeds 1 MB')
  }
  return raw
}

const verifyMetaSignature = (raw: string, signature: null | string, appSecret: string): void => {
  if (!signature?.startsWith('sha256=')) {
    throw new ForbiddenError('missing X-Hub-Signature-256 header')
  }
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`
  if (!constantTimeEqual(signature, expected)) {
    throw new ForbiddenError('invalid Meta webhook signature')
  }
}

export const createMetaWebhookVerifyEndpoint = (
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Endpoint => ({
  handler: (req) => {
    try {
      const mode = getSearchParam(req, 'hub.mode')
      const token = getSearchParam(req, 'hub.verify_token')
      const challenge = getSearchParam(req, 'hub.challenge')
      if (mode !== 'subscribe' || !challenge || !options.webhooks.meta) {
        throw new ValidationError('invalid Meta webhook verification request')
      }
      if (!constantTimeEqual(token ?? '', options.webhooks.meta.verifyToken)) {
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      }
      return Promise.resolve(
        new Response(challenge, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          status: 200,
        }),
      )
    } catch (error) {
      return Promise.resolve(errorResponse(req, error))
    }
  },
  method: 'get',
  path: `${options.api.basePath}/${platform}/webhook`,
})

export const createMetaWebhookReceiveEndpoint = (
  options: NormalizedPluginOptions,
  platform: MetaPlatform,
): Endpoint => ({
  handler: async (req) => {
    try {
      const webhook = options.webhooks.meta
      if (!webhook) {
        throw new ValidationError('Meta webhook is not configured')
      }
      const raw = await readSignedBody(req)
      verifyMetaSignature(
        raw,
        req.headers.get('x-hub-signature-256'),
        options.platforms[platform].appSecret,
      )
      let event: Record<string, unknown>
      try {
        event = JSON.parse(raw) as Record<string, unknown>
      } catch {
        throw new ValidationError('Meta webhook body must be valid JSON')
      }
      await webhook.onEvent?.({ event, payload: req.payload, platform, req })
      return jsonResponse({ received: true })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/${platform}/webhook`,
})

export const createMetaWebhookEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.webhooks.meta) {
    return []
  }
  const endpoints: Endpoint[] = []
  for (const platform of ['facebook', 'instagram'] as const) {
    const config = options.platforms[platform]
    if (!config.enabled || !config.appSecret) {
      continue
    }
    endpoints.push(
      createMetaWebhookVerifyEndpoint(options, platform),
      createMetaWebhookReceiveEndpoint(options, platform),
    )
  }
  if (endpoints.length === 0) {
    throw new Error(
      'payload-plugin-socials: webhooks.meta requires an enabled Meta platform with appSecret',
    )
  }
  return endpoints
}
