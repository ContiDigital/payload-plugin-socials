import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import type { EncryptedValue } from '../../types/index.js'

import {
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_AUTH_TAG_BYTES,
  ENCRYPTION_IV_BYTES,
  ENCRYPTION_KEY_BYTES,
  ENCRYPTION_PAYLOAD_VERSION,
  PLUGIN_SLUG,
} from '../../constants.js'

/**
 * AES-256-GCM authenticated encryption for storing OAuth tokens at rest.
 *
 * Envelope shape (stored verbatim in the `socials-connections` global):
 *
 *   { version: 1, iv: <base64>, ciphertext: <base64>, authTag: <base64> }
 *
 * The host supplies a 32-byte key via `options.encryptionKey` (the plugin
 * accepts either a 64-char hex string OR a base64 string OR a raw Buffer
 * 32 bytes long). The plugin normalizes once on init; decrypt fails closed
 * on any tag mismatch — there is no plaintext fallback.
 */

export class EncryptionKeyError extends Error {
  readonly statusCode = 500
  constructor(message: string) {
    super(`${PLUGIN_SLUG}: ${message}`)
    this.name = 'EncryptionKeyError'
  }
}

export class DecryptionError extends Error {
  readonly statusCode = 500
  constructor(message: string) {
    super(`${PLUGIN_SLUG}: ${message}`)
    this.name = 'DecryptionError'
  }
}

/**
 * Coerce a host-supplied key string into a 32-byte buffer. Accepts:
 *   - 64-char hex
 *   - base64 (no urlsafe variants — use the standard alphabet)
 *   - any Buffer of exact length 32
 *
 * Throws if the result is not exactly 32 bytes. The plugin entrypoint calls
 * this once during normalization so the rest of the codebase can assume the
 * key is already a validated Buffer.
 */
export const coerceEncryptionKey = (input: Buffer | string): Buffer => {
  if (Buffer.isBuffer(input)) {
    if (input.length !== ENCRYPTION_KEY_BYTES) {
      throw new EncryptionKeyError(
        `encryptionKey must be exactly ${ENCRYPTION_KEY_BYTES} bytes; got ${input.length}`,
      )
    }
    return Buffer.from(input)
  }

  if (typeof input !== 'string' || input.length === 0) {
    throw new EncryptionKeyError('encryptionKey must be a non-empty string or 32-byte Buffer')
  }

  // Hex (64 chars, all hex digits).
  if (input.length === 64 && /^[0-9a-f]+$/i.test(input)) {
    return Buffer.from(input, 'hex')
  }

  // Base64. Decode and verify length.
  if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(input)) {
    throw new EncryptionKeyError('encryptionKey is not valid base64 or hex')
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(input, 'base64')
  } catch {
    throw new EncryptionKeyError('encryptionKey is not valid base64 or hex')
  }
  if (decoded.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError(
      `encryptionKey must decode to exactly ${ENCRYPTION_KEY_BYTES} bytes; got ${decoded.length}`,
    )
  }
  if (decoded.toString('base64') !== input) {
    throw new EncryptionKeyError('encryptionKey is not canonical base64')
  }
  return decoded
}

// Accepts the standard base64 alphabet, including the empty string: GCM of an
// empty plaintext yields an empty ciphertext, so an empty `ciphertext` field
// is legitimate. The byte-length checks below still reject an empty iv/authTag.
const isBase64 = (s: unknown): s is string =>
  typeof s === 'string' && /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(s)

/**
 * Encrypts a UTF-8 plaintext into an `EncryptedValue` envelope.
 */
export const encryptString = (plaintext: string, key: Buffer): EncryptedValue => {
  if (typeof plaintext !== 'string') {
    throw new TypeError(`${PLUGIN_SLUG}: encryptString expects a string`)
  }
  const iv = randomBytes(ENCRYPTION_IV_BYTES)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    version: ENCRYPTION_PAYLOAD_VERSION,
  }
}

/**
 * Decrypts an envelope back to its original UTF-8 plaintext. Throws on any
 * tampering (wrong key, modified ciphertext, wrong version).
 */
export const decryptString = (envelope: EncryptedValue, key: Buffer): string => {
  if (!envelope || typeof envelope !== 'object') {
    throw new DecryptionError('encrypted envelope is missing or not an object')
  }
  if (envelope.version !== ENCRYPTION_PAYLOAD_VERSION) {
    throw new DecryptionError(
      `unsupported envelope version ${String(envelope.version)} (expected ${ENCRYPTION_PAYLOAD_VERSION})`,
    )
  }
  if (!isBase64(envelope.iv) || !isBase64(envelope.ciphertext) || !isBase64(envelope.authTag)) {
    throw new DecryptionError('envelope fields must be base64 strings')
  }

  const iv = Buffer.from(envelope.iv, 'base64')
  const authTag = Buffer.from(envelope.authTag, 'base64')
  if (iv.length !== ENCRYPTION_IV_BYTES) {
    throw new DecryptionError(`iv must be exactly ${ENCRYPTION_IV_BYTES} bytes`)
  }
  if (authTag.length !== ENCRYPTION_AUTH_TAG_BYTES) {
    throw new DecryptionError(`authTag must be exactly ${ENCRYPTION_AUTH_TAG_BYTES} bytes`)
  }

  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    throw new DecryptionError('authentication tag mismatch or corrupt ciphertext')
  }
}

export const decryptStringWithKeyring = (
  envelope: EncryptedValue,
  currentKey: Buffer,
  previousKeys: readonly Buffer[],
): { keyIndex: number; plaintext: string } => {
  const keys = [currentKey, ...previousKeys]
  let lastError: unknown
  for (const [keyIndex, key] of keys.entries()) {
    try {
      return { keyIndex, plaintext: decryptString(envelope, key) }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Constant-time comparison helper for cases where a token or signature has
 * to be checked against a stored expected value. Two strings of different
 * length are not equal but the function still does a constant-time compare
 * against their sha-256 digests to avoid length-based timing leaks.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length === bufB.length) {
    return timingSafeEqual(bufA, bufB)
  }
  // Different length: still do a constant-time compare to keep timing flat,
  // but always return false.
  const hashA = createHash('sha256').update(bufA).digest()
  const hashB = createHash('sha256').update(bufB).digest()
  timingSafeEqual(hashA, hashB)
  return false
}
