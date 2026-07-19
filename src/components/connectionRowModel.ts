import type { ConnectionState } from '../types/index.js'

/** Affordance a connection row offers. `none` = no button at all. */
export type ConnectionRowAction = 'connect' | 'disconnect' | 'none'

export type ConnectionRowModel = {
  /** The action this row offers. `none` for config-managed connections. */
  action: ConnectionRowAction
  /** True when the adapter currently holds a usable token. */
  connected: boolean
  /** True when credentials come from immutable host configuration. */
  managed: boolean
  /** True when the "Managed by server configuration" badge should render. */
  showManagedBadge: boolean
  /** Status line shown under the platform name. */
  statusText: string
}

/**
 * Row view-model for a single platform in the connections list.
 *
 * Config-managed connections (system-user tokens supplied via server env) are
 * always shown as connected with a badge and offer NO connect/disconnect
 * action. The disconnect endpoint 409s for managed connections, so the UI must
 * not present an action that always fails.
 */
export const describeConnectionRow = (state: ConnectionState | undefined): ConnectionRowModel => {
  const connected = state?.connected === true
  const managed = state?.managedByConfig === true
  const statusText = connected
    ? (state?.accountLabel ?? 'Connected')
    : (state?.lastError ?? 'Not connected')
  const action: ConnectionRowAction = managed ? 'none' : connected ? 'disconnect' : 'connect'
  return { action, connected, managed, showManagedBadge: managed, statusText }
}

/** Label for the row's action button, accounting for an in-flight request. */
export const connectionButtonLabel = (action: ConnectionRowAction, pending: boolean): string => {
  if (pending) {
    return 'Working…'
  }
  return action === 'disconnect' ? 'Disconnect' : 'Connect'
}
