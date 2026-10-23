import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'
import type {
  GbpDate,
  GbpLocationPatch,
  GbpOpenStatus,
  GbpPostalAddress,
  GbpSpecialHourPeriod,
  GbpTimePeriod,
} from './locationPatch.js'

import { ConflictError, PlatformApiError } from '../../utilities/errors.js'
import { GBP_HOSTS, gbpJson } from './api.js'
import {
  buildLocationPatch,
  parseGoogleFieldViolations,
  requireOpenStatus,
  toLocationName,
} from './locationPatch.js'

export const GBP_LOCATION_DETAIL_READ_MASK = [
  'name',
  'title',
  'storeCode',
  'languageCode',
  'categories',
  'websiteUri',
  'phoneNumbers',
  'storefrontAddress',
  'latlng',
  'regularHours',
  'specialHours',
  'openInfo',
  'profile',
  'metadata',
  'serviceArea',
  'labels',
].join(',')

export type GbpLocationMetadata = {
  canDelete?: boolean
  canOperateLocalPost?: boolean
  duplicateLocation?: string
  hasGoogleUpdated?: boolean
  hasPendingEdits?: boolean
  hasVoiceOfMerchant?: boolean
  mapsUri?: string
  newReviewUri?: string
  placeId?: string
}

/** One listing as Business Information v1 holds it, limited to the fields the read mask names. */
export type GbpLocationDetail = {
  categories?: {
    additionalCategories?: Array<{ displayName?: string; name?: string }>
    primaryCategory?: { displayName?: string; name?: string }
  }
  labels?: string[]
  languageCode?: string
  latlng?: { latitude?: number; longitude?: number }
  locationId: string
  metadata: GbpLocationMetadata
  /** `locations/{id}`. */
  name: string
  openInfo?: { canReopen?: boolean; openingDate?: GbpDate; status?: GbpOpenStatus }
  phoneNumbers?: { additionalPhones?: string[]; primaryPhone?: string }
  profile?: { description?: string }
  regularHours?: { periods?: GbpTimePeriod[] }
  serviceArea?: Record<string, unknown>
  specialHours?: { specialHourPeriods?: GbpSpecialHourPeriod[] }
  storeCode?: string
  storefrontAddress?: Partial<GbpPostalAddress>
  title: string
  websiteUri?: string
}

export type GbpLocationWriteResult = {
  /** The listing as Google returned it; absent for a `validateOnly` request. */
  location?: GbpLocationDetail
  updateMask: string[]
  validateOnly: boolean
}

type RawLocation = Omit<Partial<GbpLocationDetail>, 'locationId'>

const toDetail = (raw: RawLocation, name: string): GbpLocationDetail => {
  const resolved = typeof raw.name === 'string' && raw.name ? raw.name : name
  return {
    ...raw,
    name: resolved,
    locationId: resolved.slice(resolved.lastIndexOf('/') + 1),
    metadata: raw.metadata ?? {},
    title: raw.title ?? '',
  }
}

const locationUrl = (name: string, params?: URLSearchParams): string =>
  `${GBP_HOSTS.businessInformation}/v1/${name}${params ? `?${params.toString()}` : ''}`

/**
 * Re-raise a rejected location request with Google's own message and field violations, without
 * the request URL. A 5xx keeps its original classification.
 */
const asLocationError = (error: unknown, action: string): unknown => {
  if (!(error instanceof PlatformApiError) || error.statusCode >= 500) {
    return error
  }
  const fieldViolations = parseGoogleFieldViolations(error.raw)
  const detail =
    fieldViolations.length > 0
      ? fieldViolations
          .map((violation) =>
            violation.field ? `${violation.field}: ${violation.message}` : violation.message,
          )
          .join('; ')
      : error.upstreamMessage || `status ${error.statusCode}`
  return new PlatformApiError({
    fieldViolations,
    message: `Google rejected the ${action}: ${detail}`,
    outcome: error.outcome,
    platform: 'gbp',
    raw: error.raw,
    retryable: error.retryable,
    statusCode: error.statusCode,
    upstreamCode: error.upstreamCode,
    upstreamMessage: error.upstreamMessage,
  })
}

/** Read one listing: address, hours, description, phone, website, open state and metadata. */
export const getLocation = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  location: string,
  readMask: string = GBP_LOCATION_DETAIL_READ_MASK,
): Promise<GbpLocationDetail> => {
  const name = toLocationName(location)
  try {
    const raw = await gbpJson<RawLocation>(
      payload,
      options,
      locationUrl(name, new URLSearchParams({ readMask })),
    )
    return toDetail(raw ?? {}, name)
  } catch (error) {
    throw asLocationError(error, 'location read')
  }
}

const patchLocation = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  name: string,
  body: Record<string, unknown>,
  updateMask: string[],
  validateOnly: boolean,
  action: string,
): Promise<GbpLocationWriteResult> => {
  const params = new URLSearchParams({ updateMask: updateMask.join(',') })
  if (validateOnly) {
    params.set('validateOnly', 'true')
  }
  try {
    const raw = await gbpJson<RawLocation | undefined>(
      payload,
      options,
      locationUrl(name, params),
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      },
    )
    const returned = raw && typeof raw === 'object' && Object.keys(raw).length > 0
    return {
      ...(returned && !validateOnly ? { location: toDetail(raw, name) } : {}),
      updateMask,
      validateOnly,
    }
  } catch (error) {
    throw asLocationError(error, action)
  }
}

/**
 * Change the listing's address, regular or special hours, description, primary phone or website.
 * The `updateMask` is derived from the patch keys only. With `validateOnly`, Google checks the
 * exact change and nothing is saved.
 */
export const updateLocation = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  location: string,
  patch: GbpLocationPatch,
  { validateOnly = false }: { validateOnly?: boolean } = {},
): Promise<GbpLocationWriteResult> => {
  const name = toLocationName(location)
  const { body, updateMask } = buildLocationPatch(patch)
  return patchLocation(payload, options, name, body, updateMask, validateOnly, 'location update')
}

const assertTitle = (detail: GbpLocationDetail, expectedTitle: string | undefined): void => {
  if (expectedTitle !== undefined && detail.title.trim() !== expectedTitle.trim()) {
    throw new ConflictError(
      `The listing is titled "${detail.title}", not "${expectedTitle}"; nothing was changed`,
    )
  }
}

/** Why Google's own flags rule out deleting this listing, or undefined when they allow it. */
export const locationDeletionRefusal = (detail: GbpLocationDetail): string | undefined => {
  if (detail.metadata.canDelete !== true) {
    return 'Google does not allow this listing to be deleted through the API. Close it instead, or remove it on the Business Profile site.'
  }
  if (detail.metadata.hasVoiceOfMerchant === true && !detail.metadata.duplicateLocation) {
    return 'A verified listing is closed, not deleted.'
  }
  return undefined
}

/**
 * Mark the listing open, temporarily closed or permanently closed (`openInfo.status`). When
 * `expectedTitle` is given the listing is read first and a different title refuses with 409.
 */
export const setOpenStatus = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  location: string,
  status: GbpOpenStatus,
  { expectedTitle, validateOnly = false }: { expectedTitle?: string; validateOnly?: boolean } = {},
): Promise<GbpLocationWriteResult> => {
  const name = toLocationName(location)
  const openStatus = requireOpenStatus(status)
  if (expectedTitle !== undefined) {
    assertTitle(await getLocation(payload, options, name, 'name,title'), expectedTitle)
  }
  return patchLocation(
    payload,
    options,
    name,
    { openInfo: { status: openStatus } },
    ['openInfo.status'],
    validateOnly,
    'open status change',
  )
}

/**
 * Remove a listing from the account. Google's `metadata.canDelete` must be true, and a verified
 * listing is deleted only when Google names it a duplicate of another; otherwise 409 and nothing
 * is sent. Returns the listing as it was read just before deletion.
 */
export const deleteLocation = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  location: string,
  { expectedTitle }: { expectedTitle?: string } = {},
): Promise<{ deleted: true; location: GbpLocationDetail }> => {
  const name = toLocationName(location)
  const current = await getLocation(payload, options, name, 'name,title,storeCode,metadata')
  assertTitle(current, expectedTitle)
  const refusal = locationDeletionRefusal(current)
  if (refusal) {
    throw new ConflictError(refusal)
  }
  try {
    await gbpJson<undefined>(payload, options, locationUrl(name), { method: 'DELETE' })
  } catch (error) {
    throw asLocationError(error, 'location deletion')
  }
  return { deleted: true, location: current }
}
