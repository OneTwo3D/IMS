/**
 * Generic accounting facade — core code imports ONLY from here, never from connector modules.
 * Today it resolves the active connector to Xero, but the app-facing contract
 * remains connector-agnostic.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export type AccountingSettings = {
  syncEnabled: boolean
  salesAccount: string
  shippingAccount: string
  discountAccount: string
  cogsAccount: string
  inventoryAccount: string
  allocatedInventoryAccount: string
  unearnedRevenueAccount: string
  transitAccount: string
  paymentAccountMap: string
  invoiceUrlTemplate: string
  billUrlTemplate: string
}

type AccountingConnectorInfo = {
  id: 'xero'
  name: 'Xero'
}

const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  syncEnabled: false,
  salesAccount: '',
  shippingAccount: '',
  discountAccount: '',
  cogsAccount: '',
  inventoryAccount: '',
  allocatedInventoryAccount: '',
  unearnedRevenueAccount: '',
  transitAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
}

async function getActiveAccountingConnectorId(): Promise<AccountingConnectorInfo['id'] | null> {
  return (await isIntegrationPluginEnabled('xero')) ? 'xero' : null
}

export async function getActiveAccountingConnectorInfo(): Promise<AccountingConnectorInfo | null> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return null
  return { id: connector, name: 'Xero' }
}

export async function queueAccountingSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<void> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return

  switch (connector) {
    case 'xero': {
      const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
      return queueXeroSync(params)
    }
  }
}

export async function getAccountingSettings(): Promise<AccountingSettings> {
  // Read connector-agnostic settings directly from the core settings table.
  const { db } = await import('@/lib/db')
  const [invoiceUrlSetting, billUrlSetting, paymentMapSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'accounting_invoice_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_bill_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_payment_account_map' } }),
  ])

  const connector = await getActiveAccountingConnectorId()
  if (!connector) {
    return {
      ...DEFAULT_ACCOUNTING_SETTINGS,
      paymentAccountMap: paymentMapSetting?.value ?? '{}',
      invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
      billUrlTemplate: billUrlSetting?.value ?? '',
    }
  }

  switch (connector) {
    case 'xero': {
      const { getXeroSettings } = await import('@/lib/connectors/xero/settings')
      const xs = await getXeroSettings()
      return {
        syncEnabled: xs.xero_sync_enabled === 'true',
        salesAccount: xs.xero_sales_account,
        shippingAccount: xs.xero_shipping_account,
        discountAccount: xs.xero_discount_account,
        cogsAccount: xs.xero_cogs_account,
        inventoryAccount: xs.xero_inventory_account,
        allocatedInventoryAccount: xs.xero_allocated_inventory_account,
        unearnedRevenueAccount: xs.xero_unearned_revenue_account,
        transitAccount: xs.xero_transit_account,
        paymentAccountMap: paymentMapSetting?.value ?? '{}',
        invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
        billUrlTemplate: billUrlSetting?.value ?? '',
      }
    }
  }
}

/**
 * Fetch just the payment account map JSON. Used by connector sync processors
 * so they don't have to re-fetch all accounting settings.
 */
export async function getPaymentAccountMap(): Promise<string> {
  const { db } = await import('@/lib/db')
  const row = await db.setting.findUnique({ where: { key: 'accounting_payment_account_map' } })
  return row?.value ?? '{}'
}

export function lookupPaymentAccount(
  mapJson: string,
  method: string,
  currency: string,
): string | null {
  try {
    const map = JSON.parse(mapJson) as Record<string, string>
    const exact = map[`${method}:${currency}`]
    if (exact) return exact
    const wildcard = map[`${method}:*`]
    if (wildcard) return wildcard
    return null
  } catch {
    return null
  }
}

export type AccountCode = {
  code: string
  name: string
  type: string
}

/**
 * List all account codes from the active accounting integration.
 * Returns EXPENSE accounts (suitable for stock adjustments, COGS overrides, etc.)
 * plus any other account types that have a code.
 */
export async function listAccountCodes(): Promise<AccountCode[]> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return []

  switch (connector) {
    case 'xero': {
      const { listStoredAccounts } = await import('@/lib/connectors/xero/accounts')
      return listStoredAccounts()
    }
  }
}

export type AccountingBankAccount = {
  id: string       // connector-native account id (Xero AccountID, QuickBooks account id, ...)
  code: string | null
  name: string
}

/**
 * List bank accounts from the active accounting connector. Used by the
 * Pay Bill dialog and any other "select a bank account" UI.
 */
export async function listAccountingBankAccounts(): Promise<AccountingBankAccount[]> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return []

  switch (connector) {
    case 'xero': {
      const { listStoredBankAccounts } = await import('@/lib/connectors/xero/accounts')
      return listStoredBankAccounts()
    }
  }
}
