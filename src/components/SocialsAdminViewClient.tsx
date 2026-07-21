'use client'

import { toast } from '@payloadcms/ui'
import React, { useEffect, useState } from 'react'

import { SocialPublishPanelClient } from './ProductSocialsPanelClient.js'
import { SocialsDashboardWidget } from './SocialsDashboardWidget.js'
import './SocialPublishPanelClient.scss'

type Props = {
  enabledPlatforms?: string[]
}

type Tab = 'compose' | 'connections'

/**
 * Two-tab client layout for the /admin/socials route:
 * - Compose: the standalone multi-channel composer
 * - Connections: the existing connection health widget
 */
export const SocialsAdminViewClient: React.FC<Props> = ({ enabledPlatforms }) => {
  const [activeTab, setActiveTab] = useState<Tab>('compose')

  // Consume the one-shot OAuth callback marker without replaying it on reload.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    if (!connected) {
      return
    }
    setActiveTab('connections')
    // Capitalise the first letter for a friendlier toast message.
    const label = connected.charAt(0).toUpperCase() + connected.slice(1)
    toast.success(`${label} connected`)
    // Remove the ?connected param without adding a new history entry.
    params.delete('connected')
    const newSearch = params.toString()
    const newUrl = newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname
    window.history.replaceState(null, '', newUrl)
  }, [])

  return (
    <div>
      <div aria-label="Socials view" className="socials-admin__tabs" role="tablist">
        <button
          aria-selected={activeTab === 'compose'}
          onClick={() => setActiveTab('compose')}
          role="tab"
          type="button"
        >
          Compose
        </button>
        <button
          aria-selected={activeTab === 'connections'}
          onClick={() => setActiveTab('connections')}
          role="tab"
          type="button"
        >
          Connections
        </button>
      </div>

      <div role="tabpanel">
        {activeTab === 'compose' && <SocialPublishPanelClient mode="standalone" />}
        {activeTab === 'connections' && (
          <SocialsDashboardWidget enabledPlatforms={enabledPlatforms} />
        )}
      </div>
    </div>
  )
}
