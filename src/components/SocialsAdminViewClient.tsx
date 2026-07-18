'use client'

import React, { useState } from 'react'

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
