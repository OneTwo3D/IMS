/**
 * THE DATABASE RAILS: what must be true of the target before a step may write.
 *
 *   base currency   the organisation's base currency is the manifest's (the importers compare against the database, not the manifest);
 *   empty target    a FIRST run (no run record) needs a database that holds none of the business data the base currency locks on
 *                   (products, suppliers, customers, purchase orders, sales orders, stock movements) and is not locked; a RESUME does not;
 *   forbidden SKUs  none of the manifest's forbidSkus (owner rulings that exclude a product) exists in the database either: a file cannot carry them, and a
 *                   load into a database that already has one would be building on a product the owner ruled out;
 *   warehouses      every warehouse the manifest declares exists, is active, is unique under upper-casing and has exactly the declared profile;
 *   FX rates        (purchase orders) each stated rate has a stored base-to-currency rate, and is within the importer's 2% of it;
 *   tax rates       (purchase orders) every tax a line names resolves to an active purchase rate, and every order-level tax NAME exists with
 *                   exactly that spelling (createPurchaseOrder looks the order-level name up case-exactly; the importer matches lines case-insensitively).
 *
 * Evaluated before anything is written (`preflight`) and again at the start of every step and just before its first write (`recheck`). An unreadable
 * value is an ObservationError, never "fine". Problem text names a rail, a count or the position of an entry in the operator's manifest: never a value from a prepared file.
 */
import { db } from '@/lib/db'
import { PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE } from '@/lib/domain/purchasing/purchase-order-fx'
import { D } from '../../money'
import type { ApplyStepId } from '../constants'
import { normaliseTaxValue } from '../normal-form'
import type { PreparedRun } from '../prepared'
import { ObservationError } from '../residual'
import { DATABASE_READ_FAILED } from './observe'

/** The tables the base currency locks on (lib/base-currency.ts isBaseCurrencyLocked): any row in one of them means the target is not empty. */
const LOCKING_COUNTS = ['product', 'supplier', 'customer', 'purchaseOrder', 'salesOrder', 'stockMovement'] as const

export interface RailScope {
  /** 'preflight' also checks emptiness (a fresh run only); a step recheck does not, because the run's own rows are there by then. */
  phase: 'preflight' | 'recheck'
  resuming: boolean
  /** The step being rechecked; null for preflight, which checks every selected step's rails. */
  step: ApplyStepId | null
}

export async function evaluateRails(prepared: PreparedRun, scope: RailScope): Promise<string[]> {
  try {
    const problems: string[] = []
    const selected = new Set(prepared.steps.map((s) => s.step))
    const relevant = (step: ApplyStepId): boolean => selected.has(step) && (scope.step === null || scope.step === step)

    await baseCurrency(prepared, problems)
    await forbiddenSkus(prepared, problems)
    if (scope.phase === 'preflight' && !scope.resuming) await emptyTarget(problems)
    if ((relevant('opening-stock') || relevant('purchase-orders')) && Object.keys(prepared.manifest.expectWarehouses).length > 0) await warehouses(prepared, problems)
    if (relevant('purchase-orders')) {
      await fxRates(prepared, problems)
      await taxRates(prepared, problems)
    }
    return problems
  } catch (error) {
    if (error instanceof ObservationError) throw error
    throw new ObservationError(DATABASE_READ_FAILED)
  }
}

async function baseCurrency(prepared: PreparedRun, problems: string[]): Promise<void> {
  const org = await db.organisation.findFirst({ select: { baseCurrency: true } })
  // The importers fall back to GBP when there is no organisation row (lib/base-currency.ts); the rail reads it the same way.
  const stored = org?.baseCurrency ?? 'GBP'
  if (stored.toUpperCase() !== prepared.manifest.baseCurrency.toUpperCase()) problems.push('base currency: the organisation\'s base currency is not the manifest\'s')
}

async function forbiddenSkus(prepared: PreparedRun, problems: string[]): Promise<void> {
  const forbidden = prepared.manifest.forbidSkus
  if (forbidden.length === 0) return
  const found = await db.product.count({ where: { OR: forbidden.map((sku) => ({ sku: { equals: sku, mode: 'insensitive' as const } })) } })
  if (found > 0) problems.push(`forbidden SKUs: ${found} product(s) the manifest forbids already exist in the database`)
}

async function emptyTarget(problems: string[]): Promise<void> {
  const counts = await Promise.all(LOCKING_COUNTS.map(async (name) => [name, await (db[name] as { count(): Promise<number> }).count()] as const))
  const setting = await db.setting.findUnique({ where: { key: 'base_currency_locked' }, select: { value: true } })
  for (const [name, count] of counts) if (count > 0) problems.push(`empty target: the ${name} table holds ${count} row(s), and no run record says this runner loaded them`)
  if (setting?.value === 'true') problems.push('empty target: the base currency is already locked')
}

async function warehouses(prepared: PreparedRun, problems: string[]): Promise<void> {
  const rows = await db.warehouse.findMany({ select: { code: true, type: true, availableForSale: true, syncToStore: true, active: true } })
  const declared = Object.entries(prepared.manifest.expectWarehouses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  declared.forEach(([code, profile], index) => {
    const at = `warehouse ${index + 1} of ${declared.length} in expectWarehouses`
    const matches = rows.filter((w) => w.code.toUpperCase() === code)
    if (matches.length === 0) problems.push(`${at}: it does not exist in the database`)
    else if (matches.length > 1) problems.push(`${at}: ${matches.length} warehouses share that code under upper-casing`)
    else {
      const w = matches[0]
      if (!w.active) problems.push(`${at}: it is not active`)
      if (w.type !== profile.type) problems.push(`${at}: its type is not the declared one`)
      if (w.availableForSale !== profile.availableForSale) problems.push(`${at}: its availableForSale is not the declared one`)
      if (w.syncToStore !== profile.syncToStore) problems.push(`${at}: its syncToStore is not the declared one`)
    }
  })
}

async function fxRates(prepared: PreparedRun, problems: string[]): Promise<void> {
  const base = prepared.manifest.baseCurrency.toUpperCase()
  const declared = Object.entries(prepared.manifest.fxRates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const now = new Date()
  for (const [index, [currency, stated]] of declared.entries()) {
    const at = `FX rate ${index + 1} of ${declared.length} in fxRates`
    if (currency === base) continue
    const row = await db.fxRate.findFirst({ where: { fromCurrency: base, toCurrency: currency, fetchedAt: { lte: now } }, orderBy: { fetchedAt: 'desc' }, select: { rate: true } })
    if (row === null) { problems.push(`${at}: the database holds no rate for it on or before today`); continue }
    const stored = new D(row.rate.toFixed())
    if (!stored.gt(new D(0))) { problems.push(`${at}: the stored rate is not positive`); continue }
    const delta = new D(stated).minus(stored).abs().div(stored)
    if (delta.gt(new D(PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE))) problems.push(`${at}: it differs from the stored rate by more than the importer's tolerance`)
  }
}

async function taxRates(prepared: PreparedRun, problems: string[]): Promise<void> {
  const step = prepared.steps.find((s) => s.step === 'purchase-orders')
  if (!step) return
  const rates = await db.taxRate.findMany({ select: { name: true, rate: true, usedFor: true, active: true } })
  const active = rates.filter((r) => r.active)
  const eligible = active.filter((r) => r.usedFor === 'PURCHASE' || r.usedFor === 'BOTH')
  const col = (name: string): number => step.data.header.indexOf(name)
  const [nameIx, valueIx, orderNameIx, orderKeyIx] = [col('taxRateName'), col('taxRateValue'), col('orderTaxRateName'), col('orderKey')]
  let unresolvedLines = 0
  let unspelledOrders = 0
  let valueMismatchLines = 0
  let valueMismatchOrders = 0
  const sameValue = (rate: { rate: { toFixed(): string } }, stated: string): boolean => new D(rate.rate.toFixed()).eq(new D(stated))
  const firstRowOfOrder = new Set<string>()
  for (const row of step.data.rows) {
    const name = (nameIx < 0 ? '' : row.cells[nameIx] ?? '').trim()
    const valueText = valueIx < 0 ? '' : row.cells[valueIx] ?? ''
    if (name !== '' || valueText.trim() !== '') {
      const byName = name !== '' && eligible.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())
      const value = normaliseTaxValue(valueText)
      const byValue = value !== '' && eligible.some((r) => new D(r.rate.toFixed()).minus(new D(value)).abs().lt(new D('0.00005')))
      if (!byName && !byValue) unresolvedLines++
      // The importer resolves BY NAME and ignores a stated value: when the file states both, the named rate must have that value.
      const stated = normaliseTaxValue(valueText)
      if (byName && stated !== '') {
        const rate = eligible.find((r) => r.name.trim().toLowerCase() === name.toLowerCase())
        if (rate && !sameValue(rate, stated)) valueMismatchLines++
      }
    }
    const orderKey = orderKeyIx < 0 ? '' : row.cells[orderKeyIx] ?? ''
    if (firstRowOfOrder.has(orderKey)) continue
    firstRowOfOrder.add(orderKey)
    const orderName = ((orderNameIx < 0 ? '' : row.cells[orderNameIx] ?? '').trim()) || name
    if (orderName !== '' && !active.some((r) => r.name === orderName)) unspelledOrders++
    const orderValueIx = col('orderTaxRateValue')
    const orderStated = normaliseTaxValue(orderValueIx < 0 ? '' : row.cells[orderValueIx] ?? '') || normaliseTaxValue(valueText)
    const orderRate = orderName === '' ? undefined : active.find((r) => r.name === orderName)
    if (orderRate && orderStated !== '' && !sameValue(orderRate, orderStated)) valueMismatchOrders++
  }
  if (unresolvedLines > 0) problems.push(`purchase tax: ${unresolvedLines} line(s) name a tax that matches no active purchase rate`)
  if (valueMismatchLines > 0) problems.push(`purchase tax: ${valueMismatchLines} line(s) state a tax value that is not the value of the active rate they name`)
  if (valueMismatchOrders > 0) problems.push(`purchase tax: ${valueMismatchOrders} order(s) state a tax value that is not the value of the active rate they name`)
  if (unspelledOrders > 0) problems.push(`purchase tax: ${unspelledOrders} order(s) have an order-level tax name with no active rate of exactly that spelling`)
}
