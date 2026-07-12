'use client'

import type { ReactNode, ComponentType } from 'react'
import { XeroClient, type AccountingConnectorClientProps } from './xero-client'

export type AccountingConnectorUiId = 'xero' | 'quickbooks'

type AccountingConnectorUi = {
  title: string
  subtitle: string
  Client: ComponentType<AccountingConnectorClientProps>
}

// Connector-owned UI registry: maps an accounting connector to its header copy
// and the client component that renders its settings/sync surface. The shared
// dashboard mounts accounting connectors through this generic panel instead of
// importing a connector-specific component directly. QuickBooks currently reuses
// the shared accounting client until it gets a dedicated one.
const ACCOUNTING_CONNECTOR_UI: Record<AccountingConnectorUiId, AccountingConnectorUi> = {
  xero: {
    title: 'Xero Connector',
    subtitle: 'Sync invoices, journals, and bills to Xero',
    Client: XeroClient,
  },
  quickbooks: {
    title: 'QuickBooks Connector',
    subtitle: 'Sync invoices, journals, and bills to QuickBooks',
    Client: XeroClient,
  },
}

export function isAccountingConnectorUiId(id: string | null): id is AccountingConnectorUiId {
  return id === 'xero' || id === 'quickbooks'
}

type Props = {
  connectorId: AccountingConnectorUiId
  logo: ReactNode
  onBack: () => void
  clientProps: AccountingConnectorClientProps
}

export function AccountingConnectorPanel({ connectorId, logo, onBack, clientProps }: Props) {
  const ui = ACCOUNTING_CONNECTOR_UI[connectorId]
  const Client = ui.Client
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
        ← Back to Integrations
      </button>
      <div className="flex items-center gap-3 mb-2">
        {logo}
        <div>
          <h2 className="text-lg font-semibold">{ui.title}</h2>
          <p className="text-xs text-muted-foreground">{ui.subtitle}</p>
        </div>
      </div>
      <Client {...clientProps} />
    </div>
  )
}
