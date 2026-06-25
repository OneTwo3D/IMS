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
    logo: (
      <div className="flex h-8 items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-100 text-xs font-bold text-amber-700">
          MS
        </div>
        <span className="text-base font-semibold tracking-tight">Mintsoft</span>
      </div>
    ),
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
