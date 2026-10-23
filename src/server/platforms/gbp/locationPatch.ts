import type { PlatformFieldViolation } from '../../utilities/errors.js'

import { ValidationError } from '../../utilities/errors.js'

export const GBP_DAYS_OF_WEEK = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const
export type GbpDayOfWeek = (typeof GBP_DAYS_OF_WEEK)[number]

export const GBP_OPEN_STATUSES = ['OPEN', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'] as const
export type GbpOpenStatus = (typeof GBP_OPEN_STATUSES)[number]

/** Google's limit for `profile.description`. */
export const GBP_DESCRIPTION_MAX_LENGTH = 750

export type GbpTimeOfDay = { hours?: number; minutes?: number }
export type GbpDate = { day: number; month: number; year: number }

export type GbpTimePeriod = {
  closeDay: GbpDayOfWeek
  closeTime: GbpTimeOfDay
  openDay: GbpDayOfWeek
  openTime: GbpTimeOfDay
}

export type GbpSpecialHourPeriod = {
  closed?: boolean
  closeTime?: GbpTimeOfDay
  endDate?: GbpDate
  openTime?: GbpTimeOfDay
  startDate: GbpDate
}

export type GbpPostalAddress = {
  addressLines?: string[]
  administrativeArea?: string
  languageCode?: string
  locality?: string
  postalCode?: string
  regionCode: string
  sublocality?: string
}

/**
 * The listing fields the plugin edits. Each top-level key becomes exactly one `updateMask` path,
 * so a patch can never touch a field it does not name.
 */
export type GbpLocationPatch = {
  phoneNumbers?: { primaryPhone: string }
  profile?: { description: string }
  regularHours?: { periods: GbpTimePeriod[] }
  specialHours?: { specialHourPeriods: GbpSpecialHourPeriod[] }
  storefrontAddress?: GbpPostalAddress
  websiteUri?: string
}

const PATCH_MASKS: Record<keyof GbpLocationPatch, string> = {
  phoneNumbers: 'phoneNumbers.primaryPhone',
  profile: 'profile.description',
  regularHours: 'regularHours',
  specialHours: 'specialHours',
  storefrontAddress: 'storefrontAddress',
  websiteUri: 'websiteUri',
}
const PATCH_ORDER: Array<keyof GbpLocationPatch> = [
  'storefrontAddress',
  'regularHours',
  'specialHours',
  'profile',
  'phoneNumbers',
  'websiteUri',
]
const ADDRESS_KEYS = [
  'addressLines',
  'administrativeArea',
  'languageCode',
  'locality',
  'postalCode',
  'regionCode',
  'sublocality',
] as const

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, field: string): Raw => {
  if (!isRecord(value)) {
    throw new ValidationError(`${field} must be an object`)
  }
  return value
}

const onlyKeys = (value: Raw, allowed: readonly string[], field: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new ValidationError(
      `${field} has unsupported keys: ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`,
    )
  }
}

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`)
  }
  if (value.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`)
  }
  return value
}

const integerIn = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`)
  }
  return value
}

const timeOfDay = (value: unknown, field: string, allowMidnightEnd: boolean): GbpTimeOfDay => {
  const raw = record(value, field)
  onlyKeys(raw, ['hours', 'minutes'], field)
  const hours = raw.hours === undefined ? 0 : integerIn(raw.hours, 0, 24, `${field}.hours`)
  const minutes = raw.minutes === undefined ? 0 : integerIn(raw.minutes, 0, 59, `${field}.minutes`)
  if (hours === 24 && (!allowMidnightEnd || minutes !== 0)) {
    throw new ValidationError(`${field} may be 24:00 only as a closing time`)
  }
  return { hours, minutes }
}

const day = (value: unknown, field: string): GbpDayOfWeek => {
  if (typeof value !== 'string' || !(GBP_DAYS_OF_WEEK as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${GBP_DAYS_OF_WEEK.join(', ')}`)
  }
  return value as GbpDayOfWeek
}

const dateValue = (value: unknown, field: string): GbpDate => {
  const raw = record(value, field)
  onlyKeys(raw, ['year', 'month', 'day'], field)
  const year = integerIn(raw.year, 1970, 9999, `${field}.year`)
  const month = integerIn(raw.month, 1, 12, `${field}.month`)
  const dayOfMonth = integerIn(raw.day, 1, 31, `${field}.day`)
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth))
  if (probe.getUTCMonth() !== month - 1) {
    throw new ValidationError(`${field} is not a calendar date`)
  }
  return { day: dayOfMonth, month, year }
}

const dayNumber = (date: GbpDate): number =>
  Date.UTC(date.year, date.month - 1, date.day) / 86_400_000

const minutesOf = (time: GbpTimeOfDay): number => (time.hours ?? 0) * 60 + (time.minutes ?? 0)

const address = (value: unknown): GbpPostalAddress => {
  const raw = record(value, 'storefrontAddress')
  onlyKeys(raw, ADDRESS_KEYS, 'storefrontAddress')
  const regionCode = text(raw.regionCode, 'storefrontAddress.regionCode', 2)
  if (!/^[A-Z]{2}$/.test(regionCode)) {
    throw new ValidationError('storefrontAddress.regionCode must be a two-letter CLDR region code')
  }
  const out: GbpPostalAddress = { regionCode }
  if (raw.addressLines !== undefined) {
    if (
      !Array.isArray(raw.addressLines) ||
      raw.addressLines.length < 1 ||
      raw.addressLines.length > 5
    ) {
      throw new ValidationError('storefrontAddress.addressLines must hold one to five lines')
    }
    out.addressLines = raw.addressLines.map((line, index) =>
      text(line, `storefrontAddress.addressLines[${index}]`, 200),
    )
  }
  for (const key of [
    'administrativeArea',
    'languageCode',
    'locality',
    'postalCode',
    'sublocality',
  ] as const) {
    if (raw[key] !== undefined) {
      out[key] = text(raw[key], `storefrontAddress.${key}`, 200)
    }
  }
  return out
}

const regularHours = (value: unknown): { periods: GbpTimePeriod[] } => {
  const raw = record(value, 'regularHours')
  onlyKeys(raw, ['periods'], 'regularHours')
  if (!Array.isArray(raw.periods) || raw.periods.length === 0) {
    throw new ValidationError('regularHours.periods must hold at least one period')
  }
  return {
    periods: raw.periods.map((item, index) => {
      const field = `regularHours.periods[${index}]`
      const period = record(item, field)
      onlyKeys(period, ['openDay', 'openTime', 'closeDay', 'closeTime'], field)
      return {
        closeDay: day(period.closeDay, `${field}.closeDay`),
        closeTime: timeOfDay(period.closeTime, `${field}.closeTime`, true),
        openDay: day(period.openDay, `${field}.openDay`),
        openTime: timeOfDay(period.openTime, `${field}.openTime`, false),
      }
    }),
  }
}

const specialHours = (value: unknown): { specialHourPeriods: GbpSpecialHourPeriod[] } => {
  const raw = record(value, 'specialHours')
  onlyKeys(raw, ['specialHourPeriods'], 'specialHours')
  if (!Array.isArray(raw.specialHourPeriods)) {
    throw new ValidationError('specialHours.specialHourPeriods must be an array')
  }
  return {
    specialHourPeriods: raw.specialHourPeriods.map((item, index) => {
      const field = `specialHours.specialHourPeriods[${index}]`
      const period = record(item, field)
      onlyKeys(period, ['startDate', 'endDate', 'openTime', 'closeTime', 'closed'], field)
      const startDate = dateValue(period.startDate, `${field}.startDate`)
      if (period.closed !== undefined && typeof period.closed !== 'boolean') {
        throw new ValidationError(`${field}.closed must be a boolean`)
      }
      if (period.closed === true) {
        if (period.openTime !== undefined || period.closeTime !== undefined) {
          throw new ValidationError(`${field} is closed, so it takes no opening or closing time`)
        }
        return { closed: true, startDate }
      }
      const openTime = timeOfDay(period.openTime, `${field}.openTime`, false)
      const closeTime = timeOfDay(period.closeTime, `${field}.closeTime`, true)
      const out: GbpSpecialHourPeriod = { closed: false, closeTime, openTime, startDate }
      if (period.endDate !== undefined) {
        const endDate = dateValue(period.endDate, `${field}.endDate`)
        const span = dayNumber(endDate) - dayNumber(startDate)
        if (span < 0 || span > 1) {
          throw new ValidationError(`${field}.endDate must be the start date or the day after`)
        }
        out.endDate = endDate
      } else if (minutesOf(closeTime) <= minutesOf(openTime)) {
        throw new ValidationError(
          `${field} closes before it opens; set endDate for overnight hours`,
        )
      }
      return out
    }),
  }
}

const website = (value: unknown): string => {
  const uri = text(value, 'websiteUri', 2000)
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new ValidationError('websiteUri must be a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('websiteUri must use http(s)://')
  }
  return uri
}

/**
 * Validate a location patch at the boundary and derive Google's `updateMask` from the keys the
 * caller named. The returned body holds only those fields.
 */
export const buildLocationPatch = (
  patch: unknown,
): { body: GbpLocationPatch; updateMask: string[] } => {
  const raw = record(patch, 'patch')
  onlyKeys(raw, PATCH_ORDER, 'patch')
  const keys = PATCH_ORDER.filter((key) => raw[key] !== undefined)
  if (keys.length === 0) {
    throw new ValidationError(`patch must name at least one of: ${PATCH_ORDER.join(', ')}`)
  }
  const body: GbpLocationPatch = {}
  for (const key of keys) {
    switch (key) {
      case 'phoneNumbers': {
        const phones = record(raw.phoneNumbers, 'phoneNumbers')
        onlyKeys(phones, ['primaryPhone'], 'phoneNumbers')
        body.phoneNumbers = {
          primaryPhone: text(phones.primaryPhone, 'phoneNumbers.primaryPhone', 40),
        }
        break
      }
      case 'profile': {
        const profile = record(raw.profile, 'profile')
        onlyKeys(profile, ['description'], 'profile')
        body.profile = {
          description: text(profile.description, 'profile.description', GBP_DESCRIPTION_MAX_LENGTH),
        }
        break
      }
      case 'regularHours':
        body.regularHours = regularHours(raw.regularHours)
        break
      case 'specialHours':
        body.specialHours = specialHours(raw.specialHours)
        break
      case 'storefrontAddress':
        body.storefrontAddress = address(raw.storefrontAddress)
        break
      case 'websiteUri':
        body.websiteUri = website(raw.websiteUri)
        break
    }
  }
  return { body, updateMask: keys.map((key) => PATCH_MASKS[key]) }
}

export const requireOpenStatus = (value: unknown): GbpOpenStatus => {
  if (typeof value !== 'string' || !(GBP_OPEN_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`status must be one of: ${GBP_OPEN_STATUSES.join(', ')}`)
  }
  return value as GbpOpenStatus
}

/**
 * Accepts a bare location id, `locations/{id}` or `accounts/{a}/locations/{id}` and returns the
 * Business Information resource name `locations/{id}`.
 */
export const toLocationName = (location: string): string => {
  const match = /^(?:accounts\/[^/]+\/)?(?:locations\/)?([\w-]{1,64})$/.exec(location.trim())
  if (!match) {
    throw new ValidationError('location must be a location id or a locations/{id} resource name')
  }
  return `locations/${match[1]}`
}

/**
 * Collect Google's per-field messages from an error body: `google.rpc.BadRequest` field
 * violations and `google.rpc.ErrorInfo` reasons, in the order Google sent them.
 */
export const parseGoogleFieldViolations = (raw: unknown): PlatformFieldViolation[] => {
  const error = isRecord(raw) && isRecord(raw.error) ? raw.error : isRecord(raw) ? raw : undefined
  const details = Array.isArray(error?.details) ? error.details : []
  const out: PlatformFieldViolation[] = []
  for (const detail of details) {
    if (!isRecord(detail)) {
      continue
    }
    if (Array.isArray(detail.fieldViolations)) {
      for (const violation of detail.fieldViolations) {
        if (isRecord(violation) && typeof violation.description === 'string') {
          out.push({
            ...(typeof violation.field === 'string' ? { field: violation.field } : {}),
            message: violation.description,
            ...(typeof violation.reason === 'string' ? { reason: violation.reason } : {}),
          })
        }
      }
    } else if (typeof detail.reason === 'string') {
      const metadata = isRecord(detail.metadata) ? detail.metadata : {}
      const field =
        typeof metadata.field_mask === 'string'
          ? metadata.field_mask
          : typeof metadata.field === 'string'
            ? metadata.field
            : undefined
      const value = typeof metadata.value === 'string' ? `: ${metadata.value}` : ''
      out.push({
        ...(field ? { field } : {}),
        message: `${detail.reason}${value}`,
        reason: detail.reason,
      })
    }
  }
  return out
}
