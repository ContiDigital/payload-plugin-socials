import type { LookupFunction } from 'node:net'

import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'

import { MAX_REMOTE_ASSET_REDIRECTS } from '../../constants.js'
import { ValidationError } from '../utilities/errors.js'

type LookupHostname = (hostname: string) => Promise<readonly string[]>

export type PinnedAddress = {
  address: string
  family: 4 | 6
}

export type PinnedHttpsRequestArgs = {
  address: PinnedAddress
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  timeoutMs: number
  url: URL
}

export type PinnedHttpsRequest = (args: PinnedHttpsRequestArgs) => Promise<Response>

export type RemoteImagePolicy = {
  timeoutMs: number
  trustedHosts: readonly string[]
}

export type FetchRemoteImageBytesArgs = {
  lookupHostname?: LookupHostname
  maxBytes: number
  policy: RemoteImagePolicy
  range?: { end: number; start: number }
  requestImpl?: PinnedHttpsRequest
  truncateAtLimit?: boolean
  url: string
}

export type RemoteImageBytes = {
  bytes: Uint8Array
  contentType?: string
  finalUrl: string
}

const defaultLookupHostname: LookupHostname = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

const defaultPinnedHttpsRequest: PinnedHttpsRequest = async ({
  address,
  headers,
  signal,
  timeoutMs,
  url,
}) =>
  new Promise<Response>((resolve, reject) => {
    const certificateHostname =
      url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [address])
        return
      }
      callback(null, address.address, address.family)
    }
    const request = httpsRequest(
      url,
      {
        agent: false,
        headers,
        lookup: pinnedLookup,
        method: 'GET',
        rejectUnauthorized: true,
        signal,
        ...(isIP(certificateHostname) === 0 ? { servername: certificateHostname } : {}),
      },
      (incoming) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(name, item)
            }
          } else if (value !== undefined) {
            responseHeaders.set(name, value)
          }
        }
        const status = incoming.statusCode ?? 500
        const hasBody = status !== 204 && status !== 205 && status !== 304
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
            headers: responseHeaders,
            status,
            statusText: incoming.statusMessage,
          }),
        )
      },
    )
    request.setTimeout(timeoutMs, () => {
      const error = new Error('Request timed out')
      error.name = 'TimeoutError'
      request.destroy(error)
    })
    request.once('error', reject)
    request.end()
  })

const NON_PUBLIC_ADDRESSES = new BlockList()

const IPV4_SPECIAL_USE_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

const IPV6_SPECIAL_USE_SUBNETS = [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const

for (const [network, prefix] of IPV4_SPECIAL_USE_SUBNETS) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of IPV6_SPECIAL_USE_SUBNETS) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}

export const isPublicIpAddress = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) {
    return !NON_PUBLIC_ADDRESSES.check(address, 'ipv4')
  }
  if (version === 6) {
    return !NON_PUBLIC_ADDRESSES.check(address, 'ipv6')
  }
  return false
}

const parseRemoteAssetUrl = (rawUrl: string, label: string): URL => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ValidationError(`${label} URL must be an absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ValidationError(`${label} URL must be an absolute HTTPS URL without credentials`)
  }
  if (url.port && url.port !== '443') {
    throw new ValidationError(`${label} URL must use the standard HTTPS port`)
  }
  return url
}

const resolvePinnedAddress = async (
  url: URL,
  policy: RemoteImagePolicy,
  lookupHostname: LookupHostname,
  label: string,
): Promise<PinnedAddress> => {
  const hostname = url.hostname.toLowerCase()
  const isTrusted = policy.trustedHosts.includes(hostname)
  if (!isTrusted && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new ValidationError(`${label} URL cannot target a local or private network address`)
  }
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const addresses = isIP(literal) ? [literal] : await lookupHostname(hostname)
  if (
    addresses.length === 0 ||
    (!isTrusted && addresses.some((address) => !isPublicIpAddress(address)))
  ) {
    throw new ValidationError(`${label} URL cannot target a local or private network address`)
  }
  const address = addresses[0]
  const family = isIP(address)
  if (family !== 4 && family !== 6) {
    throw new ValidationError(`${label} URL did not resolve to a valid IP address`)
  }
  return { address, family }
}

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308

export type FetchPinnedRemoteResponseArgs = {
  allowedHosts?: readonly string[]
  headers?: Readonly<Record<string, string>>
  label: string
  lookupHostname?: LookupHostname
  maxRedirects?: number
  policy: RemoteImagePolicy
  requestImpl?: PinnedHttpsRequest
  signal?: AbortSignal
  url: string
}

export type PinnedRemoteResponse = {
  finalUrl: string
  response: Response
}

export const fetchPinnedRemoteResponse = async (
  args: FetchPinnedRemoteResponseArgs,
): Promise<PinnedRemoteResponse> => {
  const lookupHostname = args.lookupHostname ?? defaultLookupHostname
  const requestImpl = args.requestImpl ?? defaultPinnedHttpsRequest
  const redirectLimit = args.maxRedirects ?? MAX_REMOTE_ASSET_REDIRECTS
  let currentUrl = parseRemoteAssetUrl(args.url, args.label)

  for (let redirectCount = 0; redirectCount <= redirectLimit; redirectCount++) {
    const hostname = currentUrl.hostname.toLowerCase()
    if (args.allowedHosts && !args.allowedHosts.includes(hostname)) {
      throw new ValidationError(
        `${args.label} host "${hostname}" is not in the configured allowlist`,
      )
    }
    const address = await resolvePinnedAddress(currentUrl, args.policy, lookupHostname, args.label)
    const response = await requestImpl({
      address,
      headers: args.headers,
      signal: args.signal,
      timeoutMs: args.policy.timeoutMs,
      url: currentUrl,
    })
    if (!isRedirect(response.status)) {
      return { finalUrl: currentUrl.toString(), response }
    }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirectCount === redirectLimit) {
      throw new ValidationError(`${args.label} exceeded the redirect limit`)
    }
    currentUrl = parseRemoteAssetUrl(new URL(location, currentUrl).toString(), args.label)
  }
  throw new ValidationError(`${args.label} exceeded the redirect limit`)
}

const readResponseBytes = async (
  response: Response,
  maxBytes: number,
  truncateAtLimit: boolean,
): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (!truncateAtLimit && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new ValidationError('Remote image exceeds the configured 25 MB processing limit')
  }
  if (!response.body) {
    return new Uint8Array()
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) {
      break
    }
    const remaining = maxBytes - total
    if (result.value.byteLength > remaining) {
      if (!truncateAtLimit) {
        await reader.cancel()
        throw new ValidationError('Remote image exceeds the configured 25 MB processing limit')
      }
      if (remaining > 0) {
        chunks.push(result.value.subarray(0, remaining))
      }
      total = maxBytes
      await reader.cancel()
      break
    }
    chunks.push(result.value)
    total += result.value.byteLength
    if (truncateAtLimit && total === maxBytes) {
      await reader.cancel()
      break
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export const fetchRemoteImageBytes = async (
  args: FetchRemoteImageBytesArgs,
): Promise<RemoteImageBytes> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), args.policy.timeoutMs)

  try {
    const { finalUrl, response } = await fetchPinnedRemoteResponse({
      headers: args.range ? { Range: `bytes=${args.range.start}-${args.range.end}` } : undefined,
      label: 'Remote image',
      lookupHostname: args.lookupHostname,
      policy: args.policy,
      requestImpl: args.requestImpl,
      signal: controller.signal,
      url: args.url,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ValidationError(`Remote image could not be fetched (HTTP ${response.status})`)
    }
    const bytes = await readResponseBytes(response, args.maxBytes, args.truncateAtLimit === true)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    return { bytes, contentType: contentType || undefined, finalUrl }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ValidationError('Remote image request timed out')
    }
    if (error instanceof ValidationError) {
      throw error
    }
    throw new ValidationError('Remote image could not be fetched safely')
  } finally {
    clearTimeout(timeout)
  }
}
