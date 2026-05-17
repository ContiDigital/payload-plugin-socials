import { describe, expect, it } from 'vitest'

import { ValidationError } from '../errors.js'
import {
  optionalString,
  requireHttpsUrl,
  requireIdentifier,
  requireOneOf,
  requirePositiveInteger,
  requireString,
} from '../validation.js'

describe('requireString', () => {
  it('returns the trimmed value', () => {
    expect(requireString('  hello  ', 'field')).toBe('hello')
  })

  it('throws ValidationError on empty or whitespace', () => {
    expect(() => requireString('   ', 'field')).toThrow(ValidationError)
  })

  it('throws ValidationError on non-string', () => {
    expect(() => requireString(42, 'field')).toThrow('field is required')
  })
})

describe('optionalString', () => {
  it('returns undefined for null/undefined', () => {
    expect(optionalString(undefined, 'f')).toBeUndefined()
    expect(optionalString(null, 'f')).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(optionalString('   ', 'f')).toBeUndefined()
  })

  it('returns the trimmed value when present', () => {
    expect(optionalString('  x ', 'f')).toBe('x')
  })

  it('throws on a non-string value', () => {
    expect(() => optionalString(5, 'f')).toThrow(ValidationError)
  })
})

describe('requirePositiveInteger', () => {
  it('accepts a positive integer', () => {
    expect(requirePositiveInteger(7, 'n')).toBe(7)
  })

  it('coerces a numeric string', () => {
    expect(requirePositiveInteger('7', 'n')).toBe(7)
  })

  it.each([0, -1, 1.5, NaN, 'abc'])('throws on %s', (value) => {
    expect(() => requirePositiveInteger(value, 'n')).toThrow(ValidationError)
  })
})

describe('requireIdentifier', () => {
  it('accepts a finite number', () => {
    expect(requireIdentifier(123, 'id')).toBe(123)
  })

  it('accepts a non-empty string', () => {
    expect(requireIdentifier('abc', 'id')).toBe('abc')
  })

  it('throws on empty input', () => {
    expect(() => requireIdentifier('', 'id')).toThrow(ValidationError)
  })
})

describe('requireOneOf', () => {
  const allowed = ['a', 'b', 'c'] as const

  it('returns the value when allowed', () => {
    expect(requireOneOf('b', allowed, 'choice')).toBe('b')
  })

  it('throws when not in the allowed set', () => {
    expect(() => requireOneOf('z', allowed, 'choice')).toThrow('choice must be one of: a, b, c')
  })
})

describe('requireHttpsUrl', () => {
  it('accepts an https URL', () => {
    expect(requireHttpsUrl('https://example.com/x', 'url')).toBe('https://example.com/x')
  })

  it('accepts an http URL', () => {
    expect(requireHttpsUrl('http://example.com', 'url')).toBe('http://example.com')
  })

  it('throws on a non-URL string', () => {
    expect(() => requireHttpsUrl('not a url', 'url')).toThrow(ValidationError)
  })

  it('throws on a non-http(s) protocol', () => {
    expect(() => requireHttpsUrl('ftp://example.com', 'url')).toThrow(ValidationError)
  })
})
