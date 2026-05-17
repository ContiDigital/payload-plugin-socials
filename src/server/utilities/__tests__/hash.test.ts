import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../hash.js'

describe('sha256Hex', () => {
  it('matches the known SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is deterministic and 64 lowercase hex chars', () => {
    const a = sha256Hex('pinterest:product:7:b1:https://cdn/x.jpg')
    const b = sha256Hex('pinterest:product:7:b1:https://cdn/x.jpg')
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when any input byte changes', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})
