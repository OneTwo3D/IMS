/**
 * Generic accounting facade — core code imports ONLY from here, never from connector modules.
 */

import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { pinnedLedgerIsServicedUnderLock } from '@/lib/integration-plugin-selection-lock'
import { resolveAccountingEnqueueOrderScope } from '@/lib/domain/accounting/enqueue-order-guard'
import { hasLockedSalesOrder } from '@/lib/domain/sales/allocation-service'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'
import { notConfiguredUnderPinnedLedgerFence } from '@/lib/domain/accounting/pinned-enqueue-fence'
import { withSavepoint } from '@/lib/db/savepoint'
import {
  classifyPriorAttempts,
  describeUnresolvedPriorAttempt,
  isIdempotencyKeyIndexCollision,
  PRIOR_ATTEMPT_SELECT,
  priorAttemptsWhere,
} from '@/lib/domain/accounting/prior-posting-evidence'

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
  /**
   * o3d-j625 — WHOSE CHART THIS IS. NOT A CONVENIENCE FIELD; IT IS WHAT MAKES THE ACCOUNT CODES
   * ABOVE ATTRIBUTABLE.
   *
   * Every account code on this object is ONE CONNECTOR'S account code — `salesAccount` is Xero's or
   * QuickBooks's, never "the business's" (`getAccountingSettingsFor` says so already). A caller that
   * read these codes and then let an enqueue resolve "the active connector" for itself was building a
   * payload from one resolution and writing a row under a second, so a connector switch between the
   * two committed connector B's row carrying connector A's codes: the document posts to accounts that
   * do not exist in the books it lands in, or is rejected there, and the row is durable and claimable.
   *
   * Carrying the connector ON THE CHART is what closes that, because the chart is the thing that
   * crosses the gap — it is passed between functions (`queueRefundAccountingActions`,
   * `applyStockAdjustment`), persisted onto staged retry requests, and read minutes later. A caller
   * hands it back to {@link queueAccountingSync} as `chartConnector` and the row is written under the
   * SAME resolution the codes came from. There is no second resolution left to disagree with.
   *
   * REQUIRED, not optional: an optional field would let a caller silently omit it and get the old
   * unattributed behaviour back, which is the defect. `null` is the honest answer when no accounting
   * connector is switched on at all — the codes are then the empty-string defaults, and an enqueue
   * handed `null` writes nothing rather than posting empty accounts into whatever came on afterwards.
   */
  connector: AccountingConnectorInfo['id'] | null
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
  connector: null,
}

async function getActiveAccountingConnectorId(): Promise<AccountingConnectorInfo['id'] | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

/**
 * o3d-i0o6 r7 (Codex round 6, HIGH 1) — A PIN NAMES THE LEDGER A CREDIT BELONGS TO. IT SAYS NOTHING
 * ABOUT WHETHER THAT LEDGER IS STILL BEING SERVICED, AND BOTH ENQUEUES ASKED NEITHER QUESTION.
 *
 * Rounds 2-6 built the pin to answer ONE question: which books does this credit belong in? The
 * enqueue then asked a THIRD question — is `<connector>_sync_enabled` on? — and treated a yes as
 * licence to write. Those are not the same fact. The active accounting connector is resolved from
 * the PLUGIN flags (`getActiveAccountingConnectorId`, Xero-first); the per-connector sync toggle is
 * a separate setting that a switch does not touch. So after Xero -> QuickBooks, a reversal pinned to
 * Xero — because that is where its debit was proved to stand — passed `xero_sync_enabled === 'true'`
 * and a PENDING Xero row was written, while `app/api/cron/accounting-sync` had already taken the
 * QuickBooks branch and returned. Nothing scheduled drains it.
 *
 * WHY THAT COSTS MONEY RATHER THAN JUST BEING UNTIDY. `assertAllocationReversalQueued` asks the
 * database for the row — the right question, because the enqueue's boolean lies — and the stranded
 * row answers yes. The orphan path then adds the amount to `SalesOrder.allocationReversalAmount`,
 * which is exactly what a later refund nets its open Allocated Inventory balance against. Unposted
 * pounds are read as relief, and every later refund under-credits Allocated Inventory by that much.
 *
 * DECIDED: REFUSE THE ENQUEUE, rather than queue it and stop counting it as relief.
 *
 *   Refusing is the only one of the two that is safe in BOTH directions. A queued row on a
 *   non-active connector is NOT undrainable — `triggerXeroSync` / `triggerQuickBooksSync`, the
 *   manual Sync buttons, gate on `<connector>_sync_enabled` AND NOTHING ELSE and never resolve the
 *   active connector at all (this is established, and pinned by a test, in
 *   lib/domain/accounting/sync-row-claimability.ts). So "a row nobody will process" is a claim about
 *   the cron, not about the row: one press posts it. Declining to count such a row as relief would
 *   therefore create the SYMMETRIC error — the credit posts in Xero, IMS never records the relief,
 *   and the later refund credits the same pounds a second time.
 *
 *   Refusing has no such twin. Nothing is written, `assertAllocationReversalQueued` finds no row,
 *   `allocationReversalAmount` is not moved, and the ERROR-level activity record that already exists
 *   for the un-queued case names the amount and both account codes for a human. The debit stays
 *   open, which is true, and the refund's own residue still reverses it.
 *
 * `refused`, NEVER `not-configured`. `not-configured` means "no counterpart will ever exist, so
 * nothing is outstanding" and is the ONE no-op the refund obligation ledger allows to settle an
 * obligation. This posting is still owed — it just may not go here, now — so it must leave the
 * obligation standing and `accountingRetryRequired` set.
 *
 * A NO-OP FOR EVERY UNPINNED CALLER by construction: an unpinned enqueue takes its connector FROM
 * `getActiveAccountingConnectorId`, so the equality it would be asked to satisfy already holds.
 *
 * o3d-i0o6 r8 (Codex round 7, HIGH) — THIS FUNCTION IS AN UNLOCKED SNAPSHOT, AND IS NO LONGER WHAT
 * ENFORCES THE RULE ABOVE.
 *
 * Everything r7 wrote about WHICH outcome is correct stands. What it got wrong is that a pooled read
 * cannot make it hold: both enqueue paths await further work before their INSERT, so a switch
 * committing between this answer and that write put the row on the retired ledger anyway — and the
 * orphan path then read its amount as posted relief, which is the money consequence r7 set out to
 * make impossible.
 *
 * The enforcement is `pinnedLedgerIsServicedUnderLock`, which asks the same question through the
 * transaction that does the insert, holding the plugin-selection lock across both. This one survives
 * on the facade ONLY to fix the precedence of `refused` over `not-configured` (see the call site),
 * and it is the same predicate over the pooled source rather than a second rule: `resolveActive-
 * AccountingConnector` and `getActiveAccountingConnectorId` are one Xero-first rule with two sources,
 * which `tests/accounting/orphan-cancel-fence.test.ts` already pins.
 *
 * NOT used by the in-transaction enqueue at all any more: there is a transaction in hand there, so
 * there is no reason to ask unfenced.
 */
async function pinnedLedgerIsServiced(connector: AccountingConnectorInfo['id']): Promise<boolean> {
  return (await getActiveAccountingConnectorId()) === connector
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
  /**
   * `already-queued` (o3d-ekn8 r4, Codex MEDIUM) — `queued: true` WITHOUT A WRITE. The idempotency
   * short-circuit finds a live row carrying the same key and reports success, which is right for the
   * fourteen callers that only ask "is this work on the queue". It is NOT right for a caller that
   * then decides to ROLL THE WRITE BACK: there was no write, the pre-existing row is still live and
   * still going to post, and rolling back an empty transaction while telling the operator "nothing
   * was sent" is the one message that guarantees nobody goes looking for it.
   */
  reason?: 'not-configured' | 'refused' | 'already-queued'
}

export type AccountingEnqueueOutcome = ConnectorEnqueueOutcome & {
  connector: AccountingConnectorInfo['id'] | null
}

/**
 * o3d-j625 — THE ACCOUNT CODES AND THE ROW MUST COME OUT OF ONE RESOLUTION OF "WHICH CONNECTOR".
 *
 * THE DEFECT, which the o3d-i0o6 r8 fence deliberately does NOT cover. That fence is for PINNED
 * enqueues — a caller that PROVED something about a ledger — and it is a transactional advisory lock
 * plus `FOR UPDATE` on the plugin rows, held to the inserting commit. Taking it for every enqueue
 * would serialise invoicing, shipment confirmation and every journal against each other and against
 * every settings save, so unpinned enqueues take no lock. What was left behind is not a locking gap at
 * all, and no lock is needed to close it:
 *
 *   `getAccountingSettings()` internally resolves the active connector and returns THAT connector's
 *   chart. The caller then builds a payload out of those account codes — through a numbering read, a
 *   tax-rate lookup, an FX computation, a whole line map — and calls `queueAccountingSync` with NO
 *   connector, which resolves the active connector AGAIN. A switch committing in that window writes
 *   connector B's row carrying connector A's `salesAccount`, `shippingAccount`, `discountAccount`.
 *   The document then posts to accounts that do not exist in the books it landed in, or is rejected
 *   there — and the row is durable and claimable either way.
 *
 * THE FIX IS TO DELETE THE SECOND RESOLUTION, NOT TO LOCK THE WINDOW. `chartConnector` is the
 * connector the CODES CAME FROM (`AccountingSettings.connector`, which the chart now carries). Given
 * it, this function does not resolve anything: it routes the row through that connector's own queue.
 * The row's connector and the payload's account codes then come from ONE read, and they cannot
 * disagree however long the window is or however many switches commit inside it. That property is
 * STRUCTURAL — it holds with no lock and no fence.
 *
 * AND THE CHART BEING RETIRED IS REPORTED, NOT WRITTEN. Having established which books the codes
 * belong to, there is a second question: are those still the books this system is running? Asked
 * here, pooled and unlocked — the same predicate `pinnedLedgerIsServiced` answers for a pin — and a
 * `no` REFUSES rather than writing. `refused`, never `not-configured`: the posting is still owed (see
 * ConnectorEnqueueOutcome). This is deliberately WEAKER than the r8 fence and says so: a switch
 * committing after this read and before the connector queue's insert still writes the row, because
 * closing THAT window is what costs the global lock. It is worth having anyway, because the window it
 * does close is the wide one — the whole payload build — and because the row it declines to write is
 * one no scheduled drain reads.
 *
 * `null` MEANS "NO CONNECTOR WAS SWITCHED ON WHEN THE CHART WAS READ", and it is answered
 * `not-configured` — the same answer an unpinned enqueue has always given when nothing is on, and the
 * honest one: the payload's account codes are the empty-string defaults. Resolving the connector here
 * instead would post a document with no account codes into whichever connector came on in between.
 *
 * ONE IMPLEMENTATION, BOTH ENQUEUE PATHS. `queueAccountingSync` and `queueAccountingSyncTx` are two
 * copies of this decision waiting to drift, which is what o3d-d0pd's three copies of the
 * already-present check turned into; the in-transaction path calls this too and maps the answer through
 * its own `answer()` out-channel. It takes no transaction and no lock on purpose: everything it decides
 * is decidable from the caller's own chart plus one pooled read, and a lock here is the cost o3d-i0o6 r8
 * deliberately confined to pinned enqueues.
 *
 * Returns the outcome to answer with, or `null` to carry on with the enqueue.
 */
async function refuseUnattributableChart(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  connector?: AccountingConnectorInfo['id']
  chartConnector?: AccountingConnectorInfo['id'] | null
}): Promise<AccountingEnqueueOutcome | null> {
  // Absent: the caller named no chart, so nothing about it can be checked and nothing changes for it.
  if (params.chartConnector === undefined) return null
  if (params.chartConnector === null) {
    return { queued: false, reason: 'not-configured', connector: null }
  }
  // A PIN AND A CHART THAT NAME DIFFERENT LEDGERS CANNOT BOTH BE HONOURED. The pin says which books
  // the posting belongs in; the chart says whose account codes the payload is written in. Writing the
  // pin's row with the chart's codes is the very thing this guard exists to prevent, so a disagreement
  // is refused rather than resolved in either direction. No caller passes both today.
  if (params.connector && params.connector !== params.chartConnector) {
    return { queued: false, reason: 'refused', connector: params.connector }
  }
  if (await pinnedLedgerIsServiced(params.chartConnector)) return null
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_enqueue_refused_retired_chart',
    tag: 'accounting',
    level: 'WARNING',
    description:
      `NOTHING WAS QUEUED. The ${params.type} for ${params.referenceType} ${params.referenceId} was `
      + `built from ${params.chartConnector}'s chart of accounts, and ${params.chartConnector} is no `
      + 'longer the active accounting connector, so queueing it would write a row no scheduled sync '
      + 'reads. This posting is still OUTSTANDING: re-queue it from the source document once the '
      + 'accounting connector selection has settled.',
    metadata: {
      chartConnector: params.chartConnector,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
    },
    // A refusal must not become a throw because the audit write failed — the caller's own reporting of
    // `refused` is what the obligation ledgers act on.
  }).catch(() => { /* logging must never turn a refusal into a throw */ })
  return { queued: false, reason: 'refused', connector: params.chartConnector }
}

export async function queueAccountingSync(params: {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
  /**
   * o3d-j625 — THE CONNECTOR WHOSE CHART OF ACCOUNTS THIS PAYLOAD'S ACCOUNT CODES CAME FROM.
   *
   * `AccountingSettings.connector`, handed straight back. Given it, this function resolves nothing:
   * the row is written through that connector's queue, so the codes and the row come from ONE
   * resolution and cannot disagree. Also refuses — pooled, unlocked, `refused` not `not-configured` —
   * when that connector is no longer the active one, and `not-configured` when it is `null`.
   *
   * NOT the pin. `connector` below is a proof about a LEDGER and buys the r8 lock-held fence; this is
   * a statement about a PAYLOAD and buys no lock at all. See {@link refuseUnattributableChart}.
   */
  chartConnector?: AccountingConnectorInfo['id'] | null
  /**
   * PIN THE LEDGER (o3d-i0o6 r3, Codex HIGH 1) — the same parameter, with the same meaning, as the
   * one {@link queueAccountingSyncTx} takes.
   *
   * r2 added the pin to the TRANSACTIONAL enqueue only and filed the facade as follow-up work. That
   * filing did not hold: the route that actually carries the proved allocation credit — refund
   * staging, whose `UNEARNED_REV_REVERSAL` goes through `queueRefundAccountingActions` — comes
   * through HERE, so the pin round 2 added was bypassed on the one path it was added for. A caller
   * that has established a fact about a connector (that a debit posted there; that these account
   * codes are that connector's) and then lets the enqueue resolve "the active connector" for itself
   * is a caller whose proof and whose write are about two independently-read things, and no
   * re-checking afterwards can pull back a credit already queued to the wrong books.
   *
   * Passed, this does not resolve the active connector at all: the row is queued through the NAMED
   * connector's own queue, which applies that connector's enabled/posting-mode verdict and returns
   * `not-configured` — writing nothing — when it does not post this type. The reported `connector`
   * is then the pinned one, so an obligation ledger that pinned a DIFFERENT connector for the
   * hand-off sees the disagreement and leaves the obligation unmet instead of settling it.
   *
   * Deliberately not defaulted: every existing caller keeps the active-connector resolution by
   * simply not passing it.
   *
   * o3d-i0o6 r7 — AND THE PIN IS HONOURED ONLY WHILE THE NAMED CONNECTOR IS THE ACTIVE ONE. See
   * `pinnedLedgerIsServiced`: naming the ledger a credit belongs to does not establish that the
   * ledger is still being serviced, and a row written into a queue no scheduled drain reads is one
   * `assertAllocationReversalQueued` finds and counts as relief. Otherwise: `refused`, which leaves
   * the posting owed.
   */
  connector?: AccountingConnectorInfo['id']
}): Promise<AccountingEnqueueOutcome> {
  // o3d-j625: FIRST, before any resolution — this is the guard that makes a second resolution
  // unnecessary, so it cannot run after one. See refuseUnattributableChart.
  const unattributable = await refuseUnattributableChart(params)
  if (unattributable) return unattributable
  // o3d-j625: `params.chartConnector` before the resolve, so a caller that named the chart its codes
  // came from gets ITS connector rather than a fresh answer to the same question. A `null` chart has
  // already returned above, so the `??` chain cannot fall through a deliberate "no connector" into a
  // resolution that finds one.
  const connector = params.connector ?? params.chartConnector ?? await getActiveAccountingConnectorId()
  // o3d-i0o6 r9: the one pre-fence `not-configured` on this path a PIN CANNOT REACH, by construction
  // rather than by luck — `connector` is `params.connector ?? params.chartConnector ?? <resolved>`, so
  // a pinned enqueue always has one and this branch is dead for it. Left as a literal for that reason;
  // every other pre-fence `not-configured` below and in the connector queues goes through
  // `notConfiguredUnderPinnedLedgerFence`. o3d-j625: a CHARTED enqueue cannot reach it either — a
  // `null` chart has already answered `not-configured` above, and a named one is this `connector`.
  if (!connector) return { queued: false, reason: 'not-configured', connector: null }
  // o3d-i0o6 r7 — AND THE PINNED LEDGER MUST STILL BE THE ONE THIS SYSTEM IS RUNNING. See
  // `pinnedLedgerIsServiced`: the pin establishes WHICH books the posting belongs in, the sync
  // toggle establishes whether that connector posts at all, and neither of them establishes that
  // the scheduled drain is this connector's. Refused, not `not-configured`: the posting is owed.
  //
  // o3d-i0o6 r8 (Codex round 7, HIGH) — THIS READ IS NOT THE ENFORCEMENT, AND IT NO LONGER CLAIMS TO
  // BE. It is unlocked, and the INSERT it guards happens several awaits later inside the connector
  // queue's own transaction, so a switch committing in between wrote the row to the retired ledger
  // regardless. The enforcement moved to where the write is: `pinnedLedger` below hands the pin to
  // the connector queue, which re-asks this question UNDER the plugin-selection lock, inside the
  // transaction that inserts, and refuses there.
  //
  // WHY THIS ONE IS KEPT rather than deleted, given it decides nothing the fenced check does not
  // re-decide: PRECEDENCE. It runs before the connector's own enabled/posting-mode verdict, so a pin
  // to a retired ledger whose sync toggle is ALSO off still answers `refused` — the posting is owed —
  // instead of `not-configured`, which is the one no-op the refund obligation ledger is allowed to
  // settle an obligation with. That ordering is r7's decision and it is preserved. It cannot drift
  // from the fenced check because it is the SAME PREDICATE over a different source: "is the pinned
  // connector the active one", Xero-first, pooled here and locked there. It can only refuse earlier,
  // never permit something the fence would refuse.
  if (params.connector && !await pinnedLedgerIsServiced(params.connector)) {
    return { queued: false, reason: 'refused', connector }
  }
  // o3d-i0o6 r9 (Codex round 8, HIGH) — AND THIS ONE IS FENCED TOO, for the same reason as the
  // connector queues' sync gate. Xero never posts an FX journal, but "never" is a statement about
  // XERO: if the pin has been retired, the ledger now being serviced is QuickBooks, which DOES post
  // them — so this suppression rule may not settle an obligation on the retired ledger's behalf.
  // Unreachable for today's pinned callers (the refund hand-off pins ALLOCATION_REVERSAL and
  // UNEARNED_REV_REVERSAL, neither of which is an FX type), and fenced anyway: "not currently
  // reachable" is what round 7's check was, and it was reached. Unpinned callers are unchanged and
  // pay nothing.
  if (isFxGainLossJournalSuppressed(connector, params.type)) {
    return { ...await notConfiguredUnderPinnedLedgerFence(params.connector), connector }
  }

  // o3d-i0o6 r8: `pinnedLedger` is what makes the check above binding at the moment of the write. It
  // is `params.connector` verbatim — never `connector`, which is the resolved-or-pinned value and
  // would silently turn EVERY unpinned enqueue into a pinned one.
  if (connector === 'quickbooks') {
    const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')
    return { ...await queueQuickBooksSync({ ...params, pinnedLedger: params.connector }), connector }
  }
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
  return { ...await queueXeroSync({ ...params, pinnedLedger: params.connector }), connector }
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
     * PIN THE LEDGER (o3d-i0o6). The connector this row MUST be written under — not "which
     * connector is switched on when this line runs".
     *
     * Without it this function resolves the active connector for itself, which makes every caller
     * that established a fact about a connector BEFORE calling — that a debit posted there, that an
     * obligation was reckoned against it, that an account code came from its settings — a caller
     * whose proof and whose write are about two independently-resolved things. Nothing serialises a
     * connector switch between the two reads, so the proof can pass for one ledger and the row be
     * written for another, and no amount of re-checking AFTERWARDS can undo a credit already
     * queued against the wrong books.
     *
     * Passed, the connector cannot move underneath the caller: the enabled/posting-mode verdict is
     * taken for the PINNED connector ({@link getAccountingPostingContextFor}), the row is written
     * under it, and if that connector is no longer the one posting this type the enqueue refuses
     * `not-configured` and writes NOTHING — which is the outcome a caller that cannot post where it
     * proved wants, and the one it can report.
     *
     * Deliberately not defaulted and deliberately generic: it is about ANY two connectors, and
     * every existing caller keeps the active-connector resolution by simply not passing it.
     */
    connector?: AccountingConnectorInfo['id']
    /**
     * o3d-j625 — THE CONNECTOR WHOSE CHART OF ACCOUNTS THIS PAYLOAD'S ACCOUNT CODES CAME FROM.
     *
     * The same parameter, with the same meaning, as the one {@link queueAccountingSync} takes, and for
     * the same reason: without it this function resolves the active connector for itself
     * (`getAccountingPostingContext`) after the caller has already resolved it once to read the chart,
     * so a switch in between writes one connector's row carrying another's account codes.
     *
     * NOT the pin above. The pin is a proof about a LEDGER and takes the plugin-selection lock through
     * `tx`; this is a statement about a PAYLOAD and takes no lock — it routes by the caller's own
     * resolution and refuses, pooled, when that connector is no longer the active one.
     */
    chartConnector?: AccountingConnectorInfo['id'] | null
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
        // o3d-i0o6: a PINNED caller is answered about its own connector even on the two paths that
        // refuse before resolving one. Falling back to the active connector there would report a
        // ledger this call was never about.
        connector: connector === undefined
          ? (params.connector ?? await getActiveAccountingConnectorId())
          : connector,
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
  // o3d-i0o6 r7 (Codex round 6, HIGH 1) — THE PINNED LEDGER MUST STILL BE THE ACTIVE ONE. Checked
  // BEFORE the posting context, because `getAccountingPostingContextFor` answers from the named
  // connector's own sync toggle and would say "yes, it posts" for a connector the cron stopped
  // servicing when the plugin was switched away. See `pinnedLedgerIsServiced` for why this refuses
  // rather than queueing-and-not-counting. `refused`, so the obligation stays owed.
  //
  // o3d-i0o6 r8 (Codex round 7, HIGH) — AND IT IS FENCED, NOT SAMPLED. r7 asked this question through
  // the POOLED client and then awaited five more things before its INSERT (the posting context, the
  // id-provenance read, the base currency, the follow-up scope lock, the prior-attempt query). A
  // switch committing anywhere in that window wrote the row onto the now-inactive connector anyway —
  // the precise outcome r7 set out to make impossible, reached through the gap between its check and
  // its write. `pinnedLedgerIsServicedUnderLock` takes the plugin-selection lock THROUGH `tx`, so the
  // advisory lock and the `FOR UPDATE` row locks are held to the CALLER's COMMIT, which is after the
  // create below. There is no window left: while this transaction lives, the selection cannot move.
  //
  // Taken HERE, before anything else this function locks, so the order is sales-order row lock
  // (hoisted by the caller, asserted above) -> plugin selection -> follow-up scope. The connector
  // queues take the same three in the same order, and no plugin-selection writer holds a sales-order
  // row, so nothing can cycle.
  // o3d-j625: the chart check, BEFORE the pin fence and before any posting context is resolved — it is
  // the thing that removes the second resolution, so nothing may resolve ahead of it. Reported through
  // `answer` so this path's out-channel names the same connector the refusal is about. Shared with the
  // facade rather than restated: see refuseUnattributableChart.
  const unattributable = await refuseUnattributableChart(params)
  if (unattributable) {
    return answer(
      { queued: unattributable.queued, reason: unattributable.reason },
      unattributable.connector,
    )
  }
  if (params.connector && !await pinnedLedgerIsServicedUnderLock(tx, params.connector)) {
    return answer({ queued: false, reason: 'refused' }, params.connector)
  }
  // o3d-i0o6: the PIN wins where one was given. `getAccountingPostingContextFor` asks the same
  // question of the named connector that `getAccountingPostingContext` asks of whichever is active,
  // so a pinned caller gets the same verdict about the ledger it proved against — and a `null` here
  // means THAT connector does not post this type, never "some other connector does".
  // o3d-j625: `params.chartConnector` joins the pin here for the same reason it does on the facade — a
  // caller that named the chart its codes came from must get the verdict, and the row, for THAT
  // connector rather than a fresh answer to the same question. A `null` chart has already returned above.
  const routedConnector = params.connector ?? params.chartConnector
  const context = routedConnector
    ? await getAccountingPostingContextFor(routedConnector, params.type)
    : await getAccountingPostingContext(params.type)
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
    // o3d-d0pd: EVERY prior attempt for this key, in ANY status. Read through `tx`, so this runs
    // behind the follow-up scope lock taken immediately above and a concurrent enqueue for the same
    // key cannot slip its row in between this read and the create below. The three-status predicate
    // this replaced was blind to a FAILED attempt, and so is the partial unique index that would
    // otherwise have been the backstop. See prior-posting-evidence.ts.
    const priorAttempts = await tx.accountingSyncLog.findMany({
      where: priorAttemptsWhere({
        ...params,
        connector: context.connector,
        idempotencyKey: params.idempotencyKey,
      }),
      select: PRIOR_ATTEMPT_SELECT,
    })
    const verdict = classifyPriorAttempts(priorAttempts)
    // NOTHING IS WRITTEN HERE. `queued: true` means "the work is on the queue", not "this call put
    // it there" — see ConnectorEnqueueOutcome.reason (o3d-ekn8 r4).
    if (verdict.kind === 'live' || verdict.kind === 'posted') {
      return answer({ queued: true, reason: 'already-queued' }, context.connector)
    }
    if (verdict.kind === 'unresolved') {
      // REFUSED, not decided — the posting is still owed. Written through `tx` so it shares the
      // caller's fate: a refusal recorded against a transaction that then rolls back would be a
      // warning about something that did not happen.
      //
      // NOT swallowed, unlike the two connector queues' own logs. Those open their own transaction
      // and a failed log there costs nothing; here a failed statement has already aborted the
      // CALLER's transaction, and continuing on an aborted transaction turns a refusal the caller
      // could act on into a commit failure it cannot explain. Let it throw.
      await tx.activityLog.create({
        data: {
          entityType: 'SYSTEM',
          action: 'accounting_enqueue_refused_unresolved_attempt',
          tag: 'accounting',
          level: 'WARNING',
          description: describeUnresolvedPriorAttempt({ ...params, syncLogId: verdict.syncLogId }),
        },
      })
      return answer({ queued: false, reason: 'refused' }, context.connector)
    }
  }

  try {
    const [{ getBaseCurrencyCode }, { mirrorAccountingSyncLogToEvent }] = await Promise.all([
      import('@/lib/base-currency'),
      import('@/lib/domain/accounting/accounting-event-mirror'),
    ])
    const baseCurrency = await getBaseCurrencyCode()
    // o3d-d0pd r2 (Codex MEDIUM) — THE ONLY STATEMENT HERE THAT MAY RAISE A HANDLED ERROR, AND SO
    // THE ONLY ONE THAT NEEDS ISOLATING.
    //
    // The catch below detects `accounting_sync_logs_idempotency_key_uq` and answers `queued: true`.
    // That detection was dead code until this round fixed it (o3d-5od: `String(error)` never
    // contains the index name under `@prisma/adapter-pg`), which means the path it guards is NEWLY
    // REACHABLE — and reaching it was worse than throwing. `tx` is the CALLER's interactive
    // transaction; PostgreSQL aborts the whole transaction on the 23505, Prisma wraps no savepoint
    // around individual statements, and so every statement the caller issues after this function
    // returns — and the COMMIT itself — fails with 25P02. Callers that immediately write COGS or
    // transit subledger rows are exactly the ones that would have hit it. "Detected, reported, and
    // then the caller's transaction cannot commit" is not a handled collision.
    //
    // The savepoint is what makes the catch genuinely recoverable: rolling back to it clears the
    // aborted state and leaves the rest of the transaction intact and committable.
    //
    // WRAPPED AROUND THE CREATE ALONE, not the whole block. The outbox schedule and the event mirror
    // that follow are ordinary work whose failure is NOT handled here — isolating them would only
    // hide it. The collision can come from nothing but this INSERT.
    const log = await withSavepoint(tx, () => tx.accountingSyncLog.create({
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
    }))
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
    //
    // o3d-d0pd: detected through the shared reader rather than a substring of the error text, which
    // the driver adapter never contains (o3d-5od).
    //
    // o3d-d0pd r2: AND THE TRANSACTION IS USABLE WHEN THIS RETURNS. The create above runs inside a
    // savepoint, so the 23505 that brought us here has already been rolled back to it and the
    // caller's interactive transaction is committable — which is the whole difference between
    // reporting a handled collision and reporting one the caller then cannot act on. See the note on
    // the create.
    if (params.idempotencyKey && isIdempotencyKeyIndexCollision(error)) {
      return answer({ queued: true, reason: 'already-queued' }, context.connector)
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
  return getAccountingSettingsFor(await getActiveAccountingConnectorId())
}

/**
 * THE SAME SETTINGS, FOR A CONNECTOR THE CALLER NAMES (o3d-i0o6).
 *
 * Every account code in here is a CONNECTOR'S account code — `allocatedInventoryAccount` is Xero's
 * or QuickBooks's, never "the business's". So a caller that has pinned a connector and then reads
 * {@link getAccountingSettings} is reading one connector's chart of accounts through a second,
 * independent resolution of "which connector is active", and a switch in between hands it an account
 * code from books it is not posting to. That is the same defect as resolving the connector twice
 * around an enqueue, one layer down, and it is closed the same way: the connector is resolved ONCE
 * and everything downstream is derived from that one value.
 *
 * `null` is the same answer the active-connector form gives when nothing is switched on: the
 * defaults, whose account codes are empty strings, so a caller that demands a configured account
 * refuses on its own terms.
 */
export async function getAccountingSettingsFor(
  connector: AccountingConnectorInfo['id'] | null,
): Promise<AccountingSettings> {
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

  if (!connector) {
    return {
      ...DEFAULT_ACCOUNTING_SETTINGS,
      paymentAccountMap: paymentMapSetting?.value ?? '{}',
      invoiceUrlTemplate: invoiceUrlSetting?.value ?? '',
      billUrlTemplate: billUrlSetting?.value ?? '',
      reverseChargeSalesTaxType,
      reverseChargePurchaseTaxType,
      // o3d-j625: the chart names its own connector on every path, including this one. `null` here is
      // not "unknown" — it is "no connector is switched on", which is exactly what the empty-string
      // account codes above already mean.
      connector: null,
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
        // o3d-j625: every code above is XERO's. Said out loud, and carried, so no downstream enqueue
        // has to resolve "which connector" a second time to find out.
        connector,
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
        // o3d-j625: and every code above is QUICKBOOKS's.
        connector,
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
