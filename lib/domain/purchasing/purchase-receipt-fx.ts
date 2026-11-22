import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { getFxRateToBase } from '@/lib/currencies/fx-lookup'
import type { PrepaymentReadDeps, XeroSupplierPrepayment } from '@/lib/connectors/xero/prepayments'
import { headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'
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
 *  - `preparePurchaseReceiptFx` (BEFORE the transaction): per order, reads Xero at most ONCE (never per line), stores a found prepayment as the
 *    lock, and returns what it established for each order (`PrepaymentChecks`). An order that already has a lock costs no Xero call.
 *  - `resolveReceiptFxValuation` (INSIDE the transaction, after the purchase_orders row lock): re-reads the switch, the order and its lock on the
 *    transaction, and values the goods. With no lock it needs this run's evidence that Xero was asked and held none; without that evidence (the switch
 *    was turned on between the two halves) it refuses, and the caller retries.
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

/** A refusal the operator can act on: the receipt is not made, nothing is written. */
export class PurchaseFxRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PurchaseFxRefusalError'
  }
}

export function isPurchaseFxRefusalError(error: unknown): error is PurchaseFxRefusalError {
  return error instanceof PurchaseFxRefusalError
}

/** What the pre-transaction half established for one order. */
export type PrepaymentCheck =
  /** A lock row exists (it was there, or this run stored it). */
  | { kind: 'locked' }
  /** Xero was asked and holds no live supplier prepayment with this order's reference. */
  | { kind: 'no_prepayment' }
  /** Xero sync is off: there is no ledger to hold a prepayment, so the fx_rates rule applies. */
  | { kind: 'xero_not_in_use' }
  /** A dry run: Xero is not asked; an existing lock is used, otherwise the fx_rates rule. Nothing it computes is kept. */
  | { kind: 'preview' }
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
      reason: `The order's supplier is not linked to a contact in this Xero organisation, so IMS cannot check that the prepayment ${prepayment.prepaymentId} `
        + `for ${params.poReference} was paid to it. Link the supplier to its Xero contact (post a bill for it, or set the contact), then retry.`,
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
  supplier: { accountingContactId: string | null; accountingContactProvenance: string | null }
}

async function loadPoForPrepayment(poId: string): Promise<PoForPrepayment | null> {
  return db.purchaseOrder.findUnique({
    where: { id: poId },
    select: { id: true, reference: true, currency: true, supplier: { select: { accountingContactId: true, accountingContactProvenance: true } } },
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

/** Ask Xero once for one order and match the answer. A failed read is an error, never `none`. */
export async function lookUpPurchaseOrderPrepayment(
  po: PoForPrepayment,
  deps?: PrepaymentReadDeps,
): Promise<{ ok: true; match: PrepaymentMatch; tenantId: string } | { ok: false; error: string }> {
  // Imported where it is used: the receipt action's module graph (which every purchase-order test loads) never pulls in the Xero client.
  const { readXeroSupplierPrepaymentsByReference } = await import('@/lib/connectors/xero/prepayments')
  const read = await readXeroSupplierPrepaymentsByReference(po.reference, deps)
  if (!read.ok) return { ok: false, error: read.error }
  return {
    ok: true,
    tenantId: read.tenantId,
    match: matchSupplierPrepayment({
      poReference: po.reference,
      poCurrency: po.currency,
      supplierContactId: await supplierContactFor(po, read.tenantId),
      prepayments: read.prepayments,
    }),
  }
}

export type PrepareOptions = {
  /** Read nothing from Xero (a dry run): every foreign order is `preview`. */
  preview?: boolean
  deps?: PrepaymentReadDeps
  now?: () => Date
}

/**
 * BEFORE THE RECEIPT TRANSACTION. For each distinct order: nothing while the switch is off or for a base-currency order (the valuation answers null
 * for those); otherwise an existing lock, a `preview`, `xero_not_in_use`, or ONE Xero read. A found prepayment is stored as the lock (insert only:
 * a lock that already exists is never replaced here). Throws `PurchaseFxRefusalError` for an ambiguous prepayment or a failed read.
 */
export async function preparePurchaseReceiptFx(poIds: Iterable<string>, options: PrepareOptions = {}): Promise<PrepaymentChecks> {
  const checks = new Map<string, PrepaymentCheck>()
  const ids = [...new Set(poIds)]
  if (ids.length === 0 || !(await isPurchaseEventFxEnabled(db))) return checks
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: db.organisation })).toUpperCase()
  for (const poId of ids) {
    const po = await loadPoForPrepayment(poId)
    if (!po || po.currency.trim().toUpperCase() === baseCurrency) continue
    const existing = await db.purchaseOrderFxLock.findUnique({ where: { poId }, select: { id: true } })
    if (existing) { checks.set(poId, { kind: 'locked' }); continue }
    if (options.preview) { checks.set(poId, { kind: 'preview' }); continue }
    if (!(await xeroSyncIsOn(db))) { checks.set(poId, { kind: 'xero_not_in_use' }); continue }
    const looked = await lookUpPurchaseOrderPrepayment(po, options.deps)
    if (!looked.ok) {
      throw new PurchaseFxRefusalError(
        `Could not read the Xero supplier prepayment for ${po.reference}: ${looked.error}. Nothing was received; retry once Xero answers. `
        + '(IMS never falls back to the exchange-rate table on a read it could not complete.)',
      )
    }
    if (looked.match.kind === 'refused') throw new PurchaseFxRefusalError(`${looked.match.reason} Nothing was received.`)
    if (looked.match.kind === 'none') { checks.set(poId, { kind: 'no_prepayment' }); continue }
    const data = lockDataFor(looked.match.prepayment, looked.tenantId)
    await db.purchaseOrderFxLock.upsert({
      where: { poId },
      create: { poId, source: PURCHASE_FX_SOURCE_XERO_PREPAYMENT, ...data, readAt: (options.now ?? (() => new Date()))(), readById: null },
      update: {},
    })
    checks.set(poId, { kind: 'locked' })
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
 * `PurchaseFxRefusalError` (or the lookup's `MissingFxRateError`) to refuse the whole receipt.
 */
export async function resolveReceiptFxValuation(
  tx: ValuationClient,
  params: { poId: string; at: Date; checks: PrepaymentChecks; markLockUsed?: boolean },
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

  const accountsRefusal = await purchaseFxAccountsRefusal(tx)
  if (accountsRefusal) throw new PurchaseFxRefusalError(accountsRefusal)

  const lock = await tx.purchaseOrderFxLock.findUnique({
    where: { poId: params.poId },
    select: { id: true, currency: true, rateToBase: true, xeroPrepaymentId: true, prepaymentDate: true, firstUsedAt: true },
  })
  let source: PurchaseFxSource
  let rateToBase: Prisma.Decimal
  let narration: string
  if (lock) {
    if (lock.currency.trim().toUpperCase() !== currency) {
      throw new PurchaseFxRefusalError(
        `${po.reference} is now in ${currency} but its goods are locked to a ${lock.currency} Xero prepayment (${lock.xeroPrepaymentId}). Nothing was received.`,
      )
    }
    source = PURCHASE_FX_SOURCE_XERO_PREPAYMENT
    rateToBase = new Prisma.Decimal(lock.rateToBase)
    narration = `goods at the Xero prepayment rate ${rateToBase.toString()} ${currency} per ${baseCurrency} (prepayment ${lock.xeroPrepaymentId}, ${lock.prepaymentDate.toISOString().slice(0, 10)})`
    if (params.markLockUsed !== false && !lock.firstUsedAt) {
      await tx.purchaseOrderFxLock.update({ where: { id: lock.id }, data: { firstUsedAt: params.at } })
    }
  } else {
    const check = params.checks.get(params.poId)
    if (!check || check.kind === 'locked') {
      throw new PurchaseFxRefusalError(
        `The Xero supplier prepayment for ${po.reference} was not read before this receipt (per-event FX rates were turned on, or its lock removed, `
        + 'while it ran). Nothing was received; retry.',
      )
    }
    const fx = await getFxRateToBase(tx, { currency, asOf: params.at, baseCurrency })
    source = PURCHASE_FX_SOURCE_FX_TABLE
    rateToBase = new Prisma.Decimal(fx.rate)
    narration = `goods at the exchange-rate table rate ${rateToBase.toString()} ${currency} per ${baseCurrency} (no Xero prepayment)`
  }
  return {
    source,
    rateToBase,
    storedRateToBase: rateToBase.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP),
    currency,
    lockId: lock?.id ?? null,
    goodsUnitCostBaseByLine: goodsUnitCostsAtRate(po, rateToBase),
    narration,
  }
}

export type OnDemandPrepaymentResult =
  | { status: 'locked'; changed: boolean; rateToBase: string; xeroPrepaymentId: string; prepaymentDate: string }
  | { status: 'none'; removedUnusedLock: boolean }
  | { status: 'refused'; reason: string }

/**
 * THE ON-DEMAND READ (Purchase order > Xero prepayment > Read from Xero). One Xero read; then, under the purchase_orders row lock every receipt
 * takes first: a found prepayment is stored as the lock, replacing a lock no receipt has used yet; a lock a receipt has already valued goods at is
 * NEVER replaced (the layers already carry it), and a different answer from Xero is reported instead. No prepayment removes an unused lock.
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
  const now = (options.now ?? (() => new Date()))()
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    const existing = await tx.purchaseOrderFxLock.findUnique({ where: { poId } })
    if (!found) {
      if (existing && !existing.firstUsedAt) {
        await tx.purchaseOrderFxLock.delete({ where: { id: existing.id } })
        return { status: 'none', removedUnusedLock: true } as const
      }
      if (existing) {
        return {
          status: 'refused',
          reason: `Xero no longer holds a live prepayment for ${po.reference}, but receipts were already valued at the locked prepayment `
            + `${existing.xeroPrepaymentId} (${existing.rateToBase.toString()}). The lock is kept; check the prepayment in Xero.`,
        } as const
      }
      return { status: 'none', removedUnusedLock: false } as const
    }
    const view = { status: 'locked' as const, rateToBase: found.rateToBase.toString(), xeroPrepaymentId: found.xeroPrepaymentId, prepaymentDate: found.prepaymentDate.toISOString().slice(0, 10) }
    if (!existing) {
      await tx.purchaseOrderFxLock.create({ data: { poId, source: PURCHASE_FX_SOURCE_XERO_PREPAYMENT, ...found, readAt: now, readById: userId } })
      return { ...view, changed: true }
    }
    const same = existing.xeroPrepaymentId === found.xeroPrepaymentId && new Prisma.Decimal(existing.rateToBase).eq(found.rateToBase)
      && existing.currency === found.currency
    if (existing.firstUsedAt) {
      if (same) return { ...view, changed: false }
      return {
        status: 'refused',
        reason: `Receipts of ${po.reference} were already valued at the locked prepayment ${existing.xeroPrepaymentId} (${existing.rateToBase.toString()}); `
          + `Xero now holds ${found.xeroPrepaymentId} (${found.rateToBase.toString()}). The lock is kept and never revalued; check the prepayment in Xero.`,
      } as const
    }
    await tx.purchaseOrderFxLock.update({ where: { id: existing.id }, data: { ...found, readAt: now, readById: userId } })
    return { ...view, changed: !same }
  })
}

/** The lock as the purchase order page shows it (null = none). */
export async function getPurchaseOrderFxLockView(poId: string): Promise<{
  rateToBase: string; currency: string; xeroPrepaymentId: string; prepaymentDate: string; prepaymentTotal: string; readAt: string; used: boolean
} | null> {
  const lock = await db.purchaseOrderFxLock.findUnique({ where: { poId } })
  if (!lock) return null
  return {
    rateToBase: new Prisma.Decimal(lock.rateToBase).toString(),
    currency: lock.currency,
    xeroPrepaymentId: lock.xeroPrepaymentId,
    prepaymentDate: lock.prepaymentDate.toISOString().slice(0, 10),
    prepaymentTotal: new Prisma.Decimal(lock.prepaymentTotal).toFixed(2),
    readAt: lock.readAt.toISOString(),
    used: lock.firstUsedAt !== null,
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
): { purchaseFx?: { goodsUnitCostBase: Prisma.Decimal; fxRateToBase: Prisma.Decimal } } {
  if (!valuation) return {}
  return { purchaseFx: { goodsUnitCostBase: lockedGoodsFor(valuation, poLineId), fxRateToBase: valuation.storedRateToBase } }
}

/** The same two columns for a direct `costLayer.create` (the WMS book-in writes the row itself). */
export function purchaseFxLayerColumns(
  valuation: ReceiptFxValuation | null,
  poLineId: string,
): { goodsUnitCostBase?: string; fxRateToBase?: string } {
  if (!valuation) return {}
  return { goodsUnitCostBase: lockedGoodsFor(valuation, poLineId).toFixed(6), fxRateToBase: valuation.storedRateToBase.toFixed(8) }
}
