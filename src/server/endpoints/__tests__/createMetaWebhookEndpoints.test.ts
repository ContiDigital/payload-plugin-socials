import type { Endpoint, PayloadRequest } from 'payload'

import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import {
  createMetaWebhookEndpoints,
  createMetaWebhookReceiveEndpoint,
  createMetaWebhookVerifyEndpoint,
} from '../createMetaWebhookEndpoints.js'

const onEvent = vi.fn()
const options = {
  api: { basePath: '/socials' },
  platforms: {
    facebook: { appSecret: 'app-secret', enabled: true },
    instagram: { appSecret: 'app-secret', enabled: true },
  },
  webhooks: { meta: { onEvent, verifyToken: 'verify-me' } },
} as unknown as NormalizedPluginOptions

const run = (endpoint: Endpoint, request: Request): Promise<Response> =>
  Promise.resolve(
    endpoint.handler(Object.assign(request, { payload: {} }) as unknown as PayloadRequest),
  )

describe('Meta webhook endpoints', () => {
  it('echoes the challenge only for the configured verification token', async () => {
    const endpoint = createMetaWebhookVerifyEndpoint(options, 'facebook')
    const accepted = await run(
      endpoint,
      new Request(
        'https://host.test/api/socials/facebook/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
      ),
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toBe('12345')

    const denied = await run(
      endpoint,
      new Request(
        'https://host.test/api/socials/facebook/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
      ),
    )
    expect(denied.status).toBe(403)
  })

  it('verifies the raw body signature before delivering an event', async () => {
    const raw = JSON.stringify({ entry: [{ id: 'page_1' }], object: 'page' })
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`
    const response = await run(
      createMetaWebhookReceiveEndpoint(options, 'facebook'),
      new Request('https://host.test/api/socials/facebook/webhook', {
        body: raw,
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(200)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { entry: [{ id: 'page_1' }], object: 'page' },
        platform: 'facebook',
      }),
    )
  })

  it('rejects unsigned or tampered payloads without invoking the callback', async () => {
    onEvent.mockClear()
    const response = await run(
      createMetaWebhookReceiveEndpoint(options, 'instagram'),
      new Request('https://host.test/api/socials/instagram/webhook', {
        body: '{"object":"instagram"}',
        headers: { 'X-Hub-Signature-256': 'sha256=deadbeef' },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(403)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('rejects oversized and malformed signed bodies', async () => {
    const oversized = await run(
      createMetaWebhookReceiveEndpoint(options, 'facebook'),
      new Request('https://host.test/api/socials/facebook/webhook', {
        body: '{}',
        headers: { 'Content-Length': String(1024 * 1024 + 1) },
        method: 'POST',
      }),
    )
    expect(oversized.status).toBe(400)

    const raw = '{not-json}'
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`
    const malformed = await run(
      createMetaWebhookReceiveEndpoint(options, 'facebook'),
      new Request('https://host.test/api/socials/facebook/webhook', {
        body: raw,
        headers: { 'X-Hub-Signature-256': signature },
        method: 'POST',
      }),
    )
    expect(malformed.status).toBe(400)
  })

  it('mounts only verified enabled Meta platforms and fails invalid configuration', () => {
    expect(createMetaWebhookEndpoints(options)).toHaveLength(4)
    expect(createMetaWebhookEndpoints({ ...options, webhooks: {} })).toEqual([])
    expect(() =>
      createMetaWebhookEndpoints({
        ...options,
        platforms: {
          ...options.platforms,
          facebook: { ...options.platforms.facebook, enabled: false },
          instagram: { ...options.platforms.instagram, enabled: false },
        },
      }),
    ).toThrow(/requires an enabled Meta platform/)
  })
})
