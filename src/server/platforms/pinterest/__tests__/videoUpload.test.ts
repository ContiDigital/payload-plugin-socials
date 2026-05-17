import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'

vi.mock('../../../utilities/requestPolicy.js', () => ({ policyFetch: vi.fn() }))
vi.mock('../api.js', () => ({ pinterestJson: vi.fn() }))

import { policyFetch } from '../../../utilities/requestPolicy.js'
import { pinterestJson } from '../api.js'
import { uploadPinterestVideoFromUrl } from '../videoUpload.js'

const options = {
  platforms: {
    pinterest: {
      allowedVideoHosts: ['cdn.example.com'],
      videoUploadTimeoutMs: 900_000,
    },
  },
  rateLimit: { enabled: true },
} as unknown as NormalizedPluginOptions
const payload = {} as Payload

beforeEach(() => {
  vi.clearAllMocks()
})

describe('uploadPinterestVideoFromUrl', () => {
  it('registers, streams, and confirms a Pinterest video upload', async () => {
    vi.mocked(pinterestJson)
      .mockResolvedValueOnce({
        media_id: 'media_1',
        upload_parameters: { key: 'uploads/video', policy: 'signed-policy' },
        upload_url: 'https://pinterest-upload.example.com/',
      })
      .mockResolvedValueOnce({ media_id: 'media_1', status: 'succeeded' })
    vi.mocked(policyFetch)
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Length': '3', 'Content-Type': 'video/mp4' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).resolves.toBe('media_1')

    expect(pinterestJson).toHaveBeenNthCalledWith(
      1,
      payload,
      options,
      '/v5/media',
      expect.objectContaining({ method: 'POST' }),
    )
    const uploadCall = vi.mocked(policyFetch).mock.calls[1][0]
    expect(uploadCall.input).toBe('https://pinterest-upload.example.com/')
    expect(uploadCall.init?.headers).toMatchObject({
      'Content-Length': expect.any(String),
      'Content-Type': expect.stringContaining('multipart/form-data; boundary='),
    })
    expect(pinterestJson).toHaveBeenLastCalledWith(payload, options, '/v5/media/media_1')
  })

  it('rejects unallowlisted and non-HTTPS sources before registering media', async () => {
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://untrusted.example/video.mp4',
      }),
    ).rejects.toThrow(/allowedVideoHosts/)
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'http://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/HTTPS/)
    expect(pinterestJson).not.toHaveBeenCalled()
  })

  it('rejects sources without a bounded Content-Length', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({
      media_id: 'media_1',
      upload_parameters: { key: 'uploads/video' },
      upload_url: 'https://pinterest-upload.example.com/',
    })
    vi.mocked(policyFetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'video/mp4' },
      }),
    )
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/Content-Length/)
  })

  it('rejects incomplete registration and missing host configuration', async () => {
    vi.mocked(pinterestJson).mockResolvedValueOnce({ media_id: 'media_1' })
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/incomplete upload target/)

    const withoutHosts = {
      ...options,
      platforms: {
        ...options.platforms,
        pinterest: { ...options.platforms.pinterest, allowedVideoHosts: [] },
      },
    } as NormalizedPluginOptions
    await expect(
      uploadPinterestVideoFromUrl({
        options: withoutHosts,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/allowedVideoHosts/)
  })

  it('rejects failed source fetches, unsupported media, and oversized files', async () => {
    const registration = {
      media_id: 'media_1',
      upload_parameters: { key: 'uploads/video' },
      upload_url: 'https://pinterest-upload.example.com/',
    }
    vi.mocked(pinterestJson).mockResolvedValue(registration)
    vi.mocked(policyFetch).mockResolvedValueOnce(new Response('down', { status: 503 }))
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toMatchObject({ retryable: true })

    vi.mocked(policyFetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Length': '1', 'Content-Type': 'text/plain' },
      }),
    )
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/content type/)

    vi.mocked(policyFetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        headers: {
          'Content-Length': String(2 * 1024 * 1024 * 1024 + 1),
          'Content-Type': 'video/mp4',
        },
      }),
    )
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/2 GB/)
  })

  it('surfaces upload and processing failures', async () => {
    const registration = {
      media_id: 'media_1',
      upload_parameters: { key: 'uploads/video' },
      upload_url: 'https://pinterest-upload.example.com/',
    }
    vi.mocked(pinterestJson).mockResolvedValueOnce(registration)
    vi.mocked(policyFetch)
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: { 'Content-Length': '1', 'Content-Type': 'video/mp4' },
        }),
      )
      .mockResolvedValueOnce(new Response('upload failed', { status: 500 }))
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toMatchObject({ upstreamCode: 500 })

    vi.mocked(pinterestJson)
      .mockResolvedValueOnce(registration)
      .mockResolvedValueOnce({ media_id: 'media_1', status: 'failed' })
    vi.mocked(policyFetch)
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: { 'Content-Length': '1', 'Content-Type': 'video/mp4' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(
      uploadPinterestVideoFromUrl({
        options,
        payload,
        videoUrl: 'https://cdn.example.com/video.mp4',
      }),
    ).rejects.toThrow(/failed to process/)
  })
})
