'use client'

import { useConfig } from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

import type { ConnectionState } from '../types/index.js'

import { PLATFORM_IDS, PLATFORM_LABELS, type PlatformId } from '../constants.js'

type Props = {
  enabledPlatforms?: string[]
}

type ConnectionMap = Partial<Record<PlatformId, ConnectionState>>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

export const SocialsDashboardWidget: React.FC<Props> = ({ enabledPlatforms }) => {
  const { config } = useConfig()
  const socials = asRecord(asRecord(config.custom)?.socials)
  const configuredPlatforms = Array.isArray(socials?.enabledPlatforms)
    ? socials.enabledPlatforms.filter((value): value is string => typeof value === 'string')
    : []
  const enabled = new Set(enabledPlatforms ?? configuredPlatforms)
  const apiRoute = typeof config.routes?.api === 'string' ? config.routes.api : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  const endpointBase = `${apiRoute.replace(/\/$/, '')}${basePath}`

  const [connections, setConnections] = useState<ConnectionMap>({})
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PlatformId>()

  const loadConnections = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`${endpointBase}/connections`)
      const body = (await response.json()) as { connections?: ConnectionMap; error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`)
      }
      setConnections(body.connections ?? {})
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [endpointBase])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const connect = async (platform: PlatformId): Promise<void> => {
    setPending(platform)
    setError(undefined)
    try {
      const response = await fetch(`${endpointBase}/${platform}/oauth/start`, { method: 'POST' })
      const body = (await response.json()) as { error?: string; url?: string }
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? `Could not start ${PLATFORM_LABELS[platform]} OAuth`)
      }
      window.location.assign(body.url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setPending(undefined)
    }
  }

  const disconnect = async (platform: PlatformId): Promise<void> => {
    if (!window.confirm(`Disconnect ${PLATFORM_LABELS[platform]}?`)) {
      return
    }
    setPending(platform)
    setError(undefined)
    try {
      const response = await fetch(`${endpointBase}/${platform}/disconnect`, { method: 'POST' })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `Disconnect failed (${response.status})`)
      }
      await loadConnections()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
      {loading ? (
        <p style={styles.muted}>Loading connection status…</p>
      ) : enabled.size === 0 ? (
        <p style={styles.muted}>No platforms are enabled.</p>
      ) : (
        <ul style={styles.list}>
          {PLATFORM_IDS.filter((id) => enabled.has(id)).map((id) => {
            const state = connections[id]
            const connected = state?.connected === true
            return (
              <li key={id} style={styles.row}>
                <span
                  aria-hidden="true"
                  style={{
                    ...styles.dot,
                    backgroundColor: connected
                      ? 'var(--theme-success-500)'
                      : 'var(--theme-elevation-300)',
                  }}
                />
                <span style={{ flex: 1 }}>
                  <strong>{PLATFORM_LABELS[id]}</strong>
                  <small style={{ ...styles.muted, display: 'block' }}>
                    {connected
                      ? (state.accountLabel ?? 'Connected')
                      : (state?.lastError ?? 'Not connected')}
                  </small>
                </span>
                <button
                  disabled={pending === id || state?.managedByConfig === true}
                  onClick={() => {
                    void (connected ? disconnect(id) : connect(id))
                  }}
                  type="button"
                >
                  {pending === id
                    ? 'Working…'
                    : state?.managedByConfig
                      ? 'Configured'
                      : connected
                        ? 'Disconnect'
                        : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: 'var(--theme-elevation-50)',
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 6,
    marginBlock: '1rem',
    padding: '1rem',
  },
  dot: { borderRadius: '50%', display: 'inline-block', height: 8, width: 8 },
  error: { color: 'var(--theme-error-500)' },
  list: { display: 'grid', gap: '0.5rem', listStyle: 'none', padding: 0 },
  muted: { color: 'var(--theme-elevation-500)', marginTop: 0 },
  row: { alignItems: 'center', display: 'flex', gap: '0.75rem', paddingBlock: '0.35rem' },
}
