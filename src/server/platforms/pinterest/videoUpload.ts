import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import {
  PINTEREST_MEDIA_POLL_INTERVAL_MS,
  PINTEREST_MEDIA_POLL_TIMEOUT_MS,
  PINTEREST_VIDEO_MAX_BYTES,
} from '../../../constants.js'
import { fetchPinnedRemoteResponse } from '../../assets/safeRemoteImage.js'
import { PlatformApiError, ValidationError } from '../../utilities/errors.js'
import { policyFetch } from '../../utilities/requestPolicy.js'
import { sleep } from '../../utilities/sleep.js'
import { pinterestJson } from './api.js'

type MediaRegistration = {
  media_id?: string
  upload_parameters?: Record<string, string>
  upload_url?: string
}

type MediaStatus = {
  media_id?: string
  media_type?: string
  status?: 'failed' | 'processing' | 'registered' | 'succeeded'
}

type VideoSource = {
  contentLength: number
  contentType: string
  response: Response
}

const VIDEO_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
])

const assertAllowedVideoUrl = (rawUrl: string, allowedHosts: readonly string[]): URL => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ValidationError('Pinterest videoUrl must be a valid absolute URL')
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('Pinterest videoUrl must use HTTPS')
  }
  if (url.username || url.password) {
    throw new ValidationError('Pinterest videoUrl must not contain credentials')
  }
  if (url.port && url.port !== '443') {
    throw new ValidationError('Pinterest videoUrl must use the standard HTTPS port')
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new ValidationError(
      `Pinterest video host "${url.hostname}" is not in platforms.pinterest.allowedVideoHosts`,
    )
  }
  return url
}

const fetchVideoSource = async (
  options: NormalizedPluginOptions,
  rawUrl: string,
): Promise<VideoSource> => {
  const { response } = await fetchPinnedRemoteResponse({
    allowedHosts: options.platforms.pinterest.allowedVideoHosts,
    label: 'Pinterest video source',
    policy: {
      timeoutMs: options.platforms.pinterest.videoUploadTimeoutMs,
      trustedHosts: [],
    },
    url: rawUrl,
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new PlatformApiError({
      message: `Pinterest could not fetch video source: HTTP ${response.status}`,
      platform: 'pinterest',
      retryable: response.status >= 500 || response.status === 429,
      statusCode: 502,
      upstreamCode: response.status,
    })
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    await response.body.cancel()
    throw new ValidationError('Pinterest video source must provide a valid Content-Length header')
  }
  if (contentLength > PINTEREST_VIDEO_MAX_BYTES) {
    await response.body.cancel()
    throw new ValidationError('Pinterest video exceeds the 2 GB platform limit')
  }
  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!VIDEO_CONTENT_TYPES.has(contentType)) {
    await response.body.cancel()
    throw new ValidationError(
      `Pinterest video content type must be MP4, MOV, or M4V; received "${contentType || 'missing'}"`,
    )
  }
  return { contentLength, contentType, response }
}

const escapeDispositionValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '')

const buildMultipartUpload = (
  source: VideoSource,
  parameters: Record<string, string>,
): { body: ReadableStream<Uint8Array>; contentLength: number; contentType: string } => {
  if (!source.response.body) {
    throw new ValidationError('Pinterest video source has no body')
  }
  const boundary = `----payload-socials-${crypto.randomUUID()}`
  const encoder = new TextEncoder()
  const fields = Object.entries(parameters)
    .map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDispositionValue(name)}"\r\n\r\n${value}\r\n`,
    )
    .join('')
  const fileHeader =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="video"\r\n' +
    `Content-Type: ${source.contentType}\r\n\r\n`
  const prefix = encoder.encode(fields + fileHeader)
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
  const reader = source.response.body.getReader()
  let prefixSent = false
  let sourceBytesRead = 0
  let sourceDone = false
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await reader.cancel(reason)
    },
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        controller.enqueue(prefix)
        return
      }
      if (!sourceDone) {
        const chunk = await reader.read()
        if (!chunk.done) {
          sourceBytesRead += chunk.value.byteLength
          if (
            sourceBytesRead > source.contentLength ||
            sourceBytesRead > PINTEREST_VIDEO_MAX_BYTES
          ) {
            await reader.cancel()
            throw new ValidationError(
              'Pinterest video source body exceeded its declared Content-Length',
            )
          }
          controller.enqueue(chunk.value)
          return
        }
        if (sourceBytesRead !== source.contentLength) {
          throw new ValidationError(
            'Pinterest video source body did not match its declared Content-Length',
          )
        }
        sourceDone = true
      }
      controller.enqueue(suffix)
      controller.close()
    },
  })
  return {
    body,
    contentLength: prefix.byteLength + source.contentLength + suffix.byteLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

const registerVideo = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<Required<MediaRegistration>> => {
  const registration = await pinterestJson<MediaRegistration>(payload, options, '/v5/media', {
    body: JSON.stringify({ media_type: 'video' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  if (!registration.media_id || !registration.upload_url || !registration.upload_parameters) {
    throw new PlatformApiError({
      message: 'Pinterest media registration returned an incomplete upload target',
      platform: 'pinterest',
      raw: registration,
      retryable: false,
      statusCode: 502,
    })
  }
  return registration as Required<MediaRegistration>
}

const transferVideo = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  videoUrl: string,
  registration: Required<MediaRegistration>,
): Promise<void> => {
  const source = await fetchVideoSource(options, videoUrl)
  const multipart = buildMultipartUpload(source, registration.upload_parameters)
  type DuplexRequestInit = { duplex: 'half' } & RequestInit
  const init: DuplexRequestInit = {
    body: multipart.body,
    duplex: 'half',
    headers: {
      'Content-Length': String(multipart.contentLength),
      'Content-Type': multipart.contentType,
    },
    method: 'POST',
  }
  const response = await policyFetch({
    config: {
      ...options.rateLimit,
      requestTimeoutMs: options.platforms.pinterest.videoUploadTimeoutMs,
    },
    init,
    input: registration.upload_url,
    payload,
    scope: 'pinterest:video-upload',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new PlatformApiError({
      message: `Pinterest media upload failed: HTTP ${response.status}`,
      platform: 'pinterest',
      retryable: response.status >= 500 || response.status === 429,
      statusCode: 502,
      upstreamCode: response.status,
      upstreamMessage: text,
    })
  }
  await response.body?.cancel()
}

const waitForMedia = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  mediaId: string,
): Promise<void> => {
  const deadline = Date.now() + PINTEREST_MEDIA_POLL_TIMEOUT_MS
  while (true) {
    const status = await pinterestJson<MediaStatus>(
      payload,
      options,
      `/v5/media/${encodeURIComponent(mediaId)}`,
    )
    if (status.status === 'succeeded') {
      return
    }
    if (status.status === 'failed') {
      throw new PlatformApiError({
        message: `Pinterest failed to process uploaded media ${mediaId}`,
        platform: 'pinterest',
        raw: status,
        retryable: false,
        statusCode: 502,
      })
    }
    if (Date.now() >= deadline) {
      throw new PlatformApiError({
        message: `Pinterest media ${mediaId} did not finish processing within ${PINTEREST_MEDIA_POLL_TIMEOUT_MS}ms`,
        platform: 'pinterest',
        retryable: true,
        statusCode: 504,
        upstreamCode: 'media_timeout',
      })
    }
    await sleep(PINTEREST_MEDIA_POLL_INTERVAL_MS)
  }
}

export const uploadPinterestVideoFromUrl = async (args: {
  options: NormalizedPluginOptions
  payload: Payload
  videoUrl: string
}): Promise<string> => {
  if (args.options.platforms.pinterest.allowedVideoHosts.length === 0) {
    throw new ValidationError(
      'Pinterest video publishing requires platforms.pinterest.allowedVideoHosts',
    )
  }
  assertAllowedVideoUrl(args.videoUrl, args.options.platforms.pinterest.allowedVideoHosts)
  const registration = await registerVideo(args.payload, args.options)
  await transferVideo(args.payload, args.options, args.videoUrl, registration)
  await waitForMedia(args.payload, args.options, registration.media_id)
  return registration.media_id
}
