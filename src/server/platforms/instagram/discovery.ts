import type { Payload } from 'payload'

import type { NormalizedPluginOptions } from '../../../types/index.js'

import { metaJson } from '../_meta/api.js'

/**
 * Discover the IG Business user id from a Facebook Page id.
 *
 * CLAUDE.md §4.4: Instagram publishing requires the IG account to be:
 *   - Business or Creator type
 *   - Linked to the Facebook Page passed in
 *
 * If the Page has no IG link, `instagram_business_account` is null and the
 * helper returns `null` so the caller can surface a clear "no IG account
 * linked to this Page" error in the admin UI.
 */

type PageWithIgResponse = {
  id: string
  instagram_business_account?: { id: string } | null
  name?: string
}

export type IgBusinessAccount = {
  igUserId: string
  pageId: string
  pageName?: string
}

export const discoverIgAccountFromPage = async (
  payload: Payload,
  options: NormalizedPluginOptions,
  pageId: string,
): Promise<IgBusinessAccount | null> => {
  const data = await metaJson<PageWithIgResponse>(
    payload,
    options,
    'instagram',
    `/${encodeURIComponent(pageId)}?fields=id,name,instagram_business_account`,
  )
  if (!data.instagram_business_account?.id) {
    return null
  }
  return {
    igUserId: data.instagram_business_account.id,
    pageId: data.id,
    pageName: data.name,
  }
}

type AccountsResponse = {
  data?: Array<{
    access_token?: string
    category?: string
    id: string
    instagram_business_account?: { id: string } | null
    name?: string
  }>
  paging?: { cursors?: { after?: string }; next?: string }
}

/**
 * Returns every IG Business account reachable via the currently-stored
 * Meta access token. Walks `/me/accounts` (the Pages list) and emits one
 * entry per page that has a linked IG account.
 *
 * Useful for the admin UI's account picker — a single user/system token
 * commonly manages multiple Pages.
 */
export const listIgAccounts = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<IgBusinessAccount[]> => {
  const out: IgBusinessAccount[] = []
  let nextCursor: string | undefined

  while (true) {
    const qs = new URLSearchParams({
      fields: 'id,name,instagram_business_account',
      limit: '50',
    })
    if (nextCursor) {
      qs.set('after', nextCursor)
    }
    const page = await metaJson<AccountsResponse>(
      payload,
      options,
      'instagram',
      `/me/accounts?${qs.toString()}`,
    )
    for (const entry of page.data ?? []) {
      if (entry.instagram_business_account?.id) {
        out.push({
          igUserId: entry.instagram_business_account.id,
          pageId: entry.id,
          pageName: entry.name,
        })
      }
    }
    nextCursor = page.paging?.cursors?.after
    if (!nextCursor || !page.paging?.next) {
      break
    }
  }

  return out
}
