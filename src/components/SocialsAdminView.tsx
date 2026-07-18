import type { AdminViewServerProps } from 'payload'

import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import React from 'react'

import { SocialsAdminViewClient } from './SocialsAdminViewClient.js'

/**
 * Server-rendered shell for the `/admin/socials` route. The header bits use
 * Payload's `DefaultTemplate` so the page feels native; the content is a
 * client island with two tabs: Compose and Connections.
 */
export const SocialsAdminView: React.FC<{ title?: string } & AdminViewServerProps> = ({
  initPageResult,
  params,
  searchParams,
  title = 'Socials',
}) => {
  const enabledPlatforms =
    (
      (initPageResult?.req?.payload?.config?.custom as Record<string, unknown> | undefined)
        ?.socials as { enabledPlatforms?: string[] } | undefined
    )?.enabledPlatforms ?? []

  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={initPageResult.req.payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={initPageResult.req.user || undefined}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <header style={{ marginBottom: '1rem' }}>
          <h1>{title}</h1>
          <p style={{ color: 'var(--theme-elevation-500)' }}>
            Multi-platform organic publishing. Compose posts or manage connections.
          </p>
        </header>
        <SocialsAdminViewClient enabledPlatforms={enabledPlatforms} />
      </Gutter>
    </DefaultTemplate>
  )
}
