import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../../../types/index.js'
import type * as ApiModule from '../api.js'

vi.mock('../api.js', async (importActual) => ({
  ...(await importActual<typeof ApiModule>()),
  gbpJson: vi.fn(),
}))

import { ConflictError, PlatformApiError, ValidationError } from '../../../utilities/errors.js'
import { gbpJson } from '../api.js'
import {
  deleteLocation,
  GBP_LOCATION_DETAIL_READ_MASK,
  getLocation,
  locationDeletionRefusal,
  setOpenStatus,
  updateLocation,
} from '../locationProfile.js'

const payload = {} as Payload
const options = {} as NormalizedPluginOptions
const BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1/locations/123'

const listing = (metadata: Record<string, unknown> = {}, title = 'Main Street Gallery') => ({
  name: 'locations/123',
  metadata,
  openInfo: { canReopen: true, status: 'OPEN' },
  phoneNumbers: { primaryPhone: '(555) 010-0100' },
  profile: { description: 'Paintings and sculpture.' },
  regularHours: {
    periods: [
      {
        closeDay: 'TUESDAY',
        closeTime: { hours: 18 },
        openDay: 'TUESDAY',
        openTime: { hours: 10 },
      },
    ],
  },
  storeCode: 'MAIN',
  storefrontAddress: { addressLines: ['100 Main Street'], regionCode: 'US' },
  title,
  websiteUri: 'https://example.com/',
})

const googleRejection = () =>
  new PlatformApiError({
    message: `GBP ${BASE}?updateMask=profile.description failed: 400`,
    platform: 'gbp',
    raw: {
      error: {
        code: 400,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              { description: 'Links are not allowed', field: 'profile.description' },
            ],
          },
        ],
        message: 'Request contains an invalid argument.',
        status: 'INVALID_ARGUMENT',
      },
    },
    statusCode: 400,
    upstreamCode: 'INVALID_ARGUMENT',
    upstreamMessage: 'Request contains an invalid argument.',
  })

const calls = () => vi.mocked(gbpJson).mock.calls

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getLocation', () => {
  it('reads one listing with the full detail mask and keeps the metadata flags', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce(
      listing({ canDelete: false, duplicateLocation: 'locations/9', hasVoiceOfMerchant: true }),
    )
    const detail = await getLocation(payload, options, 'accounts/7/locations/123')
    const url = new URL(calls()[0]?.[2])
    expect(url.origin + url.pathname).toBe(BASE)
    expect(url.searchParams.get('readMask')).toBe(GBP_LOCATION_DETAIL_READ_MASK)
    expect(GBP_LOCATION_DETAIL_READ_MASK.split(',')).toEqual(
      expect.arrayContaining(['regularHours', 'specialHours', 'openInfo', 'profile', 'metadata']),
    )
    expect(detail).toMatchObject({
      name: 'locations/123',
      locationId: '123',
      metadata: { canDelete: false, duplicateLocation: 'locations/9', hasVoiceOfMerchant: true },
      profile: { description: 'Paintings and sculpture.' },
      title: 'Main Street Gallery',
    })
  })

  it('maps a 404 to a clean error without the request URL', async () => {
    vi.mocked(gbpJson).mockRejectedValueOnce(
      new PlatformApiError({
        message: `GBP ${BASE} failed: 404`,
        platform: 'gbp',
        statusCode: 404,
        upstreamMessage: 'Requested entity was not found.',
      }),
    )
    const error = await getLocation(payload, options, '123').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PlatformApiError)
    expect((error as PlatformApiError).statusCode).toBe(404)
    expect((error as Error).message).toContain('Requested entity was not found.')
    expect((error as Error).message).not.toContain('googleapis')
  })
})

describe('updateLocation', () => {
  it('sends a PATCH with the derived mask and only the named fields', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce(listing())
    const result = await updateLocation(payload, options, '123', {
      phoneNumbers: { primaryPhone: '+15550100100' },
      profile: { description: 'New description.' },
    })
    const [, , url, init] = calls()[0] ?? []
    const parsed = new URL(url)
    expect(parsed.searchParams.get('updateMask')).toBe(
      'profile.description,phoneNumbers.primaryPhone',
    )
    expect(parsed.searchParams.has('validateOnly')).toBe(false)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({
      phoneNumbers: { primaryPhone: '+15550100100' },
      profile: { description: 'New description.' },
    })
    expect(result).toMatchObject({
      location: { locationId: '123' },
      updateMask: ['profile.description', 'phoneNumbers.primaryPhone'],
      validateOnly: false,
    })
  })

  it('passes validateOnly through and returns no location', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce({})
    const result = await updateLocation(
      payload,
      options,
      '123',
      { websiteUri: 'https://example.com/visit' },
      { validateOnly: true },
    )
    expect(new URL(calls()[0]?.[2]).searchParams.get('validateOnly')).toBe('true')
    expect(result).toEqual({ updateMask: ['websiteUri'], validateOnly: true })
  })

  it("maps Google's 400 to a typed error carrying its field messages", async () => {
    vi.mocked(gbpJson).mockRejectedValueOnce(googleRejection())
    const error = (await updateLocation(payload, options, '123', {
      profile: { description: 'Visit http://example.com' },
    }).catch((caught: unknown) => caught)) as PlatformApiError
    expect(error).toBeInstanceOf(PlatformApiError)
    expect(error.statusCode).toBe(400)
    expect(error.fieldViolations).toEqual([
      { field: 'profile.description', message: 'Links are not allowed' },
    ])
    expect(error.message).toContain('Google rejected the location update')
    expect(error.message).toContain('profile.description: Links are not allowed')
    expect(error.message).not.toContain('googleapis')
  })

  it('keeps a 5xx untouched so its unknown outcome survives', async () => {
    const upstream = new PlatformApiError({
      message: 'GBP failed: 503',
      outcome: 'unknown',
      platform: 'gbp',
      statusCode: 503,
    })
    vi.mocked(gbpJson).mockRejectedValueOnce(upstream)
    await expect(
      updateLocation(payload, options, '123', { websiteUri: 'https://example.com/' }),
    ).rejects.toBe(upstream)
  })

  it('refuses an invalid patch before calling Google', async () => {
    await expect(
      updateLocation(payload, options, '123', { title: 'x' } as never),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(gbpJson).not.toHaveBeenCalled()
  })
})

describe('setOpenStatus', () => {
  it('patches openInfo.status only', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce(listing())
    await setOpenStatus(payload, options, '123', 'CLOSED_TEMPORARILY')
    const [, , url, init] = calls()[0] ?? []
    expect(new URL(url).searchParams.get('updateMask')).toBe('openInfo.status')
    expect(JSON.parse(init?.body as string)).toEqual({ openInfo: { status: 'CLOSED_TEMPORARILY' } })
  })

  it('refuses a different title without writing', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce({ name: 'locations/123', title: 'Other Gallery' })
    await expect(
      setOpenStatus(payload, options, '123', 'CLOSED_PERMANENTLY', {
        expectedTitle: 'Main Street Gallery',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(calls()).toHaveLength(1)
    expect(calls()[0]?.[3]).toBeUndefined()
  })

  it('validates only when asked, after the title matches', async () => {
    vi.mocked(gbpJson)
      .mockResolvedValueOnce({ name: 'locations/123', title: 'Main Street Gallery' })
      .mockResolvedValueOnce({})
    const result = await setOpenStatus(payload, options, '123', 'CLOSED_PERMANENTLY', {
      expectedTitle: ' Main Street Gallery ',
      validateOnly: true,
    })
    expect(result).toEqual({ updateMask: ['openInfo.status'], validateOnly: true })
    expect(new URL(calls()[1]?.[2]).searchParams.get('validateOnly')).toBe('true')
  })

  it('refuses an unknown status', async () => {
    await expect(setOpenStatus(payload, options, '123', 'CLOSED' as never)).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})

describe('locationDeletionRefusal', () => {
  const detail = (metadata: Record<string, unknown>) =>
    ({ name: 'locations/1', locationId: '1', metadata, title: 'T' }) as never

  it('requires canDelete', () => {
    expect(locationDeletionRefusal(detail({}))).toMatch(/does not allow/)
    expect(locationDeletionRefusal(detail({ canDelete: false }))).toMatch(/does not allow/)
  })

  it('closes rather than deletes a verified listing unless Google names it a duplicate', () => {
    expect(locationDeletionRefusal(detail({ canDelete: true, hasVoiceOfMerchant: true }))).toBe(
      'A verified listing is closed, not deleted.',
    )
    expect(
      locationDeletionRefusal(
        detail({ canDelete: true, duplicateLocation: 'locations/2', hasVoiceOfMerchant: true }),
      ),
    ).toBeUndefined()
    expect(locationDeletionRefusal(detail({ canDelete: true }))).toBeUndefined()
  })
})

describe('deleteLocation', () => {
  it('reads the flags, then deletes a deletable listing', async () => {
    vi.mocked(gbpJson)
      .mockResolvedValueOnce(listing({ canDelete: true, hasVoiceOfMerchant: false }))
      .mockResolvedValueOnce(undefined)
    const result = await deleteLocation(payload, options, '123', {
      expectedTitle: 'Main Street Gallery',
    })
    expect(result).toMatchObject({ deleted: true, location: { locationId: '123' } })
    expect(calls()[1]?.[2]).toBe(BASE)
    expect(calls()[1]?.[3]).toEqual({ method: 'DELETE' })
  })

  it.each([
    [{ canDelete: false }, /does not allow/],
    [{ canDelete: true, hasVoiceOfMerchant: true }, /closed, not deleted/],
  ])('refuses %j without sending a DELETE', async (metadata, message) => {
    vi.mocked(gbpJson).mockResolvedValueOnce(listing(metadata))
    await expect(deleteLocation(payload, options, '123')).rejects.toThrow(message)
    expect(calls()).toHaveLength(1)
  })

  it('refuses a different title', async () => {
    vi.mocked(gbpJson).mockResolvedValueOnce(listing({ canDelete: true }, 'Other'))
    await expect(
      deleteLocation(payload, options, '123', { expectedTitle: 'Main Street Gallery' }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(calls()).toHaveLength(1)
  })

  it("passes Google's rejection of the delete through", async () => {
    vi.mocked(gbpJson)
      .mockResolvedValueOnce(listing({ canDelete: true }))
      .mockRejectedValueOnce(googleRejection())
    await expect(deleteLocation(payload, options, '123')).rejects.toThrow(
      /Google rejected the location deletion/,
    )
  })
})
