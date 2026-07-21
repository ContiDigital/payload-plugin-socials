import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { PlatformApiError } from '../../utilities/errors.js'
import { metaJson } from '../_meta/api.js'

/**
 * Facebook Page discovery + Page-access-token derivation.
 *
 * `GET /me/accounts` returns the set of Pages the current access token
 * holder manages, with a Page-scoped `access_token` for each. Plugin uses
 * these Page tokens to publish to a specific Page — calling /feed with the
 * USER token would 200 but post to the user's timeline, NOT the Page.
 *
 * Provider-side role or token changes can invalidate a derived Page token;
 * connection health must still be monitored.
 */

export type FacebookPage = {
  /** Page-scoped access token. Use this for `/{page-id}/...` publish calls. */
  accessToken?: string
  category?: string
  id: string
  name: string
  tasks?: string[]
}

type AccountsResponse = {
  data?: Array<{
    access_token?: string
    category?: string
    id: string
    name?: string
    tasks?: string[]
  }>
  paging?: { cursors?: { after?: string }; next?: string }
}

/**
 * Returns every Facebook Page the connected token can manage. Page-scoped
 * `accessToken` is included when the underlying credential has
 * `pages_show_list` granted.
 */
export const listManagedPages = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<FacebookPage[]> => {
  const out: FacebookPage[] = []
  let nextCursor: string | undefined

  while (true) {
    const qs = new URLSearchParams({
      fields: 'id,name,category,tasks,access_token',
      limit: '50',
    })
    if (nextCursor) {
      qs.set('after', nextCursor)
    }
    const page = await metaJson<AccountsResponse>(
      payload,
      options,
      'facebook',
      `/me/accounts?${qs.toString()}`,
    )
    for (const entry of page.data ?? []) {
      if (!entry.name) {
        continue
      }
      out.push({
        id: entry.id,
        name: entry.name,
        accessToken: entry.access_token,
        category: entry.category,
        tasks: entry.tasks,
      })
    }
    nextCursor = page.paging?.cursors?.after
    if (!nextCursor || !page.paging?.next) {
      break
    }
  }

  return out
}

/**
 * Look up a single Page-scoped access token. Throws if the Page isn't
 * reachable from the current credentials — clearer than letting the
 * publish path fail with a `code 200` permission-denied later.
 */
export const getPageAccessToken = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  pageId: string,
): Promise<string> => {
  type SinglePageResponse = {
    access_token?: string
    id: string
    name?: string
  }
  const response = await metaJson<SinglePageResponse>(
    payload,
    options,
    'facebook',
    `/${encodeURIComponent(pageId)}?fields=id,access_token,name`,
  )
  if (!response.access_token) {
    throw new PlatformApiError({
      message:
        `No Page access token returned for Page ${pageId}. ` +
        `Token holder must be a Page admin with CREATE_CONTENT task.`,
      platform: 'facebook',
      retryable: false,
      statusCode: 403,
    })
  }
  return response.access_token
}
