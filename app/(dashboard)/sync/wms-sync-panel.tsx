'use client'

import { MintsoftClient } from './mintsoft-client'
import type { WmsSyncDashboardData } from '@/app/actions/wms-sync'

/**
 * Connector-agnostic detail panel for the active WMS connector on /sync. This is
 * the WMS panel registry — dispatch to a connector's client below; the sync
 * dashboard stays generic. Adding a connector means a branch here, not edits to
 * sync-dashboard.tsx.
 */

const WMS_PANELS: Record<string, { label: string; logo: React.ReactNode }> = {
  mintsoft: {
    label: 'Mintsoft',
    // eslint-disable-next-line @next/next/no-img-element
    logo: <img src="/images/mintsoft.svg" alt="Mintsoft" className="h-8 object-contain" />,
  },
}

type Props = {
  data: WmsSyncDashboardData
  onBack: () => void
}

export function WmsSyncPanel({ data, onBack }: Props) {
  const panel = WMS_PANELS[data.connectorId]

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        ← Back to Integrations
      </button>
      <div className="flex items-center gap-3 mb-2">
        {panel?.logo}
        <div>
          <h2 className="text-lg font-semibold">{panel?.label ?? data.connectorId} Connector</h2>
          <p className="text-xs text-muted-foreground">Configure the WMS connection, webhook intake, and warehouse bindings.</p>
        </div>
      </div>
      {data.connectorId === 'mintsoft' && data.mintsoft ? <MintsoftClient data={data.mintsoft} /> : null}
    </div>
  )
}
