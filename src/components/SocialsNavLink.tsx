'use client'

import { useConfig } from '@payloadcms/ui'
import React from 'react'

import { resolveSocialsEndpointBase } from './accessModel.js'
import { useSocialsAccess } from './useSocialsAccess.js'

type Props = {
  href?: string
  label?: string
}

/**
 * Nav-link entry the plugin injects into Payload's admin sidebar when
 * `admin.mode` is `route` or `both`.
 *
 * Gated by the host `authorize`: on mount it probes `{basePath}/access` once and
 * renders nothing until the answer arrives. The link appears only for users the
 * host authorizes as `publisher` — everyone else sees no entry, and no toast is
 * ever fired from here.
 *
 * Styling matches Payload's other plugin nav links (Merchant Center, GA4):
 * inline-only, theme-aware via CSS variables.
 */
export const SocialsNavLink: React.FC<Props> = ({ href = '/admin/socials', label = 'Socials' }) => {
  const { config } = useConfig()
  const { loading, publisher } = useSocialsAccess(resolveSocialsEndpointBase(config))

  if (loading || !publisher) {
    return null
  }

  return (
    <a
      href={href}
      style={{
        alignItems: 'center',
        color: 'var(--theme-elevation-800)',
        display: 'flex',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        textDecoration: 'none',
      }}
    >
      <span aria-hidden="true">📣</span>
      <span>{label}</span>
    </a>
  )
}
