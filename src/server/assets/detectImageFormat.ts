import type { SocialImageFormat } from '../../types/index.js'

/**
 * Detect the image format of a remote URL by reading its magic bytes.
 *
 * Fetches only the first 32 bytes using a Range header. Tolerates servers
 * that return the full body (status 200) by reading only the first chunk
 * and aborting. On any network error, returns undefined (never throws).
 */
export const detectImageFormat = async (
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SocialImageFormat | undefined> => {
  try {
    const controller = new AbortController()
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-31' },
      method: 'GET',
      signal: controller.signal,
    })

    if (!response.ok && response.status !== 206) {
      controller.abort()
      return undefined
    }

    let bytes: Uint8Array

    if (response.status === 206 || Number(response.headers.get('content-length')) <= 32) {
      // Partial content or small response: read the whole body.
      const buf = await response.arrayBuffer()
      bytes = new Uint8Array(buf)
    } else {
      // Full body returned. Read just the first chunk, then abort.
      const reader = response.body?.getReader()
      if (!reader) {
        controller.abort()
        return undefined
      }
      const { value } = await reader.read()
      controller.abort()
      if (!value) {
        return undefined
      }
      bytes = value
    }

    return identifyFormat(bytes)
  } catch {
    return undefined
  }
}

/**
 * Identify an image format from its leading bytes. Exported for testing.
 */
export const identifyFormat = (bytes: Uint8Array): SocialImageFormat | undefined => {
  if (bytes.length < 2) {
    return undefined
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length >= 3 && bytes[2] === 0xff) {
    return 'jpeg'
  }

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png'
  }

  // GIF: GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'gif'
  }

  // BMP: BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'bmp'
  }

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) {
    return 'tiff'
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) {
    return 'tiff'
  }

  // WebP: RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }

  // AVIF: ftyp box containing 'avif' or 'avis'.
  // ISO BMFF: bytes 4-7 = 'ftyp', major brand at bytes 8-11.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === 'avif' || brand === 'avis') {
      return 'avif'
    }
  }

  return undefined
}
