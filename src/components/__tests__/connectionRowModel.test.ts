import { describe, expect, it } from 'vitest'

import type { ConnectionState } from '../../types/index.js'

import { connectionButtonLabel, describeConnectionRow } from '../connectionRowModel.js'

describe('describeConnectionRow', () => {
  it('treats an undefined state as a disconnected, connectable row', () => {
    expect(describeConnectionRow(undefined)).toEqual({
      action: 'connect',
      connected: false,
      managed: false,
      showManagedBadge: false,
      statusText: 'Not connected',
    })
  })

  it('offers disconnect and shows the account label for an OAuth connection', () => {
    const state: ConnectionState = { accountLabel: '@finesgallery', connected: true }
    expect(describeConnectionRow(state)).toEqual({
      action: 'disconnect',
      connected: true,
      managed: false,
      showManagedBadge: false,
      statusText: '@finesgallery',
    })
  })

  it('falls back to a generic connected label when no account label is present', () => {
    expect(describeConnectionRow({ connected: true }).statusText).toBe('Connected')
  })

  it('surfaces the last error when not connected', () => {
    const state: ConnectionState = { connected: false, lastError: 'Token expired' }
    expect(describeConnectionRow(state)).toMatchObject({
      action: 'connect',
      statusText: 'Token expired',
    })
  })

  it('renders a config-managed connection as connected with a badge and no action', () => {
    const state: ConnectionState = {
      accountLabel: 'Meta system user',
      connected: true,
      managedByConfig: true,
    }
    expect(describeConnectionRow(state)).toEqual({
      action: 'none',
      connected: true,
      managed: true,
      showManagedBadge: true,
      statusText: 'Meta system user',
    })
  })

  it('never offers an action for a managed connection even if reported disconnected', () => {
    const state: ConnectionState = { connected: false, managedByConfig: true }
    const row = describeConnectionRow(state)
    expect(row.action).toBe('none')
    expect(row.showManagedBadge).toBe(true)
  })
})

describe('connectionButtonLabel', () => {
  it('shows a working label while a request is in flight', () => {
    expect(connectionButtonLabel('connect', true)).toBe('Working…')
    expect(connectionButtonLabel('disconnect', true)).toBe('Working…')
  })

  it('labels the connect and disconnect actions when idle', () => {
    expect(connectionButtonLabel('connect', false)).toBe('Connect')
    expect(connectionButtonLabel('disconnect', false)).toBe('Disconnect')
  })
})
