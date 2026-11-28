import { createHash } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { roundMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import {
  nonImsApprovalStanding, nonImsBillFingerprint, purchaseFxOrdersToReconcile, reconcilePurchaseBillFx, reportPurchaseFxVarianceNotQueued, stockUnitsForeign, type PurchaseBillFxReconcileResult,
} from '@/lib/domain/purchasing/purchase-bill-fx'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'
import type { XeroBill, XeroBillReadDeps } from '@/lib/connectors/xero/bill-read'

/**
 * PER-EVENT FX, MED-C (owner ruling "post a one-off journal"): BILLS THAT REACHED XERO OUTSIDE IMS.
 *
 * A bill entered at the order's rate before the switch (fxRateSource NULL) whose posting IMS did not queue (posted by Qoblex in P1, by the first load,
 * by hand) has no PURCHASE_BILL transit row, so the exchange-rate reconciliation (purchase-bill-fx.ts) corrects its GR/IR but owes no journal for it. The
 * owner ruled that such a bill gets a one-off journal, but NOT automatically: IMS lists these bills with the journal it proposes and the basis it assumes,
 * and posts nothing until an admin confirms (scripts/purchase-fx-non-ims-bills.ts).
 *
 * THE BASIS IS THE XERO BILL. What such a bill put in Stock in Transit is known only to Xero, so each candidate's Xero bill (its accountingInvoiceId) is
 * read at most ONCE per command run (the dry run and the confirmation are separate runs, so each reads), read-only (lib/connectors/xero/bill-read.ts),
 * and the confirmation stores the answer it read (not read again in that run). The Xero client's limiter is per process and cannot see the
 * application's own calls against the organisation's 1,000-a-day allowance, so a run reads at most `maxReads` bills (default 50), only the named ones
 * when bills are named, and stops at the first rate-limited or unsent read; the rest are listed as not read. A bill is confirmable only if its Xero bill is an ACCPAY in the order's currency, not voided or deleted, every line coded
 * to the Stock in Transit account, and its net equal to the IMS bill's. The journal is measured at the Xero bill's CurrencyRate on the order's goods cost
 * (after the header discount); the Xero bill's price difference stays on transit, as for every bill from before the switch (owner ruling 2026-11-26).
 *
 * CANDIDATES: PO-rate bills of foreign, uncancelled orders, linked to a Xero bill, with no PURCHASE_BILL transit row and no confirmation, on an order with
 * goods still to receive or that the switch has already valued. A bill with a delete pending, or whose IMS posting was declined and then marked handled
 * (keyed by hand), is left out unless the admin names it. A bill with no Xero link is never confirmable (there is no basis).
 *
 * A CONFIRMATION covers the bill's goods NOT RECEIVED YET too: from then on the bill is treated as in transit at the Xero basis, so every later receipt of
 * the order adjusts its journal (the list shows that exposure). It runs, per order, in one transaction under the order's row lock: the confirmation rows
 * (who, why, the Xero answer, the journal proposed) and an activity-log WARNING are written, the reconciliation runs, and the journal it would queue must
 * equal what the admin was shown (`--expect` or `--digest`), else the order's confirmation is rolled back. The journal goes through the normal accounting
 * queue and the producer-side hold (so it can be shadowed) and, the reconciliation being target state, is posted once: a re-run confirms and posts nothing.
 *
 * Behind the switch and its interlock: while `isPurchaseEventFxEnabled` is false the list is shown without reading Xero and marked "not confirmable yet",
 * and a confirmation is refused.
 */

export type NonImsBillCandidate = {
  poId: string
  poReference: string
  currency: string
  invoiceId: string
  invoiceNumber: string | null
  accountingInvoiceId: string | null
  /** Why IMS has no transit row for it (how it reached Xero). */
  noTransitRowReason: string
  /** Why it is left out of the default list (shown when named): no Xero link, a delete pending, declined and marked handled. */
  exclusion: string | null
  /**
   * MED-5: the bill is already confirmed: listed because its confirmation went stale (shown by default) or because it was named (a re-confirmation, e.g.
   * after the Xero bill was edited, which IMS does not see). Confirming it again replaces the basis; null = not confirmed yet.
   */
  reconfirmation: string | null
  /** Why it cannot be confirmed (null = confirmable). */
  problem: string | null
  basis: {
    /** Quantity of the bill treated as in transit (all its goods lines). */
    qty: string
    /** The order's goods cost of those lines, in the bill's currency (after the header discount). */
    stockForeign: string
    /** The Xero bill's status (only AUTHORISED or PAID is a basis). */
    xeroStatus: string | null
    /** The Xero bill's CurrencyRate (1 base = rate foreign). */
    rate: string | null
    /** The account the Xero bill's lines are coded to. */
    account: string | null
    /** stockForeign at the Xero rate: what the journal is measured on. */
    stockTransitBase: string | null
    /** The Xero bill's lines on transit, in base. */
    xeroTransitBase: string | null
    /** xeroTransitBase - stockTransitBase: the bill's price difference, which stays on transit. */
    priceDifferenceBase: string | null
  }
  /** Goods of this bill not received yet: a confirmation covers them too (their receipts adjust the journal later). */
  notReceived: { qty: string; base: string | null }
  /** The signed transit movement the journal would post now (positive = debit transit); null when not confirmable. */
  proposedTransitDelta: string | null
}

export const NON_IMS_BILLS_DEFAULT_MAX_READS = 50

export type NonImsBillsList = {
  /** Xero reads made by this run. */
  xeroReads: number
  confirmable: boolean
  notConfirmableReason: string | null
  candidates: NonImsBillCandidate[]
  /** A digest of the confirmable default candidates and their proposals (`--digest` on the confirmation). */
  digest: string
}

export class NonImsBillsConfirmRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonImsBillsConfirmRefused'
  }
}

class ConfirmMismatch extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonImsBillsConfirmMismatch'
  }
}

class Rollback extends Error {
  constructor(readonly result: PurchaseBillFxReconcileResult) {
    super('purchase-fx non-IMS bills proposal: rolled back')
  }
}

type Db = typeof import('@/lib/db')['db']
type Prepared = NonImsBillCandidate & { xero: XeroBill | null; xeroTenantId: string | null; stockUnits: Record<string, string>; billFingerprint: string }

const zero = (): Decimal => new Prisma.Decimal(0)

/** The digest the admin confirms against: each bill, its proposal and the rate it was measured at, in a stable order. */
export function nonImsBillsDigest(candidates: ReadonlyArray<Pick<NonImsBillCandidate, 'invoiceId' | 'proposedTransitDelta' | 'basis'>>): string {
  const text = [...candidates].map((c) => `${c.invoiceId}=${c.proposedTransitDelta ?? '-'}@${c.basis.rate ?? '-'}`).sort().join('\n')
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

async function noTransitRowReason(db: Db, bill: { id: string; accountingInvoiceId: string | null; accountingInvoiceIdSource: string | null }): Promise<{ reason: string; handled: boolean }> {
  const refusal = await db.accountingPostingRefusal.findFirst({
    where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: bill.id }, orderBy: { lastRefusedAt: 'desc' }, select: { resolution: true, resolvedAt: true },
  })
  if (refusal?.resolution === 'handled_manually') return { reason: 'IMS\'s posting was declined and then marked handled (keyed into Xero by hand)', handled: true }
  if (refusal) return { reason: 'IMS\'s posting was declined', handled: false }
  const { LEDGER_STANDING_SELECT, ledgerStanding } = await import('@/lib/domain/accounting/ledger-standing')
  const logs = await db.accountingSyncLog.findMany({ where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: bill.id }, select: LEDGER_STANDING_SELECT })
  if (logs.some((log) => ledgerStanding(log) === 'SHADOW_NOT_SENT_BY_IMS')) return { reason: 'IMS\'s posting was shadowed by the producer-side hold (not sent by IMS): another system posted it', handled: false }
  if (logs.length === 0) {
    if (!bill.accountingInvoiceId) return { reason: 'never posted to Xero by IMS (bill sync off, or not posted at all)', handled: false }
    return { reason: bill.accountingInvoiceIdSource === 'MANUAL' ? 'not posted by IMS: linked to its Xero bill by hand' : 'not posted by IMS (Qoblex, the first load or by hand)', handled: false }
  }
  return { reason: 'IMS\'s posting has no transit row', handled: false }
}

/** The candidates with their basis, read from Xero once each when `readXero`. */
async function prepare(db: Db, options: { named: ReadonlySet<string>; readXero: boolean; maxReads: number; deps?: XeroBillReadDeps }): Promise<{ prepared: Prepared[]; reads: number }> {
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: db.organisation })).toUpperCase()
  const touched = new Set(await purchaseFxOrdersToReconcile(db))
  const { getAccountingSettings } = await import('@/lib/accounting')
  const transitAccount = (await getAccountingSettings()).transitAccount.trim()
  const orders = await db.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' }, NOT: { currency: baseCurrency }, invoices: { some: { fxRateSource: null } } },
    orderBy: { reference: 'asc' },
    select: {
      id: true, reference: true, currency: true, subtotalForeign: true,
      lines: { select: { id: true, qtyReceived: true, qtyReturned: true, unitCostForeign: true, totalForeign: true } },
      invoices: {
        orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, invoiceNumber: true, fxRateSource: true, subtotalForeign: true, accountingInvoiceId: true, accountingInvoiceIdSource: true,
          lines: { select: { poLineId: true, qtyBilled: true, totalForeign: true } },
        },
      },
    },
  })
  const { pendingDeletionError } = await import('@/lib/domain/accounting/document-delete-pending')
  const connectedTenantId = (await db.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } }))?.tenantId ?? null
  const read = options.readXero ? (options.deps ? options.deps : undefined) : undefined
  const { readXeroBillById } = await import('@/lib/connectors/xero/bill-read')
  const out: Prepared[] = []
  let reads = 0
  let stopped: string | null = null
  for (const order of orders) {
    if (order.currency.trim().toUpperCase() === baseCurrency) continue
    const stockUnits = stockUnitsForeign(order)
    // What each bill line still waits for: the net received quantity is taken by the order's bills in bill order.
    const receivedLeft = new Map(order.lines.map((line) => [line.id, Prisma.Decimal.max(0, toDecimal(line.qtyReceived).sub(toDecimal(line.qtyReturned)))]))
    const unreceivedByBill = new Map<string, Map<string, Decimal>>()
    for (const invoice of order.invoices) {
      const perLine = new Map<string, Decimal>()
      for (const line of invoice.lines) {
        if (!line.poLineId) continue
        const qty = toDecimal(line.qtyBilled)
        const left = receivedLeft.get(line.poLineId) ?? zero()
        const taken = Prisma.Decimal.min(left, qty)
        receivedLeft.set(line.poLineId, left.sub(taken))
        perLine.set(line.poLineId, (perLine.get(line.poLineId) ?? zero()).add(qty.sub(taken)))
      }
      unreceivedByBill.set(invoice.id, perLine)
    }
    const inFlight = [...unreceivedByBill.values()].some((perLine) => [...perLine.values()].some((qty) => qty.gt(0)))
    const billKeys = (await db.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_BILL', sourceRef: order.id }, select: { idempotencyKey: true } })).map((row) => row.idempotencyKey)
    const confirmedRows = new Map((await db.purchaseFxNonImsBillApproval.findMany({
      where: { poId: order.id },
      select: { invoiceId: true, staleAt: true, staleReason: true, approvedAt: true, xeroInvoiceId: true, xeroTenantId: true, stockUnits: true, billFingerprint: true },
    })).map((row) => [row.invoiceId, row]))
    for (const invoice of order.invoices) {
      if (invoice.fxRateSource !== null) continue
      if (billKeys.some((key) => key.startsWith(`purchase-invoice:${invoice.id}:`))) continue
      const named = options.named.has(invoice.id)
      const already = confirmedRows.get(invoice.id)
      // #1164 LOW-5: a confirmed bill is listed again when its confirmation does not hold NOW (judged as the reconciliation judges it, whether or not a
      // reconciliation has marked it yet), or when it is named (a re-confirmation, e.g. after an edit of the Xero bill).
      const standing = already ? nonImsApprovalStanding(already, invoice, stockUnits, connectedTenantId) : null
      if (already && standing?.kind !== 'stale' && !named) continue
      const reconfirmation = already
        ? (standing?.kind === 'stale'
          ? `confirmed on ${already.approvedAt.toISOString().slice(0, 10)}, now stale: ${standing.reason}; confirming again replaces the basis`
          : `confirmed on ${already.approvedAt.toISOString().slice(0, 10)}; confirming again replaces the basis (after an edit of the Xero bill)`)
        : null
      // MED-6: with bills named, only those are listed (and read).
      if (options.named.size > 0 && !named) continue
      if (!named && !inFlight && !touched.has(order.id)) continue
      const why = await noTransitRowReason(db, invoice)
      const deletePending = await pendingDeletionError(invoice.id, db)
      const exclusion = !invoice.accountingInvoiceId ? 'not linked to a Xero bill'
        : deletePending ? 'a delete of the bill is pending'
        : why.handled ? 'declined and marked handled (keyed into Xero by hand)'
        : null
      if (exclusion && !named) continue
      let qty = zero()
      let stockForeign = zero()
      for (const line of invoice.lines) {
        if (!line.poLineId) continue
        qty = qty.add(toDecimal(line.qtyBilled))
        stockForeign = stockForeign.add(roundMoney(toDecimal(line.qtyBilled).mul(stockUnits.get(line.poLineId) ?? zero()), order.currency))
      }
      const unreceived = unreceivedByBill.get(invoice.id) ?? new Map<string, Decimal>()
      let unreceivedQty = zero()
      let unreceivedForeign = zero()
      for (const [lineId, q] of unreceived) {
        unreceivedQty = unreceivedQty.add(q)
        unreceivedForeign = unreceivedForeign.add(q.mul(stockUnits.get(lineId) ?? zero()))
      }
      const candidate: Prepared = {
        poId: order.id, poReference: order.reference, currency: order.currency, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
        accountingInvoiceId: invoice.accountingInvoiceId, noTransitRowReason: why.reason, exclusion, reconfirmation, problem: null,
        basis: { qty: qty.toString(), stockForeign: stockForeign.toFixed(2), xeroStatus: null, rate: null, account: null, stockTransitBase: null, xeroTransitBase: null, priceDifferenceBase: null },
        notReceived: { qty: unreceivedQty.toString(), base: null },
        proposedTransitDelta: null,
        xero: null,
        xeroTenantId: null,
        stockUnits: Object.fromEntries(invoice.lines.flatMap((line) => (line.poLineId && stockUnits.has(line.poLineId) ? [[line.poLineId, stockUnits.get(line.poLineId)!.toString()]] : []))),
        billFingerprint: nonImsBillFingerprint(invoice),
      }
      if (!invoice.accountingInvoiceId) candidate.problem = 'not linked to a Xero bill: there is no basis for a journal'
      else if (!transitAccount) candidate.problem = 'the Stock in Transit account is not mapped'
      else if (options.readXero && stopped) candidate.problem = `not read: ${stopped}`
      else if (options.readXero && reads >= options.maxReads) candidate.problem = `not read: this run's cap of ${options.maxReads} Xero reads was reached (--max-reads); name the bills, or run again later`
      else if (options.readXero) {
        reads += 1
        const answer = await readXeroBillById(invoice.accountingInvoiceId, read)
        if (!answer.ok) {
          candidate.problem = `the Xero bill could not be read: ${answer.error}`
          if (answer.stopReading) stopped = 'Xero rate-limited or did not take an earlier read in this run (HTTP 429 or not sent); run again later'
        } else {
          const bill = answer.bill
          candidate.xero = bill
          candidate.xeroTenantId = answer.tenantId
          const accounts = [...new Set(bill.lines.map((line) => line.accountCode ?? '(none)'))]
          candidate.basis.account = accounts.join(', ')
          candidate.basis.rate = bill.currencyRate.toString()
          candidate.basis.xeroStatus = bill.status
          const net = bill.lines.reduce((sum, line) => sum.add(bill.lineAmountTypes.toUpperCase() === 'INCLUSIVE' ? line.lineAmount.sub(line.taxAmount) : line.lineAmount), zero())
          if (bill.type.toUpperCase() !== 'ACCPAY') candidate.problem = `the Xero document is a ${bill.type}, not a bill`
          // HIGH-1: only an approved bill is in the ledger. A DRAFT or SUBMITTED one has put nothing in Stock in Transit (and Xero may re-rate it when it is
          // approved); a VOIDED or DELETED one no longer stands.
          else if (!['AUTHORISED', 'PAID'].includes(bill.status.toUpperCase())) candidate.problem = `the Xero bill is ${bill.status}: only an AUTHORISED or PAID bill is in the ledger, so it is no basis for a journal`
          else if (bill.currencyCode !== order.currency.trim().toUpperCase()) candidate.problem = `the Xero bill is in ${bill.currencyCode}, the order in ${order.currency}`
          else if (accounts.length !== 1 || accounts[0] !== transitAccount) candidate.problem = `the Xero bill's lines are coded to ${accounts.join(', ')}, not (only) to Stock in Transit (${transitAccount}): what it put in transit is not known, so no journal is proposed`
          else if (!roundMoney(net, order.currency).eq(roundMoney(toDecimal(invoice.subtotalForeign), order.currency))) candidate.problem = `the Xero bill's net (${net.toFixed(2)}) differs from the IMS bill's (${toDecimal(invoice.subtotalForeign).toFixed(2)})`
          const rate = bill.currencyRate
          const stockBase = roundQuantity(stockForeign.div(rate), 2)
          const xeroBase = roundQuantity(net.div(rate), 2)
          candidate.basis.stockTransitBase = stockBase.toFixed(2)
          candidate.basis.xeroTransitBase = xeroBase.toFixed(2)
          candidate.basis.priceDifferenceBase = xeroBase.sub(stockBase).toFixed(2)
          candidate.notReceived.base = roundQuantity(unreceivedForeign.div(rate), 2).toFixed(2)
        }
      } else {
        candidate.problem = 'not confirmable yet (the Xero bill is read only once the switch can be confirmed)'
      }
      out.push(candidate)
    }
  }
  return { prepared: out, reads }
}

/** The journal a confirmation of these bills would post now: the reconciliation of their order with them confirmed at their Xero rate, rolled back. */
async function proposeForOrder(db: Db, poId: string, rates: ReadonlyMap<string, Decimal | null>, settings: { connector: string | null; syncEnabled: boolean }): Promise<Map<string, string>> {
  let result: PurchaseBillFxReconcileResult | null = null
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
      throw new Rollback(await reconcilePurchaseBillFx(tx, {
        poId, connector: settings.connector, syncEnabled: settings.syncEnabled, at: new Date(), dryRun: true, assumeConfirmed: rates,
      }))
    }, { timeout: 60_000, maxWait: 10_000 })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
    result = error.result
  }
  const out = new Map<string, string>()
  for (const id of rates.keys()) out.set(id, '0.00')
  // #1164 LOW-4: the journal and any take-back of an earlier shadow, as the confirmation will compare them.
  for (const entry of [...(result?.journals ?? []), ...(result?.shadowed ?? []).filter((x) => x.reversal)]) {
    if (rates.has(entry.invoiceId)) out.set(entry.invoiceId, toDecimal(out.get(entry.invoiceId) ?? '0').add(entry.transitDelta).toFixed(2))
  }
  return out
}

async function confirmability(db: Db): Promise<{ confirmable: boolean; reason: string | null; settings: { connector: string | null; syncEnabled: boolean } }> {
  const { getAccountingSettings } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  if (!(await isPurchaseEventFxEnabled(db))) return { confirmable: false, reason: 'not confirmable yet: per-event FX rates for purchasing are off (purchase_event_fx_rates_enabled, or its interlock)', settings }
  if (!settings.syncEnabled || settings.connector !== 'xero') return { confirmable: false, reason: 'not confirmable: Xero sync is off, so the journal could not be posted', settings }
  return { confirmable: true, reason: null, settings }
}

async function listPrepared(db: Db, options: { named?: ReadonlyArray<string>; maxReads?: number; deps?: XeroBillReadDeps }): Promise<{ list: NonImsBillsList; prepared: Prepared[]; settings: { connector: string | null; syncEnabled: boolean } }> {
  const gate = await confirmability(db)
  const { prepared, reads } = await prepare(db, { named: new Set(options.named ?? []), readXero: gate.confirmable, maxReads: options.maxReads ?? NON_IMS_BILLS_DEFAULT_MAX_READS, deps: options.deps })
  const byOrder = new Map<string, Map<string, Decimal | null>>()
  for (const c of prepared) {
    if (c.problem || !c.xero) continue
    byOrder.set(c.poId, (byOrder.get(c.poId) ?? new Map()).set(c.invoiceId, c.xero.currencyRate))
  }
  for (const [poId, rates] of byOrder) {
    for (const [id, delta] of await proposeForOrder(db, poId, rates, gate.settings)) {
      const c = prepared.find((p) => p.invoiceId === id)
      if (c) c.proposedTransitDelta = delta
    }
  }
  const candidates: NonImsBillCandidate[] = prepared.map((c) => {
    const rest: Partial<Prepared> = { ...c }
    delete rest.xero
    delete rest.xeroTenantId
    delete rest.stockUnits
    delete rest.billFingerprint
    return rest as NonImsBillCandidate
  })
  return {
    list: { xeroReads: reads, confirmable: gate.confirmable, notConfirmableReason: gate.reason, candidates, digest: nonImsBillsDigest(candidates.filter((c) => !c.exclusion && !c.problem)) },
    prepared,
    settings: gate.settings,
  }
}

/** THE LIST (the dry run): every bill a confirmation would cover (and the named ones), its basis and the journal it would post now. Writes nothing. */
export async function listNonImsBills(options: { named?: ReadonlyArray<string>; maxReads?: number; deps?: XeroBillReadDeps } = {}): Promise<NonImsBillsList> {
  const { db } = await import('@/lib/db')
  return (await listPrepared(db, options)).list
}

export type NonImsBillsConfirmation = {
  confirmed: Array<{ invoiceId: string; invoiceNumber: string | null; poReference: string; proposedTransitDelta: string }>
  xeroReads: number
  journals: PurchaseBillFxReconcileResult['journals']
  notQueued: number
  shadowed: number
  /** Orders NOT confirmed (their transaction rolled back). */
  failed: Array<{ poReference: string; error: string }>
  /** LOW-11: orders confirmed and committed whose after-commit report (of a declined journal) failed: the confirmation stands. */
  reportFailed: Array<{ poReference: string; error: string }>
}

/**
 * THE CONFIRMATION (admin): `all` the default candidates, or the named `invoiceIds`; each must be confirmable, and the journal must be the one the admin
 * was shown, per bill (`expect`: invoice id -> signed transit amount) or for the whole set (`digest`). See the module comment. One order's failure (a
 * mismatch, a refusal) rolls back that order only, and is reported in `failed`.
 */
export async function confirmNonImsBills(params: {
  by: string; reason: string; all?: boolean; invoiceIds?: ReadonlyArray<string>; expect?: ReadonlyMap<string, string>; digest?: string; maxReads?: number; deps?: XeroBillReadDeps
}): Promise<NonImsBillsConfirmation> {
  const { db } = await import('@/lib/db')
  if (!params.by.trim() || !params.reason.trim()) throw new NonImsBillsConfirmRefused('--by and --reason are required: the confirmation is audited.')
  const named = params.invoiceIds ?? []
  if (Boolean(params.all) === (named.length > 0)) throw new NonImsBillsConfirmRefused('Name the bills to confirm with --bill <id>, or pass --all for every bill listed (not both).')
  // LOW-9: the digest covers the whole default list, so it goes with --all only.
  if (params.digest && !params.all) throw new NonImsBillsConfirmRefused('--digest goes with --all (it covers the whole default list); for named bills pass --expect <id>=<amount>. Nothing was confirmed.')
  // #1164 MED-1: a journal the hold would shadow today is lost for good (the bill would then be settled with nothing in the ledger), so the confirmation
  // is refused up front, before any Xero read, while PURCHASE_FX_VARIANCE journals are shadowed.
  const { purchaseFxJournalShadowed } = await import('@/lib/domain/purchasing/purchase-event-fx-switch-on')
  const { businessDateYmd } = await import('@/lib/business-date')
  if (purchaseFxJournalShadowed(businessDateYmd(new Date()))) {
    throw new NonImsBillsConfirmRefused('Nothing was confirmed: the producer-side hold shadows exchange-rate difference journals today (IMS is not yet the writer of these journals), so the journal would never reach Xero. Confirm once IMS writes them.')
  }
  const { list, prepared, settings } = await listPrepared(db, { named, maxReads: params.maxReads, deps: params.deps })
  if (!list.confirmable) throw new NonImsBillsConfirmRefused(`Nothing was confirmed: ${list.notConfirmableReason}.`)
  let chosen: Prepared[]
  if (params.all) {
    chosen = prepared.filter((c) => !c.exclusion && !c.problem)
  } else {
    const missing = named.filter((id) => !prepared.some((c) => c.invoiceId === id))
    if (missing.length > 0) throw new NonImsBillsConfirmRefused(`Not a bill awaiting confirmation (already confirmed, posted by IMS, or not a candidate): ${missing.join(', ')}. Nothing was confirmed.`)
    chosen = prepared.filter((c) => named.includes(c.invoiceId))
    const blocked = chosen.filter((c) => c.problem)
    if (blocked.length > 0) throw new NonImsBillsConfirmRefused(`Not confirmable: ${blocked.map((c) => `${c.invoiceNumber ?? c.invoiceId} (${c.problem})`).join('; ')}. Nothing was confirmed.`)
  }
  if (chosen.length === 0) throw new NonImsBillsConfirmRefused('No bill to confirm. Nothing was confirmed.')
  const strays = [...(params.expect?.keys() ?? [])].filter((id) => !chosen.some((c) => c.invoiceId === id))
  if (strays.length > 0) throw new NonImsBillsConfirmRefused(`--expect names bills that are not being confirmed: ${strays.join(', ')}. Nothing was confirmed.`)
  if (params.digest) {
    if (nonImsBillsDigest(chosen) !== params.digest) throw new NonImsBillsConfirmRefused(`The bills or their journals changed since the dry run (digest ${nonImsBillsDigest(chosen)}, not ${params.digest}). Run the dry run again. Nothing was confirmed.`)
  } else {
    const unexpected = chosen.filter((c) => !params.expect?.has(c.invoiceId))
    if (unexpected.length > 0) throw new NonImsBillsConfirmRefused(`Pass --expect <bill id>=<amount> from the dry run for every bill confirmed (missing: ${unexpected.map((c) => c.invoiceId).join(', ')}), or --digest. Nothing was confirmed.`)
  }
  const expected = (c: Prepared): string => params.expect?.get(c.invoiceId) ?? c.proposedTransitDelta ?? '0.00'
  const { logActivityInTransaction } = await import('@/lib/activity-log')
  const out: NonImsBillsConfirmation = { confirmed: [], xeroReads: list.xeroReads, journals: [], notQueued: 0, shadowed: 0, failed: [], reportFailed: [] }
  const byOrder = new Map<string, Prepared[]>()
  for (const c of chosen) byOrder.set(c.poId, [...(byOrder.get(c.poId) ?? []), c])
  for (const [poId, bills] of byOrder) {
    const ids = new Set(bills.map((b) => b.invoiceId))
    let result: PurchaseBillFxReconcileResult
    try {
      result = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
        // LOW-8: the Xero organisation connected now is the one that answered the read.
        const token = await tx.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
        for (const bill of bills) {
          if (!token?.tenantId || token.tenantId !== bill.xeroTenantId) throw new ConfirmMismatch(`bill ${bill.invoiceNumber ?? bill.invoiceId}: the Xero bill was read from organisation ${bill.xeroTenantId ?? '?'}, the connected one is ${token?.tenantId ?? 'none'}`)
          // LOW-7: still a candidate under the lock (not posted by IMS meanwhile, not re-linked, not on its way out, not re-valued).
          const now = await tx.purchaseInvoice.findUnique({ where: { id: bill.invoiceId }, select: { fxRateSource: true, accountingInvoiceId: true, subtotalForeign: true, lines: { select: { poLineId: true, qtyBilled: true, totalForeign: true } } } })
          const posted = await tx.transitSubledgerMovement.findFirst({ where: { sourceType: 'PURCHASE_BILL', sourceRef: poId, idempotencyKey: { startsWith: `purchase-invoice:${bill.invoiceId}:` } }, select: { id: true } })
          const deleting = await tx.accountingDocumentDeletion.findFirst({ where: { documentId: bill.invoiceId, state: { in: ['PENDING', 'NEEDS_REVIEW'] } }, select: { id: true } })
          if (!now || now.fxRateSource !== null || now.accountingInvoiceId !== bill.xero!.invoiceId || posted || (deleting && !bill.exclusion) || nonImsBillFingerprint(now) !== bill.billFingerprint) {
            throw new ConfirmMismatch(`bill ${bill.invoiceNumber ?? bill.invoiceId}: it changed since it was listed (posted, re-linked, edited or being deleted); run the dry run again`)
          }
          // A re-confirmation replaces the earlier confirmation and its basis (MED-5).
          if (bill.reconfirmation) {
            // #1164 LOW-10: the confirmation it replaces is kept, as it was, in the history (the live table holds one per bill).
            const previous = await tx.purchaseFxNonImsBillApproval.findUnique({ where: { invoiceId: bill.invoiceId } })
            if (previous) {
              await tx.purchaseFxNonImsBillApprovalHistory.create({
                data: { approvalId: previous.id, poId: previous.poId, invoiceId: previous.invoiceId, snapshot: JSON.parse(JSON.stringify(previous)) as Prisma.InputJsonValue, supersededBy: params.by.trim() },
              })
              await tx.purchaseFxNonImsBillApproval.delete({ where: { id: previous.id } })
            }
          }
          // The Xero answer read in this run is stored with the confirmation (it is not read again), with the basis frozen.
          await tx.purchaseFxNonImsBillApproval.create({
            data: {
              poId, invoiceId: bill.invoiceId, approvedBy: params.by.trim(), reason: params.reason.trim(), proposedTransitDelta: expected(bill),
              xeroInvoiceId: bill.xero!.invoiceId, xeroCurrencyRate: bill.xero!.currencyRate, xeroTransitBase: bill.basis.xeroTransitBase, stockTransitBase: bill.basis.stockTransitBase,
              stockUnits: bill.stockUnits, billFingerprint: bill.billFingerprint, xeroTenantId: bill.xeroTenantId,
            },
          })
          await logActivityInTransaction(tx, {
            userId: null,
            entityType: 'PURCHASE_ORDER',
            entityId: poId,
            action: 'purchase_fx_non_ims_bill_confirmed',
            tag: 'accounting',
            level: 'WARNING',
            description: `${params.by.trim()} confirmed bill ${bill.invoiceNumber ?? bill.invoiceId} of ${bill.poReference} (posted to Xero outside IMS: ${bill.noTransitRowReason}) for the one-off exchange-rate `
              + `difference journal, measured on Xero bill ${bill.xero!.invoiceId} at ${bill.basis.rate} (goods ${bill.basis.stockTransitBase} in transit; journal now ${expected(bill)}; `
              + `${bill.notReceived.qty} not received yet, covered by later receipts): ${params.reason.trim()}. Authority assumed from shell access (the command has no session).`,
            metadata: { invoiceId: bill.invoiceId, by: params.by.trim(), reason: params.reason.trim(), basis: bill.basis, notReceived: bill.notReceived, proposedTransitDelta: expected(bill), authority: 'cli-confirm-admin' },
          })
        }
        // Under the lock: what the reconciliation queues for these bills must be what the admin was shown.
        const reconciled = await reconcilePurchaseBillFx(tx, { poId, connector: settings.connector, syncEnabled: settings.syncEnabled, at: new Date() })
        for (const bill of bills) {
          // MED-4: what the reconciliation settled for the bill: queued, declined (still owed), or the take-back of an earlier shadow. A NEW shadow is not
          // settled (#1164 MED-1: that journal would be lost), so it mismatches and rolls the order back.
          const settled = [...reconciled.journals, ...(reconciled.shadowed ?? []).filter((x) => x.reversal), ...reconciled.notQueued].filter((j) => j.invoiceId === bill.invoiceId)
          const actual = settled.reduce((sum, j) => sum.add(j.transitDelta), zero()).toFixed(2)
          if (actual !== toDecimal(expected(bill)).toFixed(2)) {
            throw new ConfirmMismatch(`bill ${bill.invoiceNumber ?? bill.invoiceId}: the journal under the lock is ${actual}, not the ${expected(bill)} shown`)
          }
        }
        return reconciled
      }, { timeout: 60_000, maxWait: 10_000 })
    } catch (error) {
      out.failed.push({ poReference: bills[0]!.poReference, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    // Committed: the confirmation stands whatever the report below does.
    for (const bill of bills) out.confirmed.push({ invoiceId: bill.invoiceId, invoiceNumber: bill.invoiceNumber, poReference: bill.poReference, proposedTransitDelta: expected(bill) })
    out.journals.push(...result.journals.filter((j) => ids.has(j.invoiceId)))
    out.notQueued += result.notQueued.filter((n) => ids.has(n.invoiceId)).length
    out.shadowed += (result.shadowed ?? []).filter((n) => ids.has(n.invoiceId)).length
    try {
      await reportPurchaseFxVarianceNotQueued(poId, bills[0]!.poReference, result)
    } catch (error) {
      out.reportFailed.push({ poReference: bills[0]!.poReference, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}
