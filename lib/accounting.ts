/**
 * Generic accounting facade — core code imports ONLY from here, never from connector modules.
 */

import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { resolveAccountingEnqueueOrderScope } from '@/lib/domain/accounting/enqueue-order-guard'
import { hasLockedSalesOrder } from '@/lib/domain/sales/allocation-service'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'

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

/**
 * Generic selector for whether an accounting connector has stored OAuth
 * credentials (i.e. is connected). Wraps the AccountingToken store so
 * non-connector ingress code (e.g. the sync cron) does not read connector
 * persistence directly — if token storage changes, only this helper changes.
 */
export async function isAccountingConnectorConnected(
  connector: AccountingConnectorInfo['id'],
): Promise<boolean> {
  const { db } = await import('@/lib/db')
  const token = await db.accountingToken.findFirst({ where: { connector }, select: { id: true } })
  return token !== null
}

/**
 * Xero auto-posts realised currency gains/losses (and revalues unrealised FX)
 * itself when a foreign invoice/bill settles, against its own system currency
 * gain/loss accounts. An IMS-generated manual journal for the same movement
 * targets the AR/AP CONTROL account (accountsReceivable 610 / accountsPayable
 * 800), which Xero (a) REJECTS — manual-journal lines cannot post to system
 * accounts, so the sync log stalls FAILED — and (b) would double-count against
 * Xero's own posting. So FX gain/loss journals are suppressed for the Xero
 * connector at the single queue chokepoint every enqueue site routes through
 * (realised: sales.ts / purchase-orders.ts on payment; unrealised:
 * accounting-fx-revaluation.ts at period end). QuickBooks is unaffected — its
 * AP/AR manual-journal rules differ; revisit per o3d-lgo.6.1 if QBO is verified.
 */
const FX_GAIN_LOSS_JOURNAL_TYPES: ReadonlySet<AccountingSyncType> = new Set([
  'REALISED_FX_JOURNAL',
  'UNREALISED_FX_JOURNAL',
])

export function isFxGainLossJournalSuppressed(
  connector: AccountingConnectorInfo['id'],
  type: AccountingSyncType,
): boolean {
  return connector === 'xero' && FX_GAIN_LOSS_JOURNAL_TYPES.has(type)
}

/**
 * WHAT AN ENQUEUE ACTUALLY DID (o3d-2sm1 r7, Codex HIGH).
 *
 * `queueAccountingSync` returned `void`, and it returns early — writing nothing — on at least five
 * paths: no active connector, the connector's sync switched off, this type switched off, a type the
 * connector posts natively, an order deleted under the enqueue, a payload the enqueue guard found
 * stale. A caller could therefore await it, see it return cleanly, and conclude that a posting was
 * queued when nothing at all had been written. Any caller that DISCHARGES AN OBLIGATION on that
 * conclusion discharges it on a no-op.
 *
 * That is the same defect as a database NULL standing in for an empty list, one layer up: "nothing
 * was written" and "nothing needed writing" were byte-identical, so the absence had nowhere to live.
 * It is given somewhere to live here.
 *
 *   queued: true                    a sync row for this posting is durable — this call wrote it, or
 *                                   it found one already standing (the idempotency-key hit). Either
 *                                   way a GL counterpart exists.
 *   queued: false, not-configured   A DECISION, and the only no-op that may read as settled: there is
 *                                   no connector, or its sync (or this type) is switched off, or the
 *                                   connector posts this type itself. No counterpart will ever exist,
 *                                   so there is nothing outstanding either.
 *   queued: false, refused          NOT a decision. The enqueue declined for a reason about this
 *                                   particular call — the order was deleted under it, its payload was
 *                                   superseded — and the posting is still owed. A caller must not
 *                                   read this as success.
 *
 * `connector` names which connector the answer was given against, so a caller that pinned one for a
 * multi-enqueue hand-off can tell that the setting flipped underneath it.
 */
export type ConnectorEnqueueOutcome = {
  queued: boolean
  reason?: 'not-configured' | 'refused'
}

export type AccountingEnqueueOutcome = ConnectorEnqueueOutcome & {
  connector: AccountingConnectorInfo['id'] | null
}

export async function queueAccountingSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}): Promise<AccountingEnqueueOutcome> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return { queued: false, reason: 'not-configured', connector: null }
  if (isFxGainLossJournalSuppressed(connector, params.type)) {
    return { queued: false, reason: 'not-configured', connector }
  }

  if (connector === 'quickbooks') {
    const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')
    return { ...await queueQuickBooksSync(params), connector }
  }
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  return { ...await queueXeroSync(params), connector }
}

async function getAccountingPostingContext(type: AccountingSyncType): Promise<{
  connector: AccountingConnectorInfo['id']
  postingMode: string
} | null> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return null
  return getAccountingPostingContextFor(connector, type)
}

/**
 * THE SAME VERDICT, FOR A CONNECTOR THE CALLER NAMES (o3d-2sm1 r9, Codex HIGH).
 *
 * Identical to {@link getAccountingPostingContext} except that it does not resolve the active
 * connector: it answers for the one it is given. A caller that has PINNED a connector for a
 * multi-step hand-off cannot use a helper that looks the connector up again — an ABA flip between the
 * pin and the verdict poisons the verdict, and a verdict is what decides whether a later no-op may
 * settle an obligation. This is the same move `queueAccountingSyncTx` made for the enqueue outcome:
 * the answer must name the connector it was given, not the one that happens to be active now.
 *
 * A connector this build does not know is not "enabled by default": it returns null.
 */
async function getAccountingPostingContextFor(connector: string, type: AccountingSyncType): Promise<{
  connector: AccountingConnectorInfo['id']
  postingMode: string
} | null> {
  if (connector === 'xero') {
    const { getXeroSettings } = await import('@/lib/connectors/xero/settings')
    const settings = await getXeroSettings()
    if (settings.xero_sync_enabled !== 'true') return null
    const settingKey = XERO_SYNC_TYPE_SETTING[type]
    const postingMode = settingKey ? String(settings[settingKey as keyof typeof settings] ?? '') : 'submitted'
    if (!postingMode || postingMode === 'off') return null
    return { connector, postingMode }
  }

  if (connector !== 'quickbooks') return null
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

/**
 * Whether this type would post FOR THE NAMED CONNECTOR — o3d-2sm1 r9, Codex HIGH.
 *
 * The explicit-connector variant of {@link isAccountingSyncTypeEnabled}, added rather than
 * substituted: every existing caller of the active-connector form is unaffected and keeps reading it.
 * The one caller that needs this is a hand-off that pinned a connector before asking, and for which a
 * verdict resolved against whatever is active NOW is not an answer about the pinned connector at all.
 */
export async function isAccountingSyncTypeEnabledFor(
  connector: string,
  type: AccountingSyncType,
): Promise<boolean> {
  return (await getAccountingPostingContextFor(connector, type)) !== null
}

export async function queueAccountingSyncTx(
  tx: Prisma.TransactionClient,
  params: {
    type: AccountingSyncType
    referenceType: string
    referenceId: string
    payload: Record<string, unknown>
    idempotencyKey?: string
    /**
     * Acknowledge that this call site CANNOT hoist the sales-order row lock, with the reason
     * (o3d-3zgy). Only for paths where hoisting is structurally impossible today — passing it keeps
     * the o3d-hrak delete race open for that path, so it must be justified and tracked.
     *
     * The default is enforcement: any NEW order-scoped caller that forgets to lock fails loudly
     * rather than silently reopening the race. Grep this name to find every acknowledged gap.
     */
    unlockedOrderScopeReason?: string
    /**
     * REPORT WHAT THIS ENQUEUE ACTUALLY DID, AND WHICH CONNECTOR DID IT (o3d-2sm1 r8, Codex HIGH).
     *
     * The return type stays `boolean` — fourteen call sites read it and none of them change. What a
     * caller that has PINNED a connector for a multi-enqueue hand-off cannot get from that boolean is
     * the one fact it needs: `true` says a row was written and says nothing about which connector it
     * was written for, while this function resolves the active connector for itself, AFTER the pin was
     * taken. So a flip part-way through a hand-off satisfies the caller with work queued against a
     * connector the obligations were never reckoned against.
     *
     * The answer therefore comes out through here rather than through the return value, and it names
     * `context.connector` — THE CONNECTOR THE ROW IS ACTUALLY WRITTEN UNDER, not a second independent
     * resolution — on every path that has resolved one. Optional, so no existing caller pays for it or
     * has to know about it; {@link queueAccountingSyncTxWithOutcome} is the adapter that uses it.
     */
    reportOutcome?: (outcome: AccountingEnqueueOutcome) => void
  },
): Promise<boolean> {
  /**
   * Answer through the out-channel and return the SAME boolean this function has always returned.
   *
   * `connector` is passed explicitly wherever the enqueue has resolved one, so the reported connector
   * is the one the write used. It is resolved here only on the two paths that refuse BEFORE resolving
   * one at all, where nothing was written and so nothing can be misattributed — and only when a
   * reporter is listening, so the unchanged call sites do no extra work.
   */
  const answer = async (
    outcome: ConnectorEnqueueOutcome,
    connector?: AccountingConnectorInfo['id'] | null,
  ): Promise<boolean> => {
    if (params.reportOutcome) {
      params.reportOutcome({
        ...outcome,
        connector: connector === undefined ? await getActiveAccountingConnectorId() : connector,
      })
    }
    return outcome.queued
  }
  // o3d-3zgy: this is the enqueue path that writes inside a CALLER's transaction, so — unlike
  // queueXeroSync / queueQuickBooksSync, which open their own — it cannot take the sales-order row
  // lock itself. Taking it here would take it LATE, inside a transaction that may already hold
  // stock-level locks (cost-layers runs during shipment confirmation), inverting the
  // lockSalesOrder-then-lockStockLevels ordering allocation-service establishes and risking a
  // deadlock against the allocation path. Trading a rare race for a routine hang is not a fix.
  //
  // So the CALLER must hoist the lock, and this asserts they did. See the ordersLockedByTx caveats:
  // it is an in-process check, not a distributed guarantee, and its purpose is to turn a forgotten
  // hoist into a loud failure instead of a silently reopened delete race.
  const orderScope = await resolveAccountingEnqueueOrderScope(tx, params)
  if (orderScope.scope === 'order') {
    if (!hasLockedSalesOrder(tx, orderScope.orderId) && !params.unlockedOrderScopeReason) {
      throw new Error(
        `queueAccountingSyncTx was called for ${params.referenceType} ${params.referenceId} ` +
        `(sales order ${orderScope.orderId}) without that order's row lock. Call ` +
        `lockSalesOrder(tx, orderId) at the START of the enclosing transaction — before any ` +
        `stock-level lock — so the enqueue serialises against a hard delete (o3d-3zgy). If hoisting ` +
        `is structurally impossible here, pass unlockedOrderScopeReason to acknowledge the gap.`,
      )
    }
  } else if (orderScope.scope === 'deleted') {
    // The order went away before this enqueue: writing the sync row would orphan it against a
    // reference nothing can resolve, which is the o3d-hrak race the lock exists to close.
    // REFUSED, not decided: this posting is still owed, and a caller holding an obligation for it
    // must not read this as settled.
    return answer({ queued: false, reason: 'refused' })
  }

  // Returns whether a GL counterpart for this posting exists or will post: false when
  // the type won't post (no active/enabled connector), true when it was queued or is
  // already queued. Callers that must stay consistent with the queue decision (e.g. the
  // COGS subledger ledger writes, bcz9.2/bcz9.4) should record based on THIS result, not
  // a separate settings recheck — avoiding a TOCTOU if the connector/setting flips.
  const context = await getAccountingPostingContext(params.type)
  // A DECISION: there is no connector, or its sync (or this type) is switched off. No counterpart
  // will ever exist for this posting, so nothing is left outstanding.
  if (!context) return answer({ queued: false, reason: 'not-configured' })
  // Xero posts FX gain/loss natively; an IMS journal to the AR/AP control
  // account is rejected + double-counts (see isFxGainLossJournalSuppressed).
  // Return false: no IMS GL counterpart posts, so callers stay consistent.
  if (isFxGainLossJournalSuppressed(context.connector, params.type)) {
    return answer({ queued: false, reason: 'not-configured' }, context.connector)
  }

  // o3d-19gy: the CONNECTION this payload was composed for. Stamped for whichever connector is active,
  // because the defect is not Xero's — every connector resolves ids at enqueue and again at post — but
  // only the Xero processor ENFORCES it today (the QuickBooks half is o3d-8prh). A stamp nothing reads
  // yet still costs nothing and means the evidence exists on the rows written from now on, rather than
  // starting from zero on the day the other half lands.
  const { activeAccountingIdProvenance } = await import('@/lib/connectors/accounting-id-provenance')
  const { stampAccountingPayloadConnection, mintAccountingConnectionProvenanceColumn } = await import('@/lib/connectors/accounting-connection-provenance')
  const payload = stampAccountingPayloadConnection({
    ...params.payload,
    _postingMode: context.postingMode,
    ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}),
  }, await activeAccountingIdProvenance(context.connector))

  // o3d-0m56: serialize this enqueue against the manual retry's read-then-reset for the same
  // document. Without it, a receipt registered here can appear (and fail) between the retry's
  // sibling snapshot and its reset, so the retry revives a row beside a SECOND token it never saw.
  // Money-moving types only — ordinary queue traffic takes no lock.
  await lockFollowUpScope(tx, {
    connector: context.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
  })

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
    if (existing) return answer({ queued: true }, context.connector)
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
        // o3d-dzip: the DURABLE half of the same origin record, minted from the stamp in the
        // payload this statement is writing. Retention compacts the payload to `{}` and keeps the
        // external id, so a stamp that lives only in the payload is missing from exactly the rows
        // whose realm is least knowable. Minted here and nowhere else — see
        // mintAccountingConnectionProvenanceColumn for why this is not a back-fill.
        connectionProvenance: mintAccountingConnectionProvenanceColumn(payload),
        // o3d-0m56 r10: created INSIDE attempt-stamping custody. That is what later lets a revival
        // read this row's unset `remoteAttemptedAt` as proof no remote call ever left it — see
        // money-attempt-provenance.ts. A row created without it is never recycled again.
        ...stampingCustodyOnCreate(),
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
    return answer({ queued: true }, context.connector)
  } catch (error) {
    // A unique-key collision means a concurrent insert already queued this posting,
    // so the GL counterpart exists — treat as queued.
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) {
      return answer({ queued: true }, context.connector)
    }
    throw error
  }
}

/**
 * THE TRANSACTIONAL ENQUEUE, ANSWERING IN FULL (o3d-2sm1 r8, Codex HIGH).
 *
 * WHAT ROUND 7 GOT RIGHT AND WHERE IT STOPPED. r7 pinned the connector and each type's verdict for
 * the whole refund hand-off and checked every FACADE answer against them — the right idea, and it is
 * kept whole. But the in-transaction arm took a bare `true`, which cannot say which connector
 * produced it, while `queueAccountingSyncTx` resolves the active connector for itself AFTER the pin
 * was taken. A flip mid-hand-off therefore satisfied the ledger with work queued against a DIFFERENT
 * connector than the obligations were reckoned against — the same defect the facade arm was hardened
 * against, still open through the one arm that could not see it.
 *
 * AN ADAPTER, NOT A NEW CONTRACT. `queueAccountingSyncTx` returns `boolean` to fourteen call sites,
 * and none of them is asking this question; changing that signature would edit thirteen files to no
 * purpose and give every one of them a shape it does not use. So the boolean stays exactly as it was
 * and this wraps it, taking the full answer through the enqueue's own optional out-channel.
 *
 * THE CONNECTOR IT REPORTS IS THE ONE THE ROW WAS WRITTEN UNDER, taken from inside the enqueue rather
 * than resolved again out here — resolving it a second time is the very race being closed, and a
 * second read could agree with the pin while the write did not.
 *
 * AND THE TWO ANSWERS MUST AGREE. If the structured outcome and the boolean the other call sites see
 * ever disagree — or if no outcome was reported at all — this refuses rather than guessing: an
 * obligation whose enqueue will not say what it did is exactly the silence this branch exists to end.
 */
export async function queueAccountingSyncTxWithOutcome(
  tx: Prisma.TransactionClient,
  params: Omit<Parameters<typeof queueAccountingSyncTx>[1], 'reportOutcome'>,
): Promise<AccountingEnqueueOutcome> {
  // A holder rather than a bare `let`: the assignment happens in a callback, and this keeps what was
  // reported readable as what it is rather than as the initialiser.
  const answered: { outcome?: AccountingEnqueueOutcome } = {}
  const queued = await queueAccountingSyncTx(tx, {
    ...params,
    reportOutcome: (outcome) => { answered.outcome = outcome },
  })
  const outcome = answered.outcome
  if (!outcome || outcome.queued !== queued) {
    return { queued: false, reason: 'refused', connector: null }
  }
  return outcome
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

export type AccountBalanceSnapshotSyncResult = { fetched: number; persisted: number; skipped: number; errors: string[] }

/**
 * Sync GL account-balance snapshots from the active accounting connector (used by the
 * account-balance-snapshot cron and the on-demand GL reconciliation refresh). Connector
 * -agnostic: dispatches to the active connector's implementation. QuickBooks has no
 * trial-balance/account-balance ingestion yet (needs the QBO trial-balance API + a QBO
 * sandbox — see onetwo3d-ims-khdw.1), so under QBO it returns a clear unsupported result
 * rather than silently succeeding; the GL reconciliations then degrade to unavailable.
 */
export async function syncAccountingAccountBalanceSnapshots(options?: {
  balanceDate?: Date | string
  accountCodes?: string[]
  syncRunId?: string
}): Promise<AccountBalanceSnapshotSyncResult> {
  const connector = await getActiveAccountingConnectorId()
  if (!connector) return { fetched: 0, persisted: 0, skipped: 0, errors: ['No active accounting connector'] }

  switch (connector) {
    case 'xero': {
      const { syncXeroAccountBalanceSnapshots } = await import('@/lib/connectors/xero/account-balances')
      return syncXeroAccountBalanceSnapshots(options)
    }
    case 'quickbooks':
      return {
        fetched: 0,
        persisted: 0,
        skipped: 0,
        errors: ['QuickBooks account-balance snapshot ingestion is not implemented (onetwo3d-ims-khdw.1)'],
      }
  }
}
