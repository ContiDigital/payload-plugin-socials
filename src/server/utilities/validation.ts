import { ValidationError } from './errors.js'

export const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`)
  }
  return value.trim()
}

export const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export const requirePositiveInteger = (value: unknown, field: string): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return n
}

export const requireIdentifier = (value: unknown, field: string): number | string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return requireString(value, field)
}

export const requireOneOf = <T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] => {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T[number]
}

export const requireHttpsUrl = (value: unknown, field: string): string => {
  const s = requireString(value, field)
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new ValidationError(`${field} must be a valid URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError(`${field} must use http(s)://`)
  }
  return s
}
