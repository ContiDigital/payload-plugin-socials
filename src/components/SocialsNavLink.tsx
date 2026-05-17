'use client'

import React from 'react'

type Props = {
  href?: string
  label?: string
}

/**
 * Minimal nav-link entry the plugin injects into Payload's admin sidebar
 * when `admin.mode` is `route` or `both`.
 *
 * Styling matches Payload's other plugin nav links (Merchant Center, GA4):
 * inline-only, theme-aware via CSS variables.
 */
export const SocialsNavLink: React.FC<Props> = ({ href = '/admin/socials', label = 'Socials' }) => {
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
