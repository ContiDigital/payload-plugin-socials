import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { GBP_HOSTS, gbpJson } from './api.js'

/**
 * GBP account + location discovery. Two-step process:
 *
 *   1. List accounts the credential can see (Account Management API v1).
 *   2. For each account, list locations (Business Information API v1).
 *
 * Locations resource names look like `locations/{id}` at the v1 layer but
 * when we build LocalPost paths (legacy v4) we MUST prepend the account:
 * `accounts/{a}/locations/{l}/localPosts`. The plugin always returns the
 * fully-qualified resource path on `GbpLocation.resourceName` so callers
 * never have to concatenate.
 */

export type GbpAccount = {
  /** Numeric id portion of `accounts/{id}`. */
  accountId: string
  accountName?: string
  name: string
  role?: string
  type?: string
  verificationState?: string
  vettedState?: string
}

type RawAccount = {
  accountName?: string
  name?: string
  role?: string
  type?: string
  verificationState?: string
  vettedState?: string
}

type AccountsResponse = {
  accounts?: RawAccount[]
  nextPageToken?: null | string
}

const extractAccountId = (name: string | undefined): string => {
  if (!name) {
    return ''
  }
  const match = name.match(/^accounts\/([^/]+)$/)
  return match ? match[1] : ''
}

const extractLocationId = (name: string | undefined): string => {
  if (!name) {
    return ''
  }
  // Locations may be named either `locations/{id}` (v1) OR `accounts/{a}/locations/{id}` (v4).
  const v4 = name.match(/locations\/([^/]+)$/)
  return v4 ? v4[1] : ''
}

export const listAccounts = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<GbpAccount[]> => {
  const out: GbpAccount[] = []
  let pageToken: string | undefined

  while (true) {
    const params = new URLSearchParams({ pageSize: '20' })
    if (pageToken) {
      params.set('pageToken', pageToken)
    }
    const url = `${GBP_HOSTS.accountManagement}/v1/accounts?${params.toString()}`
    const page = await gbpJson<AccountsResponse>(payload, options, url)
    for (const raw of page.accounts ?? []) {
      const accountId = extractAccountId(raw.name)
      if (!accountId) {
        continue
      }
      out.push({
        name: raw.name ?? '',
        type: raw.type,
        accountId,
        accountName: raw.accountName,
        role: raw.role,
        verificationState: raw.verificationState,
        vettedState: raw.vettedState,
      })
    }
    if (!page.nextPageToken) {
      break
    }
    pageToken = page.nextPageToken
  }

  return out
}

export type GbpLocation = {
  accountId: string
  /** Google allows the API to delete this listing (`metadata.canDelete`). */
  canDelete?: boolean
  /**
   * True when the location can receive LocalPosts: Google says so, or the owner holds voice of
   * merchant. Business Information v1 omits `canOperateLocalPost` for verified listings that do
   * take posts, so the flag alone hides them.
   */
  canOperateLocalPost: boolean
  /** Resource name of the listing Google considers this one a duplicate of. */
  duplicateLocation?: string
  hasPendingEdits?: boolean
  /** The signed-in owner is verified and controls the listing. */
  hasVoiceOfMerchant?: boolean
  languageCode?: string
  latlng?: { latitude?: number; longitude?: number }
  locationId: string
  mapsUri?: string
  placeId?: string
  primaryCategoryDisplay?: string
  /** Fully-qualified resource name `accounts/{a}/locations/{l}` ready for LocalPost paths. */
  resourceName: string
  storeCode?: string
  storefrontAddress?: {
    addressLines?: string[]
    administrativeArea?: string
    locality?: string
    postalCode?: string
    regionCode?: string
  }
  title: string
  websiteUri?: string
}

type RawLocation = {
  categories?: {
    primaryCategory?: { displayName?: string }
  }
  languageCode?: string
  latlng?: GbpLocation['latlng']
  metadata?: {
    canDelete?: boolean
    canOperateLocalPost?: boolean
    duplicateLocation?: string
    hasPendingEdits?: boolean
    hasVoiceOfMerchant?: boolean
    mapsUri?: string
    placeId?: string
  }
  name?: string
  storeCode?: string
  storefrontAddress?: GbpLocation['storefrontAddress']
  title?: string
  websiteUri?: string
}

type LocationsResponse = {
  locations?: RawLocation[]
  nextPageToken?: null | string
  totalSize?: number
}

const DEFAULT_READ_MASK = [
  'name',
  'title',
  'storeCode',
  'languageCode',
  'categories',
  'websiteUri',
  'storefrontAddress',
  'latlng',
  'metadata',
].join(',')

export const listLocations = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  accountId: string,
): Promise<GbpLocation[]> => {
  const out: GbpLocation[] = []
  let pageToken: string | undefined

  while (true) {
    const params = new URLSearchParams({
      pageSize: '100',
      readMask: DEFAULT_READ_MASK,
    })
    if (pageToken) {
      params.set('pageToken', pageToken)
    }
    const url =
      `${GBP_HOSTS.businessInformation}/v1/accounts/${encodeURIComponent(accountId)}` +
      `/locations?${params.toString()}`
    const page = await gbpJson<LocationsResponse>(payload, options, url)
    for (const raw of page.locations ?? []) {
      const locationId = extractLocationId(raw.name)
      if (!locationId) {
        continue
      }
      out.push({
        accountId,
        canDelete: raw.metadata?.canDelete,
        canOperateLocalPost:
          raw.metadata?.canOperateLocalPost === true || raw.metadata?.hasVoiceOfMerchant === true,
        duplicateLocation: raw.metadata?.duplicateLocation,
        hasPendingEdits: raw.metadata?.hasPendingEdits,
        hasVoiceOfMerchant: raw.metadata?.hasVoiceOfMerchant,
        languageCode: raw.languageCode,
        latlng: raw.latlng,
        locationId,
        mapsUri: raw.metadata?.mapsUri,
        placeId: raw.metadata?.placeId,
        primaryCategoryDisplay: raw.categories?.primaryCategory?.displayName,
        resourceName: `accounts/${accountId}/locations/${locationId}`,
        storeCode: raw.storeCode,
        storefrontAddress: raw.storefrontAddress,
        title: raw.title ?? '',
        websiteUri: raw.websiteUri,
      })
    }
    if (!page.nextPageToken) {
      break
    }
    pageToken = page.nextPageToken
  }

  return out
}

/**
 * Convenience: discover every location the credential can post to, flattened
 * across all accounts the user manages. Keeps locations Google marks postable or whose owner holds
 * voice of merchant; drops the rest (suspended / duplicate / unverified).
 */
export const listPostablesLocations = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<GbpLocation[]> =>
  (await listAllLocations(payload, options)).filter((location) => location.canOperateLocalPost)

/**
 * Every location across every account the credential manages, postable or not. Stale listings
 * show up here: a duplicate carries `duplicateLocation`, an unverified one lacks voice of merchant.
 */
export const listAllLocations = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<GbpLocation[]> => {
  const accounts = await listAccounts(payload, options)
  const out: GbpLocation[] = []
  for (const account of accounts) {
    out.push(...(await listLocations(payload, options, account.accountId)))
  }
  return out
}
