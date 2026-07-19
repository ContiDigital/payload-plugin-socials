'use client'

import { toast, useConfig } from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

import type { ConnectionState } from '../types/index.js'

import { PLATFORM_IDS, PLATFORM_LABELS, type PlatformId } from '../constants.js'
import { resolveSocialsEndpointBase } from './accessModel.js'
import { connectionButtonLabel, describeConnectionRow } from './connectionRowModel.js'
import { useSocialsAccess } from './useSocialsAccess.js'

type Props = {
  enabledPlatforms?: string[]
}

type ConnectionMap = Partial<Record<PlatformId, ConnectionState>>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/**
 * Visibility gate: the widget disappears entirely for a user the host
 * `authorize` rejects for the `admin` scope. Its data endpoint
 * (`{basePath}/connections`) requires admin, so gating on `publisher` left a
 * publisher-but-not-admin user staring at a permanently empty widget. It probes
 * `{basePath}/access` once and renders nothing until the answer arrives, so an
 * unauthorized user never sees the panel, and never sees a toast.
 */
export const SocialsDashboardWidget: React.FC<Props> = (props) => {
  const { config } = useConfig()
  const { admin, loading } = useSocialsAccess(resolveSocialsEndpointBase(config))
  if (loading || !admin) {
    return null
  }
  return <SocialsDashboardWidgetInner {...props} />
}

const SocialsDashboardWidgetInner: React.FC<Props> = ({ enabledPlatforms }) => {
  const { config } = useConfig()

  // Fix 1: read from config.admin?.custom (serialized to browser) instead of
  // config.custom (stripped by Payload 3.86 serverOnlyConfigProperties).
  const socials = asRecord(asRecord(config.admin?.custom)?.socials)

  const configuredPlatforms = Array.isArray(socials?.enabledPlatforms)
    ? socials.enabledPlatforms.filter((value): value is string => typeof value === 'string')
    : []
  const enabled = new Set(enabledPlatforms ?? configuredPlatforms)
  const apiRoute = typeof config.routes?.api === 'string' ? config.routes.api : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  const endpointBase = `${apiRoute.replace(/\/$/, '')}${basePath}`

  const [connections, setConnections] = useState<ConnectionMap>({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PlatformId>()
  // Two-step confirm: when set, shows a "Confirm disconnect" button for that platform
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<PlatformId>()

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(`${endpointBase}/connections`)
      const body = (await response.json()) as { connections?: ConnectionMap; error?: string }
      // Fail silently: this is a passive data fetch, not a user action. An
      // unauthorized response (e.g. publisher-but-not-admin) must never raise a
      // toast — the widget simply shows no connections.
      if (response.ok) {
        setConnections(body.connections ?? {})
      }
    } finally {
      setLoading(false)
    }
  }, [endpointBase])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const connect = async (platform: PlatformId): Promise<void> => {
    setPending(platform)
    try {
      const response = await fetch(`${endpointBase}/${platform}/oauth/start`, { method: 'POST' })
      const body = (await response.json()) as { error?: string; url?: string }
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? `Could not start ${PLATFORM_LABELS[platform]} OAuth`)
      }
      window.location.assign(body.url)
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
      setPending(undefined)
    }
  }

  const disconnect = async (platform: PlatformId): Promise<void> => {
    setPending(platform)
    setConfirmingDisconnect(undefined)
    try {
      const response = await fetch(`${endpointBase}/${platform}/disconnect`, { method: 'POST' })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `Disconnect failed (${response.status})`)
      }
      toast.success(`${PLATFORM_LABELS[platform]} disconnected.`)
      await loadConnections()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <section style={styles.container}>
      <h3 style={{ marginTop: 0 }}>Social connections</h3>
      <p style={styles.muted}>
        Tokens remain server-side and encrypted. OAuth redirects open in this tab.
      </p>
      {loading ? (
        <p style={styles.muted}>Loading connection status…</p>
      ) : enabled.size === 0 ? (
        <p style={styles.muted}>No platforms are enabled.</p>
      ) : (
        <ul style={styles.list}>
          {PLATFORM_IDS.filter((id) => enabled.has(id)).map((id) => {
            const row = describeConnectionRow(connections[id])
            const isPending = pending === id

            // Config-managed connections offer no action button; the disconnect
            // endpoint 409s for them, so we render a badge instead of a control.
            let affordance: React.ReactNode = null
            if (row.action !== 'none') {
              if (confirmingDisconnect === id) {
                affordance = (
                  <>
                    <button
                      onClick={() => {
                        void disconnect(id)
                      }}
                      style={{ color: 'var(--theme-error-500)' }}
                      type="button"
                    >
                      Confirm disconnect
                    </button>
                    <button onClick={() => setConfirmingDisconnect(undefined)} type="button">
                      Cancel
                    </button>
                  </>
                )
              } else {
                affordance = (
                  <button
                    disabled={isPending}
                    onClick={() => {
                      if (row.action === 'disconnect') {
                        setConfirmingDisconnect(id)
                      } else {
                        void connect(id)
                      }
                    }}
                    type="button"
                  >
                    {connectionButtonLabel(row.action, isPending)}
                  </button>
                )
              }
            }

            return (
              <li key={id} style={styles.row}>
                <span
                  aria-hidden="true"
                  style={{
                    ...styles.dot,
                    backgroundColor: row.connected
                      ? 'var(--theme-success-500)'
                      : 'var(--theme-elevation-300)',
                  }}
                />
                <span style={{ flex: 1 }}>
                  <strong>{PLATFORM_LABELS[id]}</strong>
                  <small style={{ ...styles.muted, display: 'block' }}>{row.statusText}</small>
                </span>
                {row.showManagedBadge ? (
                  <span style={styles.badge}>Managed by server configuration</span>
                ) : null}
                {affordance}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  badge: {
    backgroundColor: 'var(--theme-elevation-100)',
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 4,
    color: 'var(--theme-elevation-600)',
    fontSize: '0.7rem',
    padding: '0.15rem 0.45rem',
    whiteSpace: 'nowrap',
  },
  container: {
    backgroundColor: 'var(--theme-elevation-50)',
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 6,
    marginBlock: '1rem',
    padding: '1rem',
  },
  dot: { borderRadius: '50%', display: 'inline-block', height: 8, width: 8 },
  list: { display: 'grid', gap: '0.5rem', listStyle: 'none', padding: 0 },
  muted: { color: 'var(--theme-elevation-500)', marginTop: 0 },
  row: { alignItems: 'center', display: 'flex', gap: '0.75rem', paddingBlock: '0.35rem' },
}
