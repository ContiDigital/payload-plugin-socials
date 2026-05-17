import { describe, expect, it } from 'vitest'

import {
  coerceEncryptionKey,
  constantTimeEqual,
  DecryptionError,
  decryptString,
  decryptStringWithKeyring,
  EncryptionKeyError,
  encryptString,
} from '../encryption.js'

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const BASE64_KEY = Buffer.alloc(32, 7).toString('base64')

describe('coerceEncryptionKey', () => {
  it('accepts a 64-char hex string and returns 32 bytes', () => {
    const key = coerceEncryptionKey(HEX_KEY)
    expect(key).toHaveLength(32)
    expect(key.toString('hex')).toBe(HEX_KEY)
  })

  it('accepts a standard base64 string that decodes to 32 bytes', () => {
    const key = coerceEncryptionKey(BASE64_KEY)
    expect(key).toHaveLength(32)
    expect(key.every((b) => b === 7)).toBe(true)
  })

  it('accepts a raw 32-byte Buffer and returns a copy', () => {
    const source = Buffer.alloc(32, 9)
    const key = coerceEncryptionKey(source)
    expect(key).toHaveLength(32)
    expect(key.equals(source)).toBe(true)
    expect(key).not.toBe(source)
  })

  it('throws on a Buffer of the wrong length', () => {
    expect(() => coerceEncryptionKey(Buffer.alloc(16))).toThrow(EncryptionKeyError)
  })

  it('throws on an empty string', () => {
    expect(() => coerceEncryptionKey('')).toThrow(EncryptionKeyError)
  })

  it('throws when a string does not decode to exactly 32 bytes', () => {
    expect(() => coerceEncryptionKey('not-a-real-key')).toThrow(EncryptionKeyError)
  })

  it('rejects non-canonical base64 instead of silently ignoring garbage', () => {
    expect(() => coerceEncryptionKey(`!!${BASE64_KEY}`)).toThrow(EncryptionKeyError)
    expect(() => coerceEncryptionKey(BASE64_KEY.replace(/=$/, ''))).toThrow(EncryptionKeyError)
  })
})

describe('encryptString / decryptString round trip', () => {
  const key = coerceEncryptionKey(HEX_KEY)

  it('round-trips arbitrary UTF-8 plaintext', () => {
    const plaintext = 'pinr_super-secret-refresh-token ✓ café'
    const envelope = encryptString(plaintext, key)
    expect(envelope.version).toBe(1)
    expect(decryptString(envelope, key)).toBe(plaintext)
  })

  it('round-trips empty string', () => {
    const envelope = encryptString('', key)
    expect(decryptString(envelope, key)).toBe('')
  })

  it('produces a unique iv per call (no nonce reuse)', () => {
    const a = encryptString('same', key)
    const b = encryptString('same', key)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('fails closed when the ciphertext is tampered with', () => {
    const envelope = encryptString('tamper-me', key)
    const corrupted = Buffer.from(envelope.ciphertext, 'base64')
    corrupted[0] ^= 0xff
    expect(() =>
      decryptString({ ...envelope, ciphertext: corrupted.toString('base64') }, key),
    ).toThrow(DecryptionError)
  })

  it('fails closed when decrypted with the wrong key', () => {
    const envelope = encryptString('secret', key)
    const wrongKey = coerceEncryptionKey(Buffer.alloc(32, 1))
    expect(() => decryptString(envelope, wrongKey)).toThrow(DecryptionError)
  })

  it('rejects an unsupported envelope version', () => {
    const envelope = encryptString('v', key)
    expect(() => decryptString({ ...envelope, version: 99 }, key)).toThrow(DecryptionError)
  })

  it('rejects non-base64 envelope fields', () => {
    const envelope = encryptString('v', key)
    expect(() => decryptString({ ...envelope, iv: 'not base64!!' }, key)).toThrow(DecryptionError)
  })

  it('rejects an iv of the wrong byte length', () => {
    const envelope = encryptString('v', key)
    expect(() =>
      decryptString({ ...envelope, iv: Buffer.alloc(8).toString('base64') }, key),
    ).toThrow(DecryptionError)
  })

  it('reports which key decrypted an envelope during rotation', () => {
    const oldKey = Buffer.alloc(32, 4)
    const envelope = encryptString('rotate-me', oldKey)
    expect(decryptStringWithKeyring(envelope, key, [Buffer.alloc(32, 3), oldKey])).toEqual({
      keyIndex: 2,
      plaintext: 'rotate-me',
    })
  })
})

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different strings of equal length', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for strings of different length', () => {
    expect(constantTimeEqual('short', 'longer-value')).toBe(false)
  })
})
