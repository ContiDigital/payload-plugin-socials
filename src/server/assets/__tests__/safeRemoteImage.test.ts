import { describe, expect, it, vi } from 'vitest'

import type { PinnedHttpsRequest } from '../safeRemoteImage.js'

import {
  fetchPinnedRemoteResponse,
  fetchRemoteImageBytes,
  isPublicIpAddress,
} from '../safeRemoteImage.js'

const policy = { timeoutMs: 1_000, trustedHosts: [] }
const publicLookup = vi.fn().mockResolvedValue(['93.184.216.34'])

describe('isPublicIpAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001:20::1',
    '2002:7f00:0001::1',
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
    '3fff::1',
    '5f00::1',
    'fec0::1',
    'not-an-ip',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true)
    },
  )
})

describe('fetchRemoteImageBytes', () => {
  it('rejects non-HTTPS URLs and embedded credentials', async () => {
    await expect(
      fetchRemoteImageBytes({ maxBytes: 32, policy, url: 'http://example.com/image.jpg' }),
    ).rejects.toThrow('absolute HTTPS URL')
    await expect(
      fetchRemoteImageBytes({
        maxBytes: 32,
        policy,
        url: 'https://user:pass@example.com/image.jpg',
      }),
    ).rejects.toThrow('without credentials')
  })

  it('rejects DNS names resolving to a private address before fetching', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>()
    await expect(
      fetchRemoteImageBytes({
        lookupHostname: vi.fn().mockResolvedValue(['169.254.169.254']),
        maxBytes: 32,
        policy,
        requestImpl,
        url: 'https://metadata.example/image.jpg',
      }),
    ).rejects.toThrow('private network')
    expect(requestImpl).not.toHaveBeenCalled()
  })

  it('rejects a mixed public/private DNS answer instead of selecting the public address', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>()
    await expect(
      fetchRemoteImageBytes({
        lookupHostname: vi.fn().mockResolvedValue(['93.184.216.34', '10.0.0.7']),
        maxBytes: 32,
        policy,
        requestImpl,
        url: 'https://mixed.example/image.jpg',
      }),
    ).rejects.toThrow('private network')
    expect(requestImpl).not.toHaveBeenCalled()
  })

  it('does not let a video host allowlist bypass private-address validation', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>()
    await expect(
      fetchPinnedRemoteResponse({
        allowedHosts: ['video.example'],
        label: 'Pinterest video source',
        lookupHostname: vi.fn().mockResolvedValue(['10.0.0.7']),
        policy,
        requestImpl,
        url: 'https://video.example/video.mp4',
      }),
    ).rejects.toThrow('private network')
    expect(requestImpl).not.toHaveBeenCalled()
  })

  it('passes the validated address directly to the HTTPS transport', async () => {
    const lookupHostname = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['10.0.0.7'])
    const requestImpl = vi
      .fn<PinnedHttpsRequest>()
      .mockResolvedValue(new Response(new Uint8Array([1])))
    await fetchRemoteImageBytes({
      lookupHostname,
      maxBytes: 1,
      policy,
      requestImpl,
      url: 'https://rebind.example/image.jpg',
    })
    expect(lookupHostname).toHaveBeenCalledTimes(1)
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: '93.184.216.34', family: 4 } }),
    )
  })

  it('revalidates every redirect target', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>().mockResolvedValueOnce(
      new Response(null, {
        headers: { location: 'https://private.example/image.jpg' },
        status: 302,
      }),
    )
    const lookupHostname = vi.fn((hostname: string) =>
      Promise.resolve(hostname === 'private.example' ? ['10.0.0.7'] : ['93.184.216.34']),
    )
    await expect(
      fetchRemoteImageBytes({
        lookupHostname,
        maxBytes: 32,
        policy,
        requestImpl,
        url: 'https://public.example/image.jpg',
      }),
    ).rejects.toThrow('private network')
    expect(requestImpl).toHaveBeenCalledTimes(1)
  })

  it('streams within the byte limit without buffering an unbounded body', async () => {
    const requestImpl = vi
      .fn<PinnedHttpsRequest>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])))
    const result = await fetchRemoteImageBytes({
      lookupHostname: publicLookup,
      maxBytes: 4,
      policy,
      requestImpl,
      url: 'https://cdn.example/image.jpg',
    })
    expect([...result.bytes]).toEqual([1, 2, 3, 4])
  })

  it('rejects a declared body length above the byte limit before reading it', async () => {
    const requestImpl = vi.fn<PinnedHttpsRequest>().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Length': '5' },
      }),
    )
    await expect(
      fetchRemoteImageBytes({
        lookupHostname: publicLookup,
        maxBytes: 4,
        policy,
        requestImpl,
        url: 'https://cdn.example/image.jpg',
      }),
    ).rejects.toThrow('processing limit')
  })

  it('rejects a streamed body as soon as it crosses the limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
      },
    })
    const requestImpl = vi.fn<PinnedHttpsRequest>().mockResolvedValue(new Response(body))
    await expect(
      fetchRemoteImageBytes({
        lookupHostname: publicLookup,
        maxBytes: 4,
        policy,
        requestImpl,
        url: 'https://cdn.example/image.jpg',
      }),
    ).rejects.toThrow('processing limit')
  })

  it('allows an explicitly trusted host while retaining HTTPS validation', async () => {
    const requestImpl = vi
      .fn<PinnedHttpsRequest>()
      .mockResolvedValue(new Response(new Uint8Array([1])))
    const result = await fetchRemoteImageBytes({
      lookupHostname: vi.fn().mockResolvedValue(['127.0.0.1']),
      maxBytes: 1,
      policy: { timeoutMs: 1_000, trustedHosts: ['media.internal'] },
      requestImpl,
      url: 'https://media.internal/image.jpg',
    })
    expect(result.bytes[0]).toBe(1)
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: '127.0.0.1', family: 4 } }),
    )
  })
})
