'use client'

import { useEffect, useState } from 'react'

import type { AccessProbe } from './accessModel.js'

import { parseAccessResponse } from './accessModel.js'

export type AccessState = { loading: boolean } & AccessProbe

const DENIED: AccessState = { admin: false, loading: false, publisher: false }

/**
 * One-shot capability probe against `{endpointBase}/access`. Fails closed: until
 * the response arrives (and on any error) the caller is treated as denied. The
 * request is fired exactly once per `endpointBase` and never surfaces a toast —
 * an unauthorized user must see nothing, not an error.
 */
export const useSocialsAccess = (endpointBase: string): AccessState => {
  const [state, setState] = useState<AccessState>({ admin: false, loading: true, publisher: false })

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`${endpointBase}/access`, { signal: controller.signal })
        const body: unknown = await response.json().catch(() => undefined)
        setState({ ...parseAccessResponse(response.ok, body), loading: false })
      } catch {
        if (!controller.signal.aborted) {
          setState(DENIED)
        }
      }
    })()
    return () => controller.abort()
  }, [endpointBase])

  return state
}
