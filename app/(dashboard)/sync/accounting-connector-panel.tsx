'use client'

import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'
import type { ReactNode, ComponentType } from 'react'
import { XeroClient, type AccountingConnectorClientProps } from './xero-client'

// o3d-remove-parked-connectors: a FIFTH spelling of the accounting id union, in the UI. Aliased to
// the registry's so a registered connector cannot be missing a panel id by omission.
export type AccountingConnectorUiId = AccountingConnectorId

type AccountingConnectorUi = {
  title: string
  subtitle: string
  Client: ComponentType<AccountingConnectorClientProps>
}

// Connector-owned UI registry: maps an accounting connector to its header copy
// and the client component that renders its settings/sync surface. The shared
// dashboard mounts accounting connectors through this generic panel instead of
// importing a connector-specific component directly.
//
// TOTAL over the id union (`Record`, not `Partial<Record>`), so a registered accounting connector
// with no panel is a `tsc` error rather than a blank screen under a header naming it — the
// o3d-remove-shiphero round 6 lesson, applied here. One entry ships today: QuickBooks was the second
// and is archived (o3d-remove-parked-connectors); it reused `XeroClient` wholesale, which is worth
// knowing before the next connector assumes the panel is generic — it is the SLOT that is generic,
// not the component.
const ACCOUNTING_CONNECTOR_UI: Record<AccountingConnectorUiId, AccountingConnectorUi> = {
  xero: {
    title: 'Xero Connector',
    subtitle: 'Sync invoices, journals, and bills to Xero',
    Client: XeroClient,
  },
}

// DERIVED from the panel map (o3d-remove-parked-connectors), which is itself total over the id union.
// It was `id === 'xero' || id === 'quickbooks'` — a hand-written pair that could accept an id with no
// panel, or reject one that had a panel, without either being a compile error.
export function isAccountingConnectorUiId(id: string | null): id is AccountingConnectorUiId {
  return id !== null && Object.prototype.hasOwnProperty.call(ACCOUNTING_CONNECTOR_UI, id)
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
