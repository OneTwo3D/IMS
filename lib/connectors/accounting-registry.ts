export type AccountingConnectorId = 'xero' | 'quickbooks'

export type AccountingConnectorDef = {
  id: AccountingConnectorId
  label: string
  available: boolean
}

export const ACCOUNTING_CONNECTORS: readonly AccountingConnectorDef[] = [
  {
    id: 'xero',
    label: 'Xero',
    available: true,
  },
  {
    id: 'quickbooks',
    label: 'QuickBooks',
    available: false,
  },
] as const

export function getAccountingConnector(id: AccountingConnectorId): AccountingConnectorDef {
  const def = ACCOUNTING_CONNECTORS.find((connector) => connector.id === id)
  if (!def) throw new Error(`Unknown accounting connector: ${id}`)
  return def
}
