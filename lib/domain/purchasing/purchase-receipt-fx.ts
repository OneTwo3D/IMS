import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { getFxRateToBase, isMissingFxRateError } from '@/lib/currencies/fx-lookup'
import type { PrepaymentReadDeps, XeroSupplierPrepayment } from '@/lib/connectors/xero/prepayments'
import { headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'
import { billNetPayableForeign, type NetPayableLine } from '@/lib/domain/purchasing/bill-net-payable'
import { currencyMinorUnit, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'
import { PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY, REALISED_FX_ACCOUNT_KEY } from '@/lib/domain/settings/system-switches'

/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 2 (o3d-hqvrp.51): the rate a foreign purchase order's GOODS are received at, and the ONE helper every
 * receipt path values them with (the manual receipt, the WMS book-in and the WMS align-up). Behind `purchase_event_fx_rates_enabled`; while it is
 * off, or for an order in the base currency, `resolveReceiptFxValuation` answers null and the caller values exactly as before (the PO rate).
 *
 * THE RULE (owner's final workflow, 2026-11-22). Every supplier purchase is prepaid, and the owner records the payment in Xero as Spend Money >
 * Prepayment at the exact bank rate, with the PO number as its Reference. IMS reads that prepayment READ-ONLY and locks the order's goods at its
 * rate (`purchase_order_fx_locks`). With no prepayment the goods are valued at the fx_rates (Aelia) rate in force at the receipt; a missing rate
 * refuses the receipt and nothing is written. A prepayment IMS cannot attribute to this order without guessing (several for one reference, a
 * different currency, a different supplier contact, a supplier not linked to its Xero contact) refuses too, and so does a Xero read that fails:
 * an unanswered question is never read as "no prepayment".
 *
 * TWO HALVES, because a network call must never run inside a stock transaction:
 *  - `preparePurchaseReceiptFx` (BEFORE the transaction): per order, asks Xero at most once PER RECEIPT RUN (never per line), and not at all when the
 *    answer is already known: a lock a receipt has used, a lock read a moment ago, or a "no prepayment" answer inside its cache window. It returns what it
 *    established for each order (`PrepaymentChecks`). A lock no receipt has used yet is RE-READ before the first receipt (the prepayment may have been
 *    voided and re-entered since it was read) and replaced or removed under the purchase_orders row lock.
 *  - `resolveReceiptFxValuation` (INSIDE the transaction, after the purchase_orders row lock): re-reads the switch, the order and its lock on the
 *    transaction, and values the goods. With no lock it needs this run's evidence that Xero was asked and held none; without that evidence (the switch
 *    was turned on between the two halves) it refuses, and the caller retries.
 *
 * A PREPAYMENT RECORDED AFTER EARLIER RECEIPTS (owner ruling 2026-11-26, MED-7) applies to LATER receipts only. Earlier receipts keep the rate they were
 * valued at (the table rate: each receipt stores its own rate and source), and nothing revalues them.
 *
 * THE XERO REQUEST BUDGET (step-2 review round 2, MED-A/MED-B). A "no prepayment" answer stands for an automatic receipt (a WMS book-in or alignment)
 * only while it is at most 15 minutes old (`NO_PREPAYMENT_FRESH_MS`): a prepayment recorded since an older read is never missed by a fallback receipt.
 * A manual receipt and a bill always ask (`cache: 'manual'`). The hourly alignment sweep shares one memo across all its products
 * (`PurchaseFxSweepMemo`), so each order is asked at most once per sweep however many products it carries; and an order whose prepayment could not be
 * established is not asked again by an automatic receipt for a while (`REFUSED_RECHECK_MS`, remembered on the order, MED-5). The notice of a fallback receipt says when Xero was asked.
 *
 * THE GOODS UNIT COST. `unitCostForeign` (the line's net cost per stock unit: after the line discount and VAT extraction, in the order's currency)
 * x the order's header-discount factor (read from the FOREIGN totals, `subtotalForeign / SUM(line.totalForeign)`, the same function as the base
 * one) / the rate, 6dp HALF_UP. Exact Decimal throughout; the freight share is added by the one allocation (`goodsUnitCostBase` on its lines).
 *
 * MED-2 (step-1 review): while the switch is on and Xero sync is on, the valuation refuses if the realised FX or the purchase price variance account
 * is blank. Turning the switch on is refused in that state; this closes the other direction (an account cleared, or Xero sync turned on, after).
 */

export const PURCHASE_FX_SOURCE_XERO_PREPAYMENT = 'XERO_PREPAYMENT' as const
export const PURCHASE_FX_SOURCE_FX_TABLE = 'FX_TABLE' as const
export type PurchaseFxSource = typeof PURCHASE_FX_SOURCE_XERO_PREPAYMENT | typeof PURCHASE_FX_SOURCE_FX_TABLE

/**
 * A refusal the operator can act on: the receipt is not made, nothing is written. `transient` = nothing about the ORDER is wrong, the answer was just
 * not available (Xero could not be read, its request budget is spent, a rate is missing, a mapping is blank): a WMS book-in waits and tries again without
 * spending its retry ladder, exactly as for a login refusal. A refusal that is NOT transient (an ambiguous or foreign prepayment) is real ambiguity that
 * only a person resolves, and counts toward the ladder.
 */
export class PurchaseFxRefusalError extends Error {
  readonly transient: boolean
  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message)
    this.name = 'PurchaseFxRefusalError'
    this.transient = options.transient === true
  }
}

export function isPurchaseFxRefusalError(error: unknown): error is PurchaseFxRefusalError {
  return error instanceof PurchaseFxRefusalError
}

/**
 * MED-4: a refusal that is only "the answer is not available yet" (Xero unreadable or out of budget, a rate the feed has not delivered for that
 * instant yet). MED-C: a blank mapping, or a currency the exchange-rate feed has NEVER delivered, is configuration and is not transient; and a raw
 * missing-rate error from anywhere else is not this module's to classify.
 */
export function isTransientPurchaseFxRefusal(error: unknown): error is PurchaseFxRefusalError {
  return error instanceof PurchaseFxRefusalError && error.transient
}

/** The fx_rates rate at `asOf`, or a refusal: transient when the feed carries the currency (a later row exists), not when it never has. */
async function tableRateOrRefuse(
  tx: ValuationClient,
  params: { currency: string; asOf: Date; baseCurrency: string; reference: string },
): Promise<{ rate: Prisma.Decimal | string | number }> {
  try {
    return await getFxRateToBase(tx, { currency: params.currency, asOf: params.asOf, baseCurrency: params.baseCurrency })
  } catch (error) {
    if (!isMissingFxRateError(error)) throw error
    const fed = await tx.fxRate.findFirst({ where: { fromCurrency: params.baseCurrency, toCurrency: params.currency }, select: { id: true } })
    throw new PurchaseFxRefusalError(
      fed
        ? `There is no ${params.currency} exchange rate at ${params.asOf.toISOString()} in the exchange-rate table yet, and Xero holds no prepayment for ${params.reference}. `
          + 'Nothing was received; it is tried again once the rate arrives.'
        : `The exchange-rate table has never held a ${params.currency} rate, and Xero holds no prepayment for ${params.reference}. Nothing was received. `
          + `Add ${params.currency} to the exchange-rate feed (Aelia), or give the order a Xero supplier prepayment with the Reference ${params.reference}; then receive the goods.`,
      { transient: Boolean(fed) },
    )
  }
}

/** What the pre-transaction half established for one order. */
export type PrepaymentCheck =
  /** A lock row exists (it was there, or this run stored it). */
  | { kind: 'locked' }
  /** Xero was asked (in this run, or at `checkedAt` within the freshness window: `cached`) and holds no live supplier prepayment with this order's reference. */
  | { kind: 'no_prepayment'; checkedAt: Date; cached: boolean }
  /** Xero sync is off: there is no ledger to hold a prepayment, so the fx_rates rule applies. */
  | { kind: 'xero_not_in_use' }
  /** MED-3: this order's prepayment could not be established. Only a receipt that actually values THIS order's goods refuses with it. */
  | { kind: 'refused'; reason: string; transient: boolean }
export type PrepaymentChecks = ReadonlyMap<string, PrepaymentCheck>

export const NO_PREPAYMENT_CHECKS: PrepaymentChecks = new Map()

/** The pure matching rule: exactly one live supplier prepayment, for this supplier's Xero contact, in this order's currency. */
export type PrepaymentMatch =
  | { kind: 'found'; prepayment: XeroSupplierPrepayment }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }

export function matchSupplierPrepayment(params: {
  poReference: string
  poCurrency: string
  /** The supplier's Xero contact id, or null when the supplier is not linked to a contact of the organisation that answered. */
  supplierContactId: string | null
  prepayments: readonly XeroSupplierPrepayment[]
}): PrepaymentMatch {
  const { prepayments } = params
  if (prepayments.length === 0) return { kind: 'none' }
  if (prepayments.length > 1) {
    return {
      kind: 'refused',
      reason: `${prepayments.length} Xero supplier prepayments carry the reference ${params.poReference} (${prepayments.map((p) => p.prepaymentId).join(', ')}). `
        + 'IMS does not choose between them: check them in Xero and keep one prepayment per purchase order (void or re-reference the others), then retry.',
    }
  }
  const prepayment = prepayments[0]!
  if (prepayment.currencyCode !== params.poCurrency.trim().toUpperCase()) {
    return {
      kind: 'refused',
      reason: `The Xero prepayment ${prepayment.prepaymentId} for ${params.poReference} is in ${prepayment.currencyCode}, but the order is in `
        + `${params.poCurrency}. Correct the prepayment (or the order) in one place, then retry.`,
    }
  }
  if (!params.supplierContactId) {
    return {
      kind: 'refused',
      reason: `IMS cannot check that the Xero prepayment ${prepayment.prepaymentId} for ${params.poReference} was paid to the order's supplier: the supplier is `
        + 'not linked to a Xero contact of this organisation, and no Xero contact with the supplier\'s email or exact name was found. '
        + 'There is no screen to set the link by hand: make the Xero contact\'s name (or email) exactly the supplier\'s name (or email) in IMS, then retry.',
    }
  }
  if (prepayment.contactId !== params.supplierContactId) {
    return {
      kind: 'refused',
      reason: `The Xero prepayment ${prepayment.prepaymentId} for ${params.poReference} was paid to a different contact (${prepayment.contactId}) than `
        + `the order's supplier (${params.supplierContactId}). Check the prepayment in Xero and correct its contact or reference, then retry.`,
    }
  }
  return { kind: 'found', prepayment }
}

type SettingClient = { setting: Pick<Prisma.TransactionClient['setting'], 'findUnique'> }

async function settingValue(client: SettingClient, key: string): Promise<string | null> {
  const row = await client.setting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? null
}

async function xeroSyncIsOn(client: SettingClient): Promise<boolean> {
  return (await settingValue(client, 'xero_sync_enabled')) === 'true'
}

/** MED-2: the refusal, or null. Only while Xero sync is on (the same condition the switch's turn-on refusal uses). */
export async function purchaseFxAccountsRefusal(client: SettingClient): Promise<string | null> {
  if (!(await xeroSyncIsOn(client))) return null
  const missing: string[] = []
  if (!(await settingValue(client, REALISED_FX_ACCOUNT_KEY))?.trim()) missing.push(`Realised FX Gain/Loss (${REALISED_FX_ACCOUNT_KEY})`)
  if (!(await settingValue(client, PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY))?.trim()) missing.push(`Purchase Price Variance (${PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY})`)
  if (missing.length === 0) return null
  return `Per-event FX rates for purchasing are on and Xero sync is on, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not mapped. `
    + 'Nothing was received. Map the account(s) under Sync > Accounting settings, or turn purchase_event_fx_rates_enabled off, then retry.'
}

type PoForPrepayment = {
  id: string
  reference: string
  currency: string
  fxNoPrepaymentCheckedAt: Date | null
  fxPrepaymentRefusedAt: Date | null
  fxPrepaymentRefusedUntil: Date | null
  fxPrepaymentRefusedReason: string | null
  fxPrepaymentRefusedTransient: boolean | null
  supplier: { id: string; name: string; email: string | null; accountingContactId: string | null; accountingContactProvenance: string | null }
}

async function loadPoForPrepayment(poId: string): Promise<PoForPrepayment | null> {
  return db.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true, reference: true, currency: true, fxNoPrepaymentCheckedAt: true,
      fxPrepaymentRefusedAt: true, fxPrepaymentRefusedUntil: true, fxPrepaymentRefusedReason: true, fxPrepaymentRefusedTransient: true,
      supplier: { select: { id: true, name: true, email: true, accountingContactId: true, accountingContactProvenance: true } },
    },
  })
}

/** The supplier's Xero contact id, only if it was issued by the organisation that answered the read (provenance `xero:<tenant>`). */
async function supplierContactFor(po: PoForPrepayment, tenantId: string): Promise<string | null> {
  const contactId = po.supplier.accountingContactId?.trim()
  if (!contactId) return null
  const { accountingIdProvenanceFor, accountingIdProvenanceMatches } = await import('@/lib/connectors/accounting-id-provenance')
  if (!accountingIdProvenanceMatches(po.supplier.accountingContactProvenance, accountingIdProvenanceFor('xero', tenantId))) return null
  return contactId
}

/**
 * MED-6: the supplier has no link to a Xero contact of the organisation that answered. Nothing in IMS sets that link by hand (only a posted bill or a
 * contact sync does), so instead of refusing every prepaid receipt of a new supplier the contact is resolved through the Xero contacts module, READ-ONLY
 * (the supplier's email, then its exact name; never a create). When that contact IS the one the prepayment was paid to, the link is confirmed and stored.
 */
async function confirmSupplierContactLink(
  po: PoForPrepayment,
  prepayment: XeroSupplierPrepayment,
  tenantId: string,
): Promise<{ ok: true; contactId: string | null } | { ok: false; error: string }> {
  const { findXeroContactReadOnly, storeContactId } = await import('@/lib/connectors/xero/contacts')
  const found = await findXeroContactReadOnly(po.supplier.name, po.supplier.email, { supplierId: po.supplier.id })
  if (!found.success) return { ok: false, error: `the supplier's Xero contact could not be read: ${found.error}` }
  if (!found.contactId) return { ok: true, contactId: null }
  if (found.contactId === prepayment.contactId && (found.tenantId === undefined || found.tenantId === tenantId)) {
    await storeContactId(found.contactId, tenantId, { supplierId: po.supplier.id })
  }
  return { ok: true, contactId: found.contactId }
}

export type PrepaymentLockData = {
  currency: string
  rateToBase: Prisma.Decimal
  xeroPrepaymentId: string
  xeroTenantId: string
  xeroContactId: string
  prepaymentDate: Date
  prepaymentTotal: Prisma.Decimal
  prepaymentStatus: string
}

function lockDataFor(prepayment: XeroSupplierPrepayment, tenantId: string): PrepaymentLockData {
  return {
    currency: prepayment.currencyCode,
    rateToBase: prepayment.currencyRate,
    xeroPrepaymentId: prepayment.prepaymentId,
    xeroTenantId: tenantId,
    xeroContactId: prepayment.contactId,
    prepaymentDate: new Date(`${prepayment.date}T00:00:00.000Z`),
    prepaymentTotal: prepayment.total.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
    prepaymentStatus: prepayment.status,
  }
}

/** Ask Xero once for one order and match the answer. A failed read is an error (always transient), never `none`. */
export async function lookUpPurchaseOrderPrepayment(
  po: PoForPrepayment,
  deps?: PrepaymentReadDeps,
): Promise<{ ok: true; match: PrepaymentMatch; tenantId: string } | { ok: false; error: string }> {
  // Imported where it is used: the receipt action's module graph (which every purchase-order test loads) never pulls in the Xero client.
  const { readXeroSupplierPrepaymentsByReference } = await import('@/lib/connectors/xero/prepayments')
  const read = await readXeroSupplierPrepaymentsByReference(po.reference, deps)
  if (!read.ok) return { ok: false, error: read.error }
  let supplierContactId = await supplierContactFor(po, read.tenantId)
  const only = read.prepayments.length === 1 ? read.prepayments[0]! : null
  if (!supplierContactId && only && only.currencyCode === po.currency.trim().toUpperCase()) {
    const confirmed = await confirmSupplierContactLink(po, only, read.tenantId)
    if (!confirmed.ok) return { ok: false, error: confirmed.error }
    // A contact that is NOT the prepayment's is still passed on: the matcher then names the mismatch.
    supplierContactId = confirmed.contactId
  }
  return {
    ok: true,
    tenantId: read.tenantId,
    match: matchSupplierPrepayment({
      poReference: po.reference,
      poCurrency: po.currency,
      supplierContactId,
      prepayments: read.prepayments,
    }),
  }
}

/**
 * MED-A: how old a "no prepayment" answer may be for an AUTOMATIC receipt to lay goods at the table rate on it. Older, Xero is asked again first, so a
 * prepayment recorded after an earlier read (an hourly pre-read, another receipt) is never missed. Manual receipts and bills always ask.
 */
export const NO_PREPAYMENT_FRESH_MS = 15 * 60 * 1000
/** MED-1: a lock read this recently is not read again before its first receipt (an operator's own "Read from Xero" a moment ago counts). */
export const UNUSED_LOCK_FRESH_MS = 5 * 60 * 1000
/**
 * MED-B: an order whose prepayment could not be established is not asked again by an AUTOMATIC receipt for this long (a manual receipt, a bill and
 * "Read from Xero" always ask). A failed read waits less than real ambiguity, which only a person resolves.
 *
 * Step 3b, MED-5: the remembered refusal is kept ON THE ORDER (`purchase_orders.fx_prepayment_refused_*`), not in process memory, so every process
 * (the web app, the cron runner, the WMS worker) waits the same window; and it yields to anything newer: a lock read after it (an operator's "Read
 * from Xero", another receipt's read) or a newer "no prepayment" answer. It is written and cleared with raw SQL so the order's `updatedAt` does not move.
 */
export const REFUSED_RECHECK_MS = { transient: 15 * 60 * 1000, ambiguous: 60 * 60 * 1000 } as const

/** TESTS ONLY: forget the remembered refusals. */
export async function clearPurchaseFxRefusalMemoryForTests(): Promise<void> {
  await db.$executeRaw`UPDATE purchase_orders SET fx_prepayment_refused_at = NULL, fx_prepayment_refused_until = NULL, fx_prepayment_refused_reason = NULL, fx_prepayment_refused_transient = NULL WHERE fx_prepayment_refused_at IS NOT NULL`
}

/** The order's remembered refusal, if it still stands: inside its window, and nothing newer has been learnt about the order since. */
async function rememberedRefusal(po: PoForPrepayment, now: Date): Promise<Extract<PrepaymentCheck, { kind: 'refused' }> | null> {
  if (!po.fxPrepaymentRefusedAt || !po.fxPrepaymentRefusedUntil || po.fxPrepaymentRefusedUntil.getTime() <= now.getTime()) return null
  const refusedAt = po.fxPrepaymentRefusedAt.getTime()
  if (po.fxNoPrepaymentCheckedAt && po.fxNoPrepaymentCheckedAt.getTime() > refusedAt) return null
  const lock = await db.purchaseOrderFxLock.findUnique({ where: { poId: po.id }, select: { readAt: true } })
  if (lock && lock.readAt.getTime() > refusedAt) return null
  return { kind: 'refused', reason: po.fxPrepaymentRefusedReason ?? 'The Xero supplier prepayment could not be established.', transient: po.fxPrepaymentRefusedTransient === true }
}

async function rememberRefusal(poId: string, check: Extract<PrepaymentCheck, { kind: 'refused' }>, now: Date): Promise<void> {
  const until = new Date(now.getTime() + (check.transient ? REFUSED_RECHECK_MS.transient : REFUSED_RECHECK_MS.ambiguous))
  await db.$executeRaw`UPDATE purchase_orders SET fx_prepayment_refused_at = ${now}, fx_prepayment_refused_until = ${until}, fx_prepayment_refused_reason = ${check.reason}, fx_prepayment_refused_transient = ${check.transient} WHERE id = ${poId}`
}

async function forgetRefusal(po: PoForPrepayment): Promise<void> {
  if (!po.fxPrepaymentRefusedAt) return
  await db.$executeRaw`UPDATE purchase_orders SET fx_prepayment_refused_at = NULL, fx_prepayment_refused_until = NULL, fx_prepayment_refused_reason = NULL, fx_prepayment_refused_transient = NULL WHERE id = ${po.id}`
}

/** MED-B: one memo per alignment sweep, shared by every product it aligns, so an order is asked at most once per sweep. */
export type PurchaseFxSweepMemo = Map<string, PrepaymentCheck>
export function newPurchaseFxSweepMemo(): PurchaseFxSweepMemo {
  return new Map()
}

type AnswerOutcome =
  | { kind: 'locked'; changed: boolean; replaced: boolean; lock: PrepaymentLockData }
  | { kind: 'none'; removedUnusedLock: boolean }
  /** A lock a receipt has valued goods at stands whatever Xero now says; `reason` says what Xero said. */
  | { kind: 'kept_used'; reason: string; lockId: string; prepaymentId: string; rateToBase: Prisma.Decimal }

/**
 * THE ONE PLACE A XERO ANSWER BECOMES (OR CHANGES, OR REMOVES) A LOCK. Runs in its own transaction under the purchase_orders row lock every receipt
 * takes first, so it serialises with receipts, with the on-demand read and with another lazy read of the same order:
 *  - a found prepayment is stored as the lock, replacing a lock no receipt has used yet (LOW-1: this insert used to run without the row lock, so it
 *    could race the on-demand create into a unique violation); a lock a receipt has already valued goods at is NEVER replaced;
 *  - no prepayment removes an unused lock, and stamps the order's "no prepayment" cache (`fx_no_prepayment_checked_at`, MED-2); a found prepayment
 *    clears the stamp.
 * The stamp is written with raw SQL so the order's `updatedAt` is not moved by a cache write.
 */
async function applyPrepaymentAnswerUnderLock(
  po: PoForPrepayment,
  found: PrepaymentLockData | null,
  ctx: { userId: string | null; now: Date },
): Promise<AnswerOutcome> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.id} FOR UPDATE`
    const existing = await tx.purchaseOrderFxLock.findUnique({ where: { poId: po.id } })
    if (!found) {
      await tx.$executeRaw`UPDATE purchase_orders SET fx_no_prepayment_checked_at = ${ctx.now} WHERE id = ${po.id}`
      if (existing && !existing.firstUsedAt) {
        await tx.purchaseOrderFxLock.delete({ where: { id: existing.id } })
        return { kind: 'none', removedUnusedLock: true } as const
      }
      if (existing) {
        return {
          kind: 'kept_used',
          lockId: existing.id,
          prepaymentId: existing.xeroPrepaymentId,
          rateToBase: new Prisma.Decimal(existing.rateToBase),
          reason: `Xero no longer holds a live prepayment for ${po.reference}, but receipts were already valued at the locked prepayment `
            + `${existing.xeroPrepaymentId} (${existing.rateToBase.toString()}). The lock is kept; check the prepayment in Xero.`,
        } as const
      }
      return { kind: 'none', removedUnusedLock: false } as const
    }
    if (po.fxNoPrepaymentCheckedAt) await tx.$executeRaw`UPDATE purchase_orders SET fx_no_prepayment_checked_at = NULL WHERE id = ${po.id}`
    if (!existing) {
      await tx.purchaseOrderFxLock.create({ data: { poId: po.id, source: PURCHASE_FX_SOURCE_XERO_PREPAYMENT, ...found, readAt: ctx.now, readById: ctx.userId } })
      await warnOnPrepaymentTotalMismatch(tx, po, found, ctx.userId)
      return { kind: 'locked', changed: true, replaced: false, lock: found } as const
    }
    const same = existing.xeroPrepaymentId === found.xeroPrepaymentId && new Prisma.Decimal(existing.rateToBase).eq(found.rateToBase)
      && existing.currency === found.currency
    if (existing.firstUsedAt) {
      if (same) return { kind: 'locked', changed: false, replaced: false, lock: found } as const
      return {
        kind: 'kept_used',
        lockId: existing.id,
        prepaymentId: existing.xeroPrepaymentId,
        rateToBase: new Prisma.Decimal(existing.rateToBase),
        reason: `Receipts of ${po.reference} were already valued at the locked prepayment ${existing.xeroPrepaymentId} (${existing.rateToBase.toString()}); `
          + `Xero now holds ${found.xeroPrepaymentId} (${found.rateToBase.toString()}). The lock is kept and never revalued; check the prepayment in Xero.`,
      } as const
    }
    await tx.purchaseOrderFxLock.update({ where: { id: existing.id }, data: { ...found, readAt: ctx.now, readById: ctx.userId } })
    // Warned when the stored prepayment (or its total) is new, not on every re-read of the same one.
    if (existing.xeroPrepaymentId !== found.xeroPrepaymentId || !new Prisma.Decimal(existing.prepaymentTotal).eq(found.prepaymentTotal)) {
      await warnOnPrepaymentTotalMismatch(tx, po, found, ctx.userId)
    }
    return { kind: 'locked', changed: !same, replaced: !same, lock: found } as const
  })
}

/**
 * #1142 LOW-2 / #1173 MED-1: what the order says is owed to the supplier, foreign currency, to compare a prepayment with. It is the order's
 * `totalForeign` (goods net of line and header discount, the supplier's additional costs, and VAT on both) LESS the VAT the buyer accounts for itself
 * under reverse charge, which the supplier is never paid:
 *  - each goods line whose tax rate is reverse charge: its net after the header discount x its rate, rounded per line, exactly as a bill's
 *    reverse-charge VAT is worked out (`billReverseChargeVatForeign`);
 *  - each vatable additional cost, when the supplier's default rate (the rate the order puts on additional costs) is reverse charge: its amount x the
 *    order's rate, the same way.
 * Pure.
 */
export function purchaseOrderNetPayableForeign(po: {
  currency: string
  totalForeign: DecimalInput
  subtotalForeign: DecimalInput
  taxRatePercent: DecimalInput | null
  lines: ReadonlyArray<{ totalForeign: DecimalInput; taxRate: { rate: DecimalInput; reverseCharge: boolean } | null }>
  freightCostLines: ReadonlyArray<{ amountForeign: DecimalInput; vatable: boolean }>
  supplierRateReverseCharge: boolean
}): Prisma.Decimal {
  const factor = headerDiscountFactorForPo({ subtotalBase: toDecimal(po.subtotalForeign), lines: po.lines.map((line) => ({ totalBase: toDecimal(line.totalForeign) })) })
  const reverseChargeLines: NetPayableLine[] = po.lines
    .filter((line) => line.taxRate?.reverseCharge === true)
    .map((line) => ({ totalForeign: toDecimal(line.totalForeign).mul(factor), taxRateValue: line.taxRate!.rate, taxReverseCharge: true }))
  if (po.supplierRateReverseCharge && po.taxRatePercent != null) {
    for (const cost of po.freightCostLines) {
      if (cost.vatable) reverseChargeLines.push({ totalForeign: cost.amountForeign, taxRateValue: po.taxRatePercent, taxReverseCharge: true })
    }
  }
  return billNetPayableForeign({ totalForeign: po.totalForeign, totalBase: 0, lines: reverseChargeLines }, po.currency)
}

/**
 * #1142 LOW-2: when a prepayment is stored as the order's lock, a WARNING (console and activity log, in the lock's transaction) if its total is not what
 * the order says is owed to the supplier (`purchaseOrderNetPayableForeign`: the order total with its additional costs, less self-accounted reverse-charge
 * VAT). #1173 LOW-4: a difference of up to ONE MINOR UNIT of the currency (0.01 GBP, 1 JPY) is rounding and is not reported. Only the order as it stands
 * when the prepayment is stored is checked (a later edit of the order is not compared again). Advisory only: the lock, the rate and every receipt are
 * exactly as without it.
 */
async function warnOnPrepaymentTotalMismatch(
  tx: Prisma.TransactionClient,
  po: PoForPrepayment,
  found: PrepaymentLockData,
  userId: string | null,
): Promise<void> {
  const order = await tx.purchaseOrder.findUnique({
    where: { id: po.id },
    select: {
      currency: true, totalForeign: true, subtotalForeign: true, taxRatePercent: true,
      lines: { select: { totalForeign: true, taxRate: { select: { rate: true, reverseCharge: true } } } },
      freightCostLines: { select: { amountForeign: true, vatable: true } },
      supplier: { select: { taxRate: { select: { reverseCharge: true } } } },
    },
  })
  if (!order) return
  const poTotal = purchaseOrderNetPayableForeign({ ...order, supplierRateReverseCharge: order.supplier.taxRate?.reverseCharge === true })
  const difference = found.prepaymentTotal.minus(poTotal)
  if (difference.abs().lte(currencyMinorUnit(order.currency))) return
  const description = `The Xero prepayment ${found.xeroPrepaymentId} locked for ${po.reference} totals ${found.prepaymentTotal.toFixed(2)} ${found.currency}, but the order `
    + `says ${poTotal.toFixed(2)} ${po.currency} is owed to the supplier (its total with additional costs, less any reverse-charge VAT; difference ${difference.toFixed(2)}). The goods rate is locked from it all the same. If it is not a `
    + 'deposit or part payment, check its amount and reference in Xero.'
  console.warn(`[purchase-fx] ${description}`)
  const { logActivityInTransaction } = await import('@/lib/activity-log')
  // Like the lock's own activity entry, not tied to a user row (the reader is in the metadata, as on the lock's read_by_id).
  await logActivityInTransaction(tx, {
    userId: null,
    entityType: 'PURCHASE_ORDER',
    entityId: po.id,
    action: 'xero_prepayment_total_mismatch',
    tag: 'purchase',
    level: 'WARNING',
    description,
    metadata: { readById: userId, xeroPrepaymentId: found.xeroPrepaymentId, prepaymentTotal: found.prepaymentTotal.toString(), poNetPayableForeign: poTotal.toString(), poTotalForeign: order.totalForeign.toString(), difference: difference.toString() },
  })
}

async function logPrepaymentLockActivity(
  po: PoForPrepayment,
  outcome: AnswerOutcome,
  how: string,
): Promise<void> {
  if (outcome.kind === 'kept_used') return
  const changed = outcome.kind === 'locked' ? outcome.changed : outcome.removedUnusedLock
  if (!changed) return
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: po.id,
    action: outcome.kind === 'locked' ? 'xero_prepayment_rate_locked' : 'xero_prepayment_rate_lock_removed',
    tag: 'purchase',
    level: 'INFO',
    description: outcome.kind === 'locked'
      ? `Locked the goods exchange rate of ${po.reference} at ${outcome.lock.rateToBase.toString()} from Xero prepayment ${outcome.lock.xeroPrepaymentId} (${outcome.lock.prepaymentDate.toISOString().slice(0, 10)}) ${how}`
      : `Removed an unused exchange-rate lock of ${po.reference}: Xero no longer holds a live prepayment for it (${how})`,
    metadata: outcome.kind === 'locked'
      ? { how, replacedUnusedLock: outcome.replaced, rateToBase: outcome.lock.rateToBase.toString(), xeroPrepaymentId: outcome.lock.xeroPrepaymentId }
      : { how, removedUnusedLock: true },
    resolveUser: false,
  })
}

export type PrepareOptions = {
  deps?: PrepaymentReadDeps
  now?: () => Date
  /**
   * MED-3: record a refusal PER ORDER (`{ kind: 'refused' }`) instead of throwing, for the callers whose receipt may touch several orders (the WMS book-in
   * and align-up). Only a receipt that actually values that order's goods then refuses; the others go through. Default: throw.
   */
  collectRefusals?: boolean
  /**
   * MED-A: 'manual' (the manual receipt and the bill) always asks Xero for an order with no lock; 'automatic' (the WMS book-in and alignment) relies on
   * a "no prepayment" answer at most `NO_PREPAYMENT_FRESH_MS` old, and on a remembered refusal. Default 'automatic'.
   */
  cache?: 'manual' | 'automatic'
  /** MED-B: the alignment sweep's memo (an answer already established in this sweep is reused). */
  memo?: PurchaseFxSweepMemo
}

type PrepareContext = { syncOn: boolean; manual: boolean; now: Date; deps?: PrepaymentReadDeps }

async function prepareOneOrder(po: PoForPrepayment, ctx: PrepareContext): Promise<PrepaymentCheck> {
  const existing = await db.purchaseOrderFxLock.findUnique({ where: { poId: po.id }, select: { id: true, firstUsedAt: true, readAt: true, currency: true } })
  // A lock a receipt has valued goods at is final: nothing to ask.
  if (existing?.firstUsedAt) return { kind: 'locked' }
  if (!ctx.syncOn) return existing ? { kind: 'locked' } : { kind: 'xero_not_in_use' }
  const currencyAgrees = existing ? existing.currency.trim().toUpperCase() === po.currency.trim().toUpperCase() : true
  // MED-1: an UNUSED lock is re-read before its first receipt (unless it was read a moment ago): the prepayment may have been voided and re-entered
  // since, and the first receipt would otherwise freeze the stale rate for ever.
  if (existing && currencyAgrees && ctx.now.getTime() - existing.readAt.getTime() < UNUSED_LOCK_FRESH_MS) return { kind: 'locked' }
  // MED-A: a "no prepayment" answer stands for an automatic receipt only while it is fresh; a manual receipt or a bill always asks.
  if (!existing && !ctx.manual && po.fxNoPrepaymentCheckedAt && ctx.now.getTime() - po.fxNoPrepaymentCheckedAt.getTime() < NO_PREPAYMENT_FRESH_MS) {
    return { kind: 'no_prepayment', checkedAt: po.fxNoPrepaymentCheckedAt, cached: true }
  }

  const looked = await lookUpPurchaseOrderPrepayment(po, ctx.deps)
  if (!looked.ok) {
    throw new PurchaseFxRefusalError(
      `Could not read the Xero supplier prepayment for ${po.reference}: ${looked.error}. Nothing was received; retry once Xero answers. `
      + '(IMS never falls back to the exchange-rate table on a read it could not complete.)',
      { transient: true },
    )
  }
  if (looked.match.kind === 'refused') throw new PurchaseFxRefusalError(`${looked.match.reason} Nothing was received.`)
  const found = looked.match.kind === 'found' ? lockDataFor(looked.match.prepayment, looked.tenantId) : null
  const outcome = await applyPrepaymentAnswerUnderLock(po, found, { userId: null, now: ctx.now })
  // LOW-9: a lock created or changed by a receipt's lazy read is as much a decision as one made on the card, so it is in the activity log too.
  await logPrepaymentLockActivity(po, outcome, existing ? 'before its first receipt (re-read of an unused lock)' : 'by a receipt (lazy read)')
  return outcome.kind === 'none' ? { kind: 'no_prepayment', checkedAt: ctx.now, cached: false } : { kind: 'locked' }
}

/**
 * BEFORE THE RECEIPT TRANSACTION. For each distinct order: nothing while the switch is off or for a base-currency order (the valuation answers null
 * for those); otherwise an answer that needs no Xero call (a used lock, a lock read a moment ago, a "no prepayment" answer inside its cache window,
 * Xero sync off), or ONE Xero read whose answer is stored under the order's row lock (see `applyPrepaymentAnswerUnderLock`). Throws
 * `PurchaseFxRefusalError` for an ambiguous prepayment or a failed read, unless `collectRefusals` records it per order.
 */
export async function preparePurchaseReceiptFx(poIds: Iterable<string>, options: PrepareOptions = {}): Promise<PrepaymentChecks> {
  const checks = new Map<string, PrepaymentCheck>()
  const ids = [...new Set(poIds)]
  if (ids.length === 0 || !(await isPurchaseEventFxEnabled(db))) return checks
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: db.organisation })).toUpperCase()
  const manual = options.cache === 'manual'
  const ctx: PrepareContext = { syncOn: await xeroSyncIsOn(db), manual, now: (options.now ?? (() => new Date()))(), deps: options.deps }
  for (const poId of ids) {
    const memoised = options.memo?.get(poId)
    if (memoised) {
      if (memoised.kind === 'refused' && !options.collectRefusals) throw new PurchaseFxRefusalError(memoised.reason, { transient: memoised.transient })
      checks.set(poId, memoised)
      continue
    }
    const po = await loadPoForPrepayment(poId)
    if (!po || po.currency.trim().toUpperCase() === baseCurrency) continue
    const remembered = manual ? null : await rememberedRefusal(po, ctx.now)
    let check: PrepaymentCheck
    if (remembered) {
      check = remembered
    } else {
      try {
        check = await prepareOneOrder(po, ctx)
        await forgetRefusal(po)
      } catch (error) {
        if (!isPurchaseFxRefusalError(error)) throw error
        check = { kind: 'refused', reason: error.message, transient: error.transient }
        await rememberRefusal(poId, check, ctx.now)
      }
    }
    options.memo?.set(poId, check)
    if (check.kind === 'refused' && !options.collectRefusals) throw new PurchaseFxRefusalError(check.reason, { transient: check.transient })
    checks.set(poId, check)
  }
  return checks
}

export type ReceiptFxValuation = {
  source: PurchaseFxSource
  /** The rate exactly as it values the goods (1 base = rate foreign). */
  rateToBase: Prisma.Decimal
  /** The rate as the 8dp audit columns (purchase_receipts / cost_layers.fx_rate_to_base) hold it. */
  storedRateToBase: Prisma.Decimal
  currency: string
  lockId: string | null
  /** The goods unit cost in base currency per order line, after the header discount, 6dp HALF_UP. */
  goodsUnitCostBaseByLine: Map<string, Prisma.Decimal>
  /** Appended to the STOCK_RECEIPT journal narration. */
  narration: string
  /**
   * MED-5: set when Xero sync is on, Xero was asked and holds no prepayment with this order's reference, so the goods were valued at the table rate.
   * The receipt still goes through; the caller tells the operator and writes the activity entry (`reportPurchaseFxFallback`).
   */
  fallbackNotice: string | null
  poId: string
  poReference: string
}

type ValuationClient = Pick<Prisma.TransactionClient, 'setting' | 'purchaseOrder' | 'purchaseOrderFxLock' | 'organisation' | 'fxRate'>

/** The goods unit cost of every line at `rateToBase`. Pure; exported for tests. */
export function goodsUnitCostsAtRate(
  po: { subtotalForeign: Prisma.Decimal | string | number; lines: ReadonlyArray<{ id: string; unitCostForeign: Prisma.Decimal | string | number; totalForeign: Prisma.Decimal | string | number }> },
  rateToBase: Prisma.Decimal,
): Map<string, Prisma.Decimal> {
  if (!rateToBase.gt(0)) throw new Error('A goods valuation rate must be positive')
  const factor = headerDiscountFactorForPo({ subtotalBase: po.subtotalForeign, lines: po.lines.map((line) => ({ totalBase: line.totalForeign })) })
  const out = new Map<string, Prisma.Decimal>()
  for (const line of po.lines) {
    out.set(line.id, new Prisma.Decimal(line.unitCostForeign).mul(factor).div(rateToBase).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP))
  }
  return out
}

/**
 * INSIDE THE RECEIPT TRANSACTION, after the caller holds the purchase_orders row lock: the valuation of this order's goods, or null (switch off, or
 * a base-currency order: value exactly as before). `at` is the receipt instant (the fx_rates fallback is the latest row at or before it). Throws
 * `PurchaseFxRefusalError` (or the lookup's `MissingFxRateError`) to refuse the whole receipt. It writes NOTHING: the caller marks the lock used with
 * `markPurchaseFxLockUsed` once it has actually laid goods at the rate (LOW-11).
 */
export async function resolveReceiptFxValuation(
  tx: ValuationClient,
  params: { poId: string; at: Date; checks: PrepaymentChecks },
): Promise<ReceiptFxValuation | null> {
  if (!(await isPurchaseEventFxEnabled(tx))) return null
  const po = await tx.purchaseOrder.findUnique({
    where: { id: params.poId },
    select: { reference: true, currency: true, subtotalForeign: true, lines: { select: { id: true, unitCostForeign: true, totalForeign: true } } },
  })
  if (!po) throw new Error(`Purchase order ${params.poId} not found`)
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: tx.organisation })).toUpperCase()
  const currency = po.currency.trim().toUpperCase()
  if (currency === baseCurrency) return null

  // MED-C: a blank mapping is configuration, not "not available yet": it does not resolve by waiting, so it is not transient.
  const accountsRefusal = await purchaseFxAccountsRefusal(tx)
  if (accountsRefusal) throw new PurchaseFxRefusalError(accountsRefusal)

  const check = params.checks.get(params.poId)
  // MED-3: this order's own refusal, raised only now that a receipt really values its goods. It also stops an unused lock a re-read could not confirm.
  if (check?.kind === 'refused') throw new PurchaseFxRefusalError(check.reason, { transient: check.transient })

  const lock = await tx.purchaseOrderFxLock.findUnique({
    where: { poId: params.poId },
    select: { id: true, currency: true, rateToBase: true, xeroPrepaymentId: true, prepaymentDate: true },
  })
  let source: PurchaseFxSource
  let rateToBase: Prisma.Decimal
  let narration: string
  let fallbackNotice: string | null = null
  if (lock) {
    if (lock.currency.trim().toUpperCase() !== currency) {
      throw new PurchaseFxRefusalError(
        `${po.reference} is now in ${currency} but its goods are locked to a ${lock.currency} Xero prepayment (${lock.xeroPrepaymentId}). Nothing was received. `
        + 'Use Read from Xero on the order: an unused lock is replaced or removed by it.',
      )
    }
    source = PURCHASE_FX_SOURCE_XERO_PREPAYMENT
    rateToBase = new Prisma.Decimal(lock.rateToBase)
    narration = `goods at the Xero prepayment rate ${rateToBase.toString()} ${currency} per ${baseCurrency} (prepayment ${lock.xeroPrepaymentId}, ${lock.prepaymentDate.toISOString().slice(0, 10)})`
  } else {
    if (!check || check.kind === 'locked') {
      throw new PurchaseFxRefusalError(
        `The Xero supplier prepayment for ${po.reference} was not read before this receipt (per-event FX rates were turned on, or its lock removed, `
        + 'while it ran). Nothing was received; retry.',
        { transient: true },
      )
    }
    const fx = await tableRateOrRefuse(tx, { currency, asOf: params.at, baseCurrency, reference: po.reference })
    source = PURCHASE_FX_SOURCE_FX_TABLE
    rateToBase = new Prisma.Decimal(fx.rate)
    narration = `goods at the exchange-rate table rate ${rateToBase.toString()} ${currency} per ${baseCurrency} (no Xero prepayment)`
    if (check.kind === 'no_prepayment') {
      fallbackNotice = `${po.reference} was received at the exchange-rate table rate (1 ${baseCurrency} = ${rateToBase.toString()} ${currency}) because Xero held no live supplier `
        + `prepayment with the Reference ${po.reference} as of ${check.checkedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${check.cached ? ' (an answer IMS had already read, less than 15 minutes old)' : ''}. `
        + `If the prepayment is recorded, check that its Reference is exactly the PO number: IMS finds it by that. `
        + 'A prepayment found later applies to LATER receipts only; this receipt keeps the table rate.'
    }
  }
  return {
    source,
    rateToBase,
    storedRateToBase: rateToBase.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP),
    currency,
    lockId: lock?.id ?? null,
    goodsUnitCostBaseByLine: goodsUnitCostsAtRate(po, rateToBase),
    narration,
    fallbackNotice,
    poId: params.poId,
    poReference: po.reference,
  }
}

/** LOW-11: the lock is "used" when goods were actually laid at its rate, not when a valuation was merely computed. Idempotent; a no-op for a table-rate valuation. */
export async function markPurchaseFxLockUsed(
  tx: Pick<Prisma.TransactionClient, 'purchaseOrderFxLock'>,
  valuation: ReceiptFxValuation | null,
  at: Date,
): Promise<void> {
  if (!valuation?.lockId) return
  await tx.purchaseOrderFxLock.updateMany({ where: { id: valuation.lockId, firstUsedAt: null }, data: { firstUsedAt: at } })
}

/**
 * MED-5: AFTER the receipt commits, tell the operator that a receipt fell back to the table rate while Xero sync is on, and write the activity entry.
 * Returns the warning for the caller to hand back (the manual receipt shows it); the WMS paths have no operator to show it to, so the log is the report.
 */
export async function reportPurchaseFxFallback(valuation: ReceiptFxValuation | null, via: string): Promise<string | null> {
  if (!valuation?.fallbackNotice) return null
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: valuation.poId,
    action: 'purchase_receipt_fx_table_rate',
    tag: 'purchase',
    level: 'WARNING',
    description: `${valuation.fallbackNotice} (${via})`,
    metadata: { via, rateToBase: valuation.rateToBase.toString(), currency: valuation.currency },
    resolveUser: false,
  })
  return valuation.fallbackNotice
}

export type OnDemandPrepaymentResult =
  | { status: 'locked'; changed: boolean; rateToBase: string; xeroPrepaymentId: string; prepaymentDate: string; earlierTableRateReceipts: number }
  | { status: 'none'; removedUnusedLock: boolean }
  | { status: 'refused'; reason: string }

/**
 * THE ON-DEMAND READ (Purchase order > Xero prepayment > Read from Xero). One Xero read; then, under the purchase_orders row lock every receipt
 * takes first, the same answer rules as a receipt's lazy read (`applyPrepaymentAnswerUnderLock`): a found prepayment is stored as the lock, replacing a
 * lock no receipt has used yet; a lock a receipt has already valued goods at is NEVER replaced, and a different answer from Xero is reported instead.
 * No prepayment removes an unused lock. A lock found now applies to LATER receipts only (MED-7): receipts already valued at the table rate keep it.
 */
export async function readPurchaseOrderPrepaymentOnDemand(
  poId: string,
  userId: string | null,
  options: { deps?: PrepaymentReadDeps; now?: () => Date } = {},
): Promise<OnDemandPrepaymentResult> {
  if (!(await isPurchaseEventFxEnabled(db))) return { status: 'refused', reason: 'Per-event FX rates for purchasing are off (purchase_event_fx_rates_enabled).' }
  const po = await loadPoForPrepayment(poId)
  if (!po) return { status: 'refused', reason: 'Purchase order not found.' }
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: db.organisation })).toUpperCase()
  if (po.currency.trim().toUpperCase() === baseCurrency) return { status: 'refused', reason: `${po.reference} is in the base currency; it has no exchange rate to lock.` }
  if (!(await xeroSyncIsOn(db))) return { status: 'refused', reason: 'Xero sync is off, so there is no Xero prepayment to read.' }
  const looked = await lookUpPurchaseOrderPrepayment(po, options.deps)
  if (!looked.ok) return { status: 'refused', reason: `Could not read the Xero supplier prepayment: ${looked.error}` }
  if (looked.match.kind === 'refused') return { status: 'refused', reason: looked.match.reason }
  const found = looked.match.kind === 'found' ? lockDataFor(looked.match.prepayment, looked.tenantId) : null
  const outcome = await applyPrepaymentAnswerUnderLock(po, found, { userId, now: (options.now ?? (() => new Date()))() })
  if (outcome.kind === 'kept_used') return { status: 'refused', reason: outcome.reason }
  if (outcome.kind === 'none') return { status: 'none', removedUnusedLock: outcome.removedUnusedLock }
  const earlierTableRateReceipts = await db.purchaseReceipt.count({ where: { poId, fxRateSource: PURCHASE_FX_SOURCE_FX_TABLE } })
    + await db.costLayer.count({ where: { poLine: { poId }, adjustmentMovementId: { not: null }, fxRateSource: PURCHASE_FX_SOURCE_FX_TABLE } })
  return {
    status: 'locked',
    changed: outcome.changed,
    rateToBase: outcome.lock.rateToBase.toString(),
    xeroPrepaymentId: outcome.lock.xeroPrepaymentId,
    prepaymentDate: outcome.lock.prepaymentDate.toISOString().slice(0, 10),
    earlierTableRateReceipts,
  }
}

export type PurchaseOrderFxView = {
  lock: { rateToBase: string; currency: string; xeroPrepaymentId: string; prepaymentDate: string; prepaymentTotal: string; readAt: string; used: boolean } | null
  /**
   * MED-7: every receipt of the order and the rate it was valued at. `source` null = valued at the PO rate (before the switch was on). MED-D: a WMS stock
   * alignment lays goods with no receipt row, so each alignment layer valued under the switch is listed too (`kind: 'alignment'`).
   */
  receipts: Array<{ id: string; kind: 'receipt' | 'alignment'; reference: string | null; receivedAt: string; rateToBase: string | null; source: PurchaseFxSource | null }>
  tableRateReceiptCount: number
  prepaymentReceiptCount: number
}

/** The order's lock and the per-receipt rates, as the purchase order page shows them. */
export async function getPurchaseOrderFxView(poId: string): Promise<PurchaseOrderFxView> {
  const [lock, receipts, alignmentLayers] = await Promise.all([
    db.purchaseOrderFxLock.findUnique({ where: { poId } }),
    db.purchaseReceipt.findMany({
      where: { poId },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, reference: true, receivedAt: true, fxRateToBase: true, fxRateSource: true },
    }),
    // MED-D: the alignment's layers (laid against an adjustment movement, never a receipt row), valued under the switch.
    db.costLayer.findMany({
      where: { poLine: { poId }, adjustmentMovementId: { not: null }, fxRateSource: { not: null } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, receivedAt: true, fxRateToBase: true, fxRateSource: true },
    }),
  ])
  const sourceOf = (value: string | null): PurchaseFxSource | null =>
    value === PURCHASE_FX_SOURCE_XERO_PREPAYMENT || value === PURCHASE_FX_SOURCE_FX_TABLE ? value : null
  const rows = [
    ...receipts.map((receipt) => ({
      id: receipt.id,
      kind: 'receipt' as const,
      reference: receipt.reference,
      receivedAt: receipt.receivedAt.toISOString(),
      rateToBase: receipt.fxRateToBase ? new Prisma.Decimal(receipt.fxRateToBase).toString() : null,
      source: sourceOf(receipt.fxRateSource),
    })),
    ...alignmentLayers.map((layer) => ({
      id: layer.id,
      kind: 'alignment' as const,
      reference: 'WMS alignment',
      receivedAt: layer.receivedAt.toISOString(),
      rateToBase: layer.fxRateToBase ? new Prisma.Decimal(layer.fxRateToBase).toString() : null,
      source: sourceOf(layer.fxRateSource),
    })),
  ].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0))
  return {
    lock: lock
      ? {
        rateToBase: new Prisma.Decimal(lock.rateToBase).toString(),
        currency: lock.currency,
        xeroPrepaymentId: lock.xeroPrepaymentId,
        prepaymentDate: lock.prepaymentDate.toISOString().slice(0, 10),
        prepaymentTotal: new Prisma.Decimal(lock.prepaymentTotal).toFixed(2),
        readAt: lock.readAt.toISOString(),
        used: lock.firstUsedAt !== null,
      }
      : null,
    receipts: rows,
    tableRateReceiptCount: rows.filter((row) => row.source === PURCHASE_FX_SOURCE_FX_TABLE).length,
    prepaymentReceiptCount: rows.filter((row) => row.source === PURCHASE_FX_SOURCE_XERO_PREPAYMENT).length,
  }
}

function lockedGoodsFor(valuation: ReceiptFxValuation, poLineId: string): Prisma.Decimal {
  const goods = valuation.goodsUnitCostBaseByLine.get(poLineId)
  if (!goods) throw new Error(`Per-event FX valuation has no goods unit cost for purchase order line ${poLineId}`)
  return goods
}

/** `createCostLayer`'s `purchaseFx` argument for one order line, or nothing (valuation null: the layer is written exactly as before). */
export function purchaseFxLayerFields(
  valuation: ReceiptFxValuation | null,
  poLineId: string,
): { purchaseFx?: { goodsUnitCostBase: Prisma.Decimal; fxRateToBase: Prisma.Decimal; fxRateSource: PurchaseFxSource } } {
  if (!valuation) return {}
  return { purchaseFx: { goodsUnitCostBase: lockedGoodsFor(valuation, poLineId), fxRateToBase: valuation.storedRateToBase, fxRateSource: valuation.source } }
}

/** The same two columns for a direct `costLayer.create` (the WMS book-in writes the row itself). */
export function purchaseFxLayerColumns(
  valuation: ReceiptFxValuation | null,
  poLineId: string,
): { goodsUnitCostBase?: string; fxRateToBase?: string; fxRateSource?: PurchaseFxSource } {
  if (!valuation) return {}
  return { goodsUnitCostBase: lockedGoodsFor(valuation, poLineId).toFixed(6), fxRateToBase: valuation.storedRateToBase.toFixed(8), fxRateSource: valuation.source }
}
