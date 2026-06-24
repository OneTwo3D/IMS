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
  /**
   * Inventory-revaluation P&L account (audit-o3yb). Offsets retrospective COGS
   * corrections on goods ALREADY SOLD (consumed qty) — e.g. a freight-PO
   * cancellation or freight-cost change after dispatch. On-hand stock revaluation
   * stays on inventory/transit; the consumed portion lands here so the clearing
   * (transit) account doesn't accumulate balances that never reconcile to stock.
   * Empty falls back to transitAccount (prior behaviour) until configured.
   */
  inventoryRevaluationAccount: string
  inventoryAccount: string
  allocatedInventoryAccount: string
  unearnedRevenueAccount: string
  transitAccount: string
  accountsReceivableAccount: string
  accountsPayableAccount: string
  realisedFxGainLossAccount: string
  unrealisedFxGainLossAccount: string
  manufacturingOverheadAccount: string
  paymentAccountMap: string
  invoiceUrlTemplate: string
  billUrlTemplate: string
  /**
   * Connector-specific accounting tax type code applied to invoice lines whose
   * resolved TaxRate has reverseCharge=true. Empty string disables the swap
   * (the original accountingTaxType is sent through). Typical Xero value:
   * ECOUTPUTSERVICES for B2B services to EU customers post-Brexit.
   */
  reverseChargeSalesTaxType: string
  /** Same as reverseChargeSalesTaxType but applied to bills (ACCPAY). Typical
   *  Xero value: REVERSECHARGES for EU services purchased into the UK. */
  reverseChargePurchaseTaxType: string
}

type AccountingConnectorInfo = {
  id: 'xero' | 'quickbooks'
  name: 'Xero' | 'QuickBooks'
}

const XERO_SYNC_TYPE_SETTING: Partial<Record<AccountingSyncType, string>> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  SALES_INVOICE_UPDATE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  PURCHASE_CREDIT_NOTE: 'xero_sync_purchase_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  PURCHASE_INVOICE_UPDATE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'xero_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'xero_sync_realised_fx_journal',
  UNREALISED_FX_JOURNAL: 'xero_sync_unrealised_fx_journal',
  MANUFACTURING_JOURNAL: 'xero_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'xero_sync_manufacturing_journal',
  TAX_RATE_SYNC: 'xero_sync_tax_rate',
}

const QUICKBOOKS_SYNC_TYPE_SETTING: Partial<Record<AccountingSyncType, string>> = {
  SALES_INVOICE: 'quickbooks_sync_sales_invoice',
  SALES_INVOICE_UPDATE: 'quickbooks_sync_sales_invoice',
  CREDIT_NOTE: 'quickbooks_sync_credit_note',
  PURCHASE_INVOICE: 'quickbooks_sync_purchase_invoice',
  PURCHASE_INVOICE_UPDATE: 'quickbooks_sync_purchase_invoice',
  COGS_JOURNAL: 'quickbooks_sync_cogs_journal',
  COGS_REVERSAL: 'quickbooks_sync_cogs_reversal',
  STOCK_RECEIPT: 'quickbooks_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'quickbooks_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'quickbooks_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'quickbooks_sync_realised_fx_journal',
  UNREALISED_FX_JOURNAL: 'quickbooks_sync_unrealised_fx_journal',
  MANUFACTURING_JOURNAL: 'quickbooks_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'quickbooks_sync_manufacturing_journal',
}

const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  syncEnabled: false,
  salesAccount: '',
  shippingAccount: '',
  discountAccount: '',
  cogsAccount: '',
  inventoryRevaluationAccount: '',
  inventoryAccount: '',
  allocatedInventoryAccount: '',
  unearnedRevenueAccount: '',
  transitAccount: '',
  accountsReceivableAccount: '',
  accountsPayableAccount: '',
  realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '',
  manufacturingOverheadAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
  reverseChargeSalesTaxType: '',
  reverseChargePurchaseTaxType: '',
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

/**
 * Whether the daily batch will actually post shipment COGS for the active
 * connector — i.e. the connector is active, its sync is enabled, AND its daily
 * batch is enabled. Used to decide whether an un-journaled shipment's COGS
 * revaluation will reach the ledger via the batch, or whether the landed-cost
 * COGS journal must still carry it (audit-gbzh). Mirrors the gate in
 * app/api/cron/accounting-daily-batch/route.ts.
 */
export async function isDailyBatchPostingEnabled(): Promise<boolean> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return false
  if (connector === 'xero') {
    const { getXeroSettings } = await import('@/lib/connectors/xero/settings')
    const settings = await getXeroSettings()
    return settings.xero_sync_enabled === 'true' && settings.xero_daily_batch_enabled === 'true'
  }
  const { getQuickBooksSettings } = await import('@/lib/connectors/quickbooks/settings')
  const settings = await getQuickBooksSettings()
  return settings.quickbooks_sync_enabled === 'true' && settings.quickbooks_daily_batch_enabled === 'true'
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
): Promise<boolean> {
  // Returns whether a GL counterpart for this posting exists or will post: false when
  // the type won't post (no active/enabled connector), true when it was queued or is
  // already queued. Callers that must stay consistent with the queue decision (e.g. the
  // COGS subledger ledger writes, bcz9.2/bcz9.4) should record based on THIS result, not
  // a separate settings recheck — avoiding a TOCTOU if the connector/setting flips.
  const context = await getAccountingPostingContext(params.type)
  if (!context) return false

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
    if (existing) return true
  }

  try {
    const [{ getBaseCurrencyCode }, { mirrorAccountingSyncLogToEvent }] = await Promise.all([
      import('@/lib/base-currency'),
      import('@/lib/domain/accounting/accounting-event-mirror'),
    ])
    const baseCurrency = await getBaseCurrencyCode()
    const log = await tx.accountingSyncLog.create({
      data: {
        connector: context.connector,
        type: params.type,
        status: 'PENDING',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        payload: payload as never,
      },
    })
    if (context.connector === 'xero') {
      const { scheduleXeroAccountingOutbox } = await import('@/lib/connectors/xero/outbox')
      await scheduleXeroAccountingOutbox(tx, {
        accountingSyncLogId: log.id,
      })
    }
    await mirrorAccountingSyncLogToEvent(tx, {
      syncLogId: log.id,
      connector: context.connector,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload,
      currency: baseCurrency,
      status: 'PENDING',
    }).catch((mirrorError: unknown) => tx.activityLog.create({
      data: {
        entityType: 'SYSTEM',
        action: 'accounting_event_mirror_error',
        tag: 'sync',
        level: 'WARNING',
        description: `Accounting sync entry ${log.id} was queued but accounting event mirroring failed: ${String(mirrorError)}`,
      },
    }).then(() => undefined))
    return true
  } catch (error) {
    // A unique-key collision means a concurrent insert already queued this posting,
    // so the GL counterpart exists — treat as queued.
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) return true
    throw error
  }
}

export async function getAccountingSettings(): Promise<AccountingSettings> {
  // Read connector-agnostic settings directly from the core settings table.
  const { db } = await import('@/lib/db')
  const [invoiceUrlSetting, billUrlSetting, paymentMapSetting, reverseChargeSalesSetting, reverseChargePurchaseSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'accounting_invoice_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_bill_url_template' } }),
    db.setting.findUnique({ where: { key: 'accounting_payment_account_map' } }),
    db.setting.findUnique({ where: { key: 'accounting_reverse_charge_sales_tax_type' } }),
    db.setting.findUnique({ where: { key: 'accounting_reverse_charge_purchase_tax_type' } }),
  ])
  const reverseChargeSalesTaxType = reverseChargeSalesSetting?.value?.trim() ?? ''
  const reverseChargePurchaseTaxType = reverseChargePurchaseSetting?.value?.trim() ?? ''

  const connector = await getActiveAccountingConnectorId()
  if (!connector) {
    return {
      ...DEFAULT_ACCOUNTING_SETTINGS,
      paymentAccountMap: paymentMapSetting?.value ?? '{}',
      invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
      billUrlTemplate: billUrlSetting?.value ?? '',
      reverseChargeSalesTaxType,
      reverseChargePurchaseTaxType,
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
        inventoryRevaluationAccount: xs.xero_inventory_revaluation_account,
        inventoryAccount: xs.xero_inventory_account,
        allocatedInventoryAccount: xs.xero_allocated_inventory_account,
        unearnedRevenueAccount: xs.xero_unearned_revenue_account,
        transitAccount: xs.xero_transit_account,
        accountsReceivableAccount: xs.xero_accounts_receivable_account,
        accountsPayableAccount: xs.xero_accounts_payable_account,
        realisedFxGainLossAccount: xs.xero_realised_fx_gain_loss_account,
        unrealisedFxGainLossAccount: xs.xero_unrealised_fx_gain_loss_account,
        manufacturingOverheadAccount: xs.xero_manufacturing_overhead_account,
        paymentAccountMap: paymentMapSetting?.value ?? '{}',
        invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
        billUrlTemplate: billUrlSetting?.value ?? '',
        reverseChargeSalesTaxType,
        reverseChargePurchaseTaxType,
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
        // QuickBooks out of scope for audit-o3yb — empty falls back to transit.
        inventoryRevaluationAccount: '',
        inventoryAccount: qs.quickbooks_inventory_account,
        allocatedInventoryAccount: qs.quickbooks_allocated_inventory_account,
        unearnedRevenueAccount: qs.quickbooks_unearned_revenue_account,
        transitAccount: qs.quickbooks_transit_account,
        accountsReceivableAccount: qs.quickbooks_accounts_receivable_account,
        accountsPayableAccount: qs.quickbooks_accounts_payable_account,
        realisedFxGainLossAccount: qs.quickbooks_realised_fx_gain_loss_account,
        unrealisedFxGainLossAccount: qs.quickbooks_unrealised_fx_gain_loss_account,
        manufacturingOverheadAccount: qs.quickbooks_manufacturing_overhead_account,
        paymentAccountMap: paymentMapSetting?.value ?? '{}',
        invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
        billUrlTemplate: billUrlSetting?.value ?? '',
        reverseChargeSalesTaxType,
        reverseChargePurchaseTaxType,
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
