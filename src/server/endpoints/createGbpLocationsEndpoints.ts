import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions } from '../../types/index.js'

import { requireOpenStatus } from '../platforms/gbp/locationPatch.js'
import {
  deleteLocation,
  getLocation,
  setOpenStatus,
  updateLocation,
} from '../platforms/gbp/locationProfile.js'
import {
  listAccounts,
  listAllLocations,
  listLocations,
  listPostablesLocations,
} from '../platforms/gbp/locations.js'
import { assertAccess } from '../utilities/access.js'
import { ValidationError } from '../utilities/errors.js'
import { errorResponse, getRouteParam, jsonResponse, parseRequestBody } from '../utilities/http.js'
import { optionalString, requireString } from '../utilities/validation.js'

/**
 * GBP account + location discovery endpoints. The Pinterest equivalent is
 * `/socials/pinterest/boards`; here we have a two-tier structure because
 * Google's hierarchy is `account → location → localPost` and the user often
 * has multiple accounts.
 *
 *   GET    {basePath}/gbp/accounts: list manageable accounts
 *   GET    {basePath}/gbp/accounts/:accountId/locations: every location under one account
 *   GET    {basePath}/gbp/locations: flattened postable list across all accounts;
 *          `?include=all` adds every non-postable listing
 *   GET    {basePath}/gbp/locations/:locationId: one listing's full profile (publisher)
 *   PATCH  {basePath}/gbp/locations/:locationId: edit the profile (admin)
 *   POST   {basePath}/gbp/locations/:locationId/open-status: open or close (admin)
 *   DELETE {basePath}/gbp/locations/:locationId: remove a deletable listing (admin)
 */

const requireLocationId = (value: string | undefined): string => {
  const id = requireString(value, 'locationId')
  if (!/^\d{1,30}$/.test(id)) {
    throw new ValidationError('locationId must be the numeric Business Profile location id')
  }
  return id
}

const optionalBoolean = (value: unknown, field: string): boolean => {
  if (value === undefined || value === null) {
    return false
  }
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`)
  }
  return value
}

const queryValue = (query: unknown, name: string): unknown =>
  query && typeof query === 'object' ? (query as Record<string, unknown>)[name] : undefined

const createListAccountsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const accounts = await listAccounts(req.payload, options)
      return jsonResponse({ accounts })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/accounts`,
})

const createListAccountLocationsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const accountId = requireString(getRouteParam(req, 'accountId'), 'accountId')
      const locations = await listLocations(req.payload, options, accountId)
      return jsonResponse({ accountId, locations })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/accounts/:accountId/locations`,
})

const createListPostableLocationsEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const include = queryValue(req.query, 'include')
      if (include !== undefined && include !== 'all' && include !== 'postable') {
        throw new ValidationError('include must be "postable" or "all"')
      }
      const locations =
        include === 'all'
          ? await listAllLocations(req.payload, options)
          : await listPostablesLocations(req.payload, options)
      return jsonResponse({ locations })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/locations`,
})

const createGetLocationEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'publisher')
      const locationId = requireLocationId(getRouteParam(req, 'locationId'))
      const location = await getLocation(req.payload, options, locationId)
      return jsonResponse({ location })
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'get',
  path: `${options.api.basePath}/gbp/locations/:locationId`,
})

const createUpdateLocationEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      const locationId = requireLocationId(getRouteParam(req, 'locationId'))
      const body = await parseRequestBody(req)
      const result = await updateLocation(req.payload, options, locationId, body.patch as never, {
        validateOnly: optionalBoolean(body.validateOnly, 'validateOnly'),
      })
      return jsonResponse(result)
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'patch',
  path: `${options.api.basePath}/gbp/locations/:locationId`,
})

const createOpenStatusEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      const locationId = requireLocationId(getRouteParam(req, 'locationId'))
      const body = await parseRequestBody(req)
      const result = await setOpenStatus(
        req.payload,
        options,
        locationId,
        requireOpenStatus(body.status),
        {
          expectedTitle: optionalString(body.expectedTitle, 'expectedTitle'),
          validateOnly: optionalBoolean(body.validateOnly, 'validateOnly'),
        },
      )
      return jsonResponse(result)
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'post',
  path: `${options.api.basePath}/gbp/locations/:locationId/open-status`,
})

const createDeleteLocationEndpoint = (options: NormalizedPluginOptions): Endpoint => ({
  handler: async (req) => {
    try {
      await assertAccess(req, options, 'admin')
      const locationId = requireLocationId(getRouteParam(req, 'locationId'))
      const result = await deleteLocation(req.payload, options, locationId, {
        expectedTitle: optionalString(queryValue(req.query, 'expectedTitle'), 'expectedTitle'),
      })
      return jsonResponse(result)
    } catch (error) {
      return errorResponse(req, error)
    }
  },
  method: 'delete',
  path: `${options.api.basePath}/gbp/locations/:locationId`,
})

export const createGbpLocationsEndpoints = (options: NormalizedPluginOptions): Endpoint[] => {
  if (!options.platforms.gbp.enabled) {
    return []
  }
  return [
    createListAccountsEndpoint(options),
    createListAccountLocationsEndpoint(options),
    createListPostableLocationsEndpoint(options),
    createGetLocationEndpoint(options),
    createUpdateLocationEndpoint(options),
    createOpenStatusEndpoint(options),
    createDeleteLocationEndpoint(options),
  ]
}
