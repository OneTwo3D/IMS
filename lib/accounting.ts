/**
 * Generic accounting facade — core code imports ONLY from here, never from connector modules.
 */

import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
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
  accountsReceivableAccount: string
  accountsPayableAccount: string
  realisedFxGainLossAccount: string
  manufacturingOverheadAccount: string
  paymentAccountMap: string
  invoiceUrlTemplate: string
  billUrlTemplate: string
}

type AccountingConnectorInfo = {
  id: 'xero' | 'quickbooks'
  name: 'Xero' | 'QuickBooks'
}

const XERO_SYNC_TYPE_SETTING: Partial<Record<AccountingSyncType, string>> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'xero_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'xero_sync_realised_fx_journal',
  MANUFACTURING_JOURNAL: 'xero_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'xero_sync_manufacturing_journal',
}

const QUICKBOOKS_SYNC_TYPE_SETTING: Partial<Record<AccountingSyncType, string>> = {
  SALES_INVOICE: 'quickbooks_sync_sales_invoice',
  CREDIT_NOTE: 'quickbooks_sync_credit_note',
  PURCHASE_INVOICE: 'quickbooks_sync_purchase_invoice',
  COGS_JOURNAL: 'quickbooks_sync_cogs_journal',
  COGS_REVERSAL: 'quickbooks_sync_cogs_reversal',
  STOCK_RECEIPT: 'quickbooks_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'quickbooks_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'quickbooks_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'quickbooks_sync_realised_fx_journal',
  MANUFACTURING_JOURNAL: 'quickbooks_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'quickbooks_sync_manufacturing_journal',
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
  accountsReceivableAccount: '',
  accountsPayableAccount: '',
  realisedFxGainLossAccount: '',
  manufacturingOverheadAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
}

async function getActiveAccountingConnectorId(): Promise<AccountingConnectorInfo['id'] | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

export async function getActiveAccountingConnectorInfo(): Promise<AccountingConnectorInfo | null> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return null
  return {
    id: connector,
    name: connector === 'xero' ? 'Xero' : 'QuickBooks',
  }
}

export async function queueAccountingSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}): Promise<void> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return

  switch (connector) {
    case 'xero': {
      const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
      return queueXeroSync(params)
    }
    case 'quickbooks': {
      const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')
      return queueQuickBooksSync(params)
    }
  }
}

async function getAccountingPostingContext(type: AccountingSyncType): Promise<{
  connector: AccountingConnectorInfo['id']
  postingMode: string
} | null> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return null

  if (connector === 'xero') {
    const { getXeroSettings } = await import('@/lib/connectors/xero/settings')
    const settings = await getXeroSettings()
    if (settings.xero_sync_enabled !== 'true') return null
    const settingKey = XERO_SYNC_TYPE_SETTING[type]
    const postingMode = settingKey ? String(settings[settingKey as keyof typeof settings] ?? '') : 'submitted'
    if (!postingMode || postingMode === 'off') return null
    return { connector, postingMode }
  }

  const { getQuickBooksSettings } = await import('@/lib/connectors/quickbooks/settings')
  const settings = await getQuickBooksSettings()
  if (settings.quickbooks_sync_enabled !== 'true') return null
  const settingKey = QUICKBOOKS_SYNC_TYPE_SETTING[type]
  const postingMode = settingKey ? String(settings[settingKey as keyof typeof settings] ?? '') : 'submitted'
  if (!postingMode || postingMode === 'off') return null
  return { connector, postingMode }
}

export async function isAccountingSyncTypeEnabled(type: AccountingSyncType): Promise<boolean> {
  return (await getAccountingPostingContext(type)) !== null
}

export async function queueAccountingSyncTx(
  tx: Prisma.TransactionClient,
  params: {
    type: AccountingSyncType
    referenceType: string
    referenceId: string
    payload: Record<string, unknown>
    idempotencyKey?: string
  },
): Promise<void> {
  const context = await getAccountingPostingContext(params.type)
  if (!context) return

  const payload = {
    ...params.payload,
    _postingMode: context.postingMode,
    ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}),
  }

  if (params.idempotencyKey) {
    const existing = await tx.accountingSyncLog.findFirst({
      where: {
        connector: context.connector,
        type: params.type,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
        payload: { path: ['_idempotencyKey'], equals: params.idempotencyKey },
      },
      select: { id: true },
    })
    if (existing) return
  }

  try {
    await tx.accountingSyncLog.create({
      data: {
        connector: context.connector,
        type: params.type,
        status: 'PENDING',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        payload: payload as never,
      },
    })
  } catch (error) {
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) return
    throw error
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
        accountsReceivableAccount: xs.xero_accounts_receivable_account,
        accountsPayableAccount: xs.xero_accounts_payable_account,
        realisedFxGainLossAccount: xs.xero_realised_fx_gain_loss_account,
        manufacturingOverheadAccount: xs.xero_manufacturing_overhead_account,
        paymentAccountMap: paymentMapSetting?.value ?? '{}',
        invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
        billUrlTemplate: billUrlSetting?.value ?? '',
      }
    }
    case 'quickbooks': {
      const { getQuickBooksSettings } = await import('@/lib/connectors/quickbooks/settings')
      const qs = await getQuickBooksSettings()
      return {
        syncEnabled: qs.quickbooks_sync_enabled === 'true',
        salesAccount: qs.quickbooks_sales_account,
        shippingAccount: qs.quickbooks_shipping_account,
        discountAccount: qs.quickbooks_discount_account,
        cogsAccount: qs.quickbooks_cogs_account,
        inventoryAccount: qs.quickbooks_inventory_account,
        allocatedInventoryAccount: qs.quickbooks_allocated_inventory_account,
        unearnedRevenueAccount: qs.quickbooks_unearned_revenue_account,
        transitAccount: qs.quickbooks_transit_account,
        accountsReceivableAccount: qs.quickbooks_accounts_receivable_account,
        accountsPayableAccount: qs.quickbooks_accounts_payable_account,
        realisedFxGainLossAccount: qs.quickbooks_realised_fx_gain_loss_account,
        manufacturingOverheadAccount: qs.quickbooks_manufacturing_overhead_account,
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
    case 'quickbooks': {
      const { listStoredAccounts } = await import('@/lib/connectors/quickbooks/accounts')
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
    case 'quickbooks': {
      const { listStoredBankAccounts } = await import('@/lib/connectors/quickbooks/accounts')
      return listStoredBankAccounts()
    }
  }
}
