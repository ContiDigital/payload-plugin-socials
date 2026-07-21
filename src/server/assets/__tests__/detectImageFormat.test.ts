import { describe, expect, it, vi } from 'vitest'

import type { PinnedHttpsRequest } from '../safeRemoteImage.js'

import { detectImageFormat, identifyFormat } from '../detectImageFormat.js'

// ---------------------------------------------------------------------------
// identifyFormat: pure byte-matching tests
// ---------------------------------------------------------------------------

describe('identifyFormat', () => {
  it('detects JPEG from FF D8 FF', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(identifyFormat(bytes)).toBe('jpeg')
  })

  it('detects PNG from 89 50 4E 47', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(identifyFormat(bytes)).toBe('png')
  })

  it('detects GIF from GIF8', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(identifyFormat(bytes)).toBe('gif')
  })

  it('detects BMP from BM', () => {
    const bytes = new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00])
    expect(identifyFormat(bytes)).toBe('bmp')
  })

  it('detects TIFF little-endian from 49 49 2A 00', () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00])
    expect(identifyFormat(bytes)).toBe('tiff')
  })

  it('detects TIFF big-endian from 4D 4D 00 2A', () => {
    const bytes = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00])
    expect(identifyFormat(bytes)).toBe('tiff')
  })

  it('detects WebP from RIFF....WEBP', () => {
    // RIFF + 4 bytes size + WEBP
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    expect(identifyFormat(bytes)).toBe('webp')
  })

  it('detects AVIF from ftyp box with avif brand', () => {
    // bytes 4-7 = 'ftyp', bytes 8-11 = 'avif'
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ])
    expect(identifyFormat(bytes)).toBe('avif')
  })

  it('detects AVIF from ftyp box with avis brand', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73,
    ])
    expect(identifyFormat(bytes)).toBe('avif')
  })

  it('returns undefined for unknown bytes', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    expect(identifyFormat(bytes)).toBeUndefined()
  })

  it('returns undefined for too few bytes', () => {
    expect(identifyFormat(new Uint8Array([0xff]))).toBeUndefined()
    expect(identifyFormat(new Uint8Array([]))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectImageFormat: integration with fetch
// ---------------------------------------------------------------------------

describe('detectImageFormat', () => {
  const policy = { timeoutMs: 1_000, trustedHosts: [] }
  const lookupHostname = vi.fn().mockResolvedValue(['93.184.216.34'])

  it('detects an extensionless JPEG from a 206 partial content response', async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const requestImpl = vi
      .fn<PinnedHttpsRequest>()
      .mockResolvedValue(new Response(jpegBytes, { status: 206 }))

    const result = await detectImageFormat('https://cdn.example.com/assets/42', policy, {
      lookupHostname,
      requestImpl,
    })
    expect(result).toBe('jpeg')
    expect(requestImpl).toHaveBeenCalledWith({
      address: { address: '93.184.216.34', family: 4 },
      headers: { Range: 'bytes=0-31' },
      signal: expect.any(AbortSignal),
      timeoutMs: 1_000,
      url: new URL('https://cdn.example.com/assets/42'),
    })
  })

  it('handles a full 200 response by reading one chunk and aborting', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const body = new Uint8Array(64)
    body.set(pngBytes)
    const requestImpl = vi.fn<PinnedHttpsRequest>().mockResolvedValue(new Response(body))

    const result = await detectImageFormat('https://cdn.example.com/image.png', policy, {
      lookupHostname,
      requestImpl,
    })
    expect(result).toBe('png')
  })

  it('fails closed on network error', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>().mockRejectedValue(new Error('network failure'))
    await expect(
      detectImageFormat('https://cdn.example.com/bad', policy, {
        lookupHostname,
        requestImpl,
      }),
    ).rejects.toThrow('could not be fetched safely')
  })

  it('fails closed on non-ok response', async () => {
    const requestImpl = vi
      .fn<PinnedHttpsRequest>()
      .mockResolvedValue(new Response(null, { status: 403 }))
    await expect(
      detectImageFormat('https://cdn.example.com/forbidden', policy, {
        lookupHostname,
        requestImpl,
      }),
    ).rejects.toThrow('HTTP 403')
  })
})
