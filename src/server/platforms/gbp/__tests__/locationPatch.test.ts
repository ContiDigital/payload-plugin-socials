import { describe, expect, it } from 'vitest'

import {
  buildLocationPatch,
  parseGoogleFieldViolations,
  requireOpenStatus,
  toLocationName,
} from '../locationPatch.js'

const week = (open: number, close: number) =>
  (['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const).map((day) => ({
    closeDay: day,
    closeTime: { hours: close },
    openDay: day,
    openTime: { hours: open },
  }))

describe('buildLocationPatch', () => {
  it('derives the update mask from the patch keys only, in a stable order', () => {
    const { body, updateMask } = buildLocationPatch({
      phoneNumbers: { primaryPhone: '+1 555 010 0100' },
      profile: { description: 'A gallery of contemporary painting.' },
      websiteUri: 'https://example.com/',
    })
    expect(updateMask).toEqual(['profile.description', 'phoneNumbers.primaryPhone', 'websiteUri'])
    expect(Object.keys(body)).toEqual(['profile', 'phoneNumbers', 'websiteUri'])
  })

  it('accepts an address, regular hours and special hours', () => {
    const { body, updateMask } = buildLocationPatch({
      regularHours: { periods: week(10, 18) },
      specialHours: {
        specialHourPeriods: [
          { closed: true, startDate: { day: 25, month: 12, year: 2026 } },
          {
            closeTime: { hours: 15 },
            openTime: { hours: 11, minutes: 30 },
            startDate: { day: 24, month: 12, year: 2026 },
          },
        ],
      },
      storefrontAddress: {
        addressLines: ['100 Main Street'],
        administrativeArea: 'FL',
        locality: 'Springfield',
        postalCode: '00000',
        regionCode: 'US',
      },
    })
    expect(updateMask).toEqual(['storefrontAddress', 'regularHours', 'specialHours'])
    expect(body.regularHours?.periods[0]).toEqual({
      closeDay: 'TUESDAY',
      closeTime: { hours: 18, minutes: 0 },
      openDay: 'TUESDAY',
      openTime: { hours: 10, minutes: 0 },
    })
    expect(body.specialHours?.specialHourPeriods[0]).toEqual({
      closed: true,
      startDate: { day: 25, month: 12, year: 2026 },
    })
  })

  it('allows clearing special hours with an empty list', () => {
    expect(buildLocationPatch({ specialHours: { specialHourPeriods: [] } }).updateMask).toEqual([
      'specialHours',
    ])
  })

  it('accepts 24:00 as a closing time only', () => {
    expect(() =>
      buildLocationPatch({
        regularHours: {
          periods: [
            {
              closeDay: 'MONDAY',
              closeTime: { hours: 24 },
              openDay: 'MONDAY',
              openTime: { hours: 9 },
            },
          ],
        },
      }),
    ).not.toThrow()
    expect(() =>
      buildLocationPatch({
        regularHours: {
          periods: [
            {
              closeDay: 'MONDAY',
              closeTime: { hours: 23 },
              openDay: 'MONDAY',
              openTime: { hours: 24 },
            },
          ],
        },
      }),
    ).toThrow(/24:00 only as a closing time/)
  })

  it.each([
    [{}, /at least one of/],
    [{ title: 'New name' }, /unsupported keys: title/],
    [{ profile: { description: 'x'.repeat(751) } }, /at most 750/],
    [{ profile: { description: '   ' } }, /non-empty/],
    [{ phoneNumbers: { additionalPhones: ['1'], primaryPhone: '1' } }, /additionalPhones/],
    [{ websiteUri: 'ftp://example.com' }, /http/],
    [{ websiteUri: 'not a url' }, /valid URL/],
    [{ storefrontAddress: { addressLines: ['1 Main'] } }, /regionCode/],
    [{ storefrontAddress: { regionCode: 'usa' } }, /at most 2|two-letter/],
    [{ storefrontAddress: { addressLines: [], regionCode: 'US' } }, /one to five/],
    [{ regularHours: { periods: [] } }, /at least one period/],
    [
      {
        regularHours: {
          periods: [{ closeDay: 'MON', closeTime: {}, openDay: 'MONDAY', openTime: {} }],
        },
      },
      /closeDay must be one of/,
    ],
    [
      {
        specialHours: {
          specialHourPeriods: [{ closed: true, startDate: { day: 30, month: 2, year: 2026 } }],
        },
      },
      /not a calendar date/,
    ],
    [
      {
        specialHours: {
          specialHourPeriods: [
            {
              closed: true,
              openTime: { hours: 9 },
              startDate: { day: 1, month: 1, year: 2027 },
            },
          ],
        },
      },
      /takes no opening or closing time/,
    ],
    [
      {
        specialHours: {
          specialHourPeriods: [
            {
              closed: true,
              endDate: { day: 2, month: 1, year: 2027 },
              startDate: { day: 1, month: 1, year: 2027 },
            },
          ],
        },
      },
      /one closed day per period/,
    ],
    [
      {
        specialHours: {
          specialHourPeriods: [
            {
              closeTime: { hours: 9 },
              openTime: { hours: 18 },
              startDate: { day: 1, month: 1, year: 2027 },
            },
          ],
        },
      },
      /closes before it opens/,
    ],
    [
      {
        specialHours: {
          specialHourPeriods: [
            {
              closeTime: { hours: 2 },
              endDate: { day: 3, month: 1, year: 2027 },
              openTime: { hours: 18 },
              startDate: { day: 1, month: 1, year: 2027 },
            },
          ],
        },
      },
      /start date or the day after/,
    ],
  ])('refuses %j', (patch, message) => {
    expect(() => buildLocationPatch(patch)).toThrow(message)
  })

  it('accepts overnight special hours that end the next day', () => {
    const { body } = buildLocationPatch({
      specialHours: {
        specialHourPeriods: [
          {
            closeTime: { hours: 2 },
            endDate: { day: 2, month: 1, year: 2027 },
            openTime: { hours: 18 },
            startDate: { day: 1, month: 1, year: 2027 },
          },
        ],
      },
    })
    expect(body.specialHours?.specialHourPeriods[0]?.endDate).toEqual({
      day: 2,
      month: 1,
      year: 2027,
    })
  })
})

describe('toLocationName', () => {
  it.each([
    ['123', 'locations/123'],
    ['locations/123', 'locations/123'],
    ['accounts/9/locations/123', 'locations/123'],
  ])('normalizes %s', (input, expected) => {
    expect(toLocationName(input)).toBe(expected)
  })

  it.each(['', 'locations/', 'locations/12/../34', 'accounts/9/locations/1/localPosts/2'])(
    'refuses %j',
    (input) => {
      expect(() => toLocationName(input)).toThrow(/location id/)
    },
  )
})

describe('requireOpenStatus', () => {
  it('accepts the three statuses and refuses anything else', () => {
    expect(requireOpenStatus('CLOSED_PERMANENTLY')).toBe('CLOSED_PERMANENTLY')
    expect(() => requireOpenStatus('OPEN_FOR_BUSINESS_UNSPECIFIED')).toThrow(/status must be/)
  })
})

describe('parseGoogleFieldViolations', () => {
  it('reads BadRequest field violations and ErrorInfo reasons', () => {
    expect(
      parseGoogleFieldViolations({
        error: {
          code: 400,
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                { description: 'Invalid phone number', field: 'phone_numbers.primary_phone' },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              metadata: { field_mask: 'profile.description', value: 'http://x' },
              reason: 'LINK_NOT_ALLOWED',
            },
            { '@type': 'type.googleapis.com/google.rpc.Help' },
          ],
          message: 'Request contains an invalid argument.',
        },
      }),
    ).toEqual([
      { field: 'phone_numbers.primary_phone', message: 'Invalid phone number' },
      {
        field: 'profile.description',
        message: 'LINK_NOT_ALLOWED: http://x',
        reason: 'LINK_NOT_ALLOWED',
      },
    ])
  })

  it('returns nothing for a body without details', () => {
    expect(parseGoogleFieldViolations('plain text')).toEqual([])
    expect(parseGoogleFieldViolations({ error: { message: 'x' } })).toEqual([])
  })
})
