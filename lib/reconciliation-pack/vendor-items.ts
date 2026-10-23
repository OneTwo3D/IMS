/**
 * ITEMS R9 AND R13: THE VENDOR ITEMS (WooCommerce), BEHIND AN EXPLICIT OPT-IN.
 *
 * Both compare IMS with the storefront by identity, from the proven walks of lib/reconciliation-pack/woo-source.ts and the IMS read of
 * lib/reconciliation-pack/ims-readers.ts (one REPEATABLE READ snapshot). Neither runs unless the run was started with
 * --vendor-reads-only: without it the item is inconclusive VENDOR_READS_OFF, NO port is touched and NO request is made. The module is
 * total: whatever it is handed it returns an item and never throws; whatever cannot be proven is inconclusive with closed reasons.
 *
 *   R9   OPEN SALES ORDERS, BY WOOCOMMERCE ORDER ID. IMS side: every sales order in an open IMS status (PENDING_PAYMENT, ON_HOLD,
 *        PROCESSING, ALLOCATED, PICKING, PACKING) that has a recorded WooCommerce order id; an open order without one is listed as out
 *        of the population (NO_STOREFRONT_LINK), never compared. Vendor side: the orders in the statuses the importer ADMITS
 *        (wc_sync_order_statuses; absent means its default) whose effective reading (a mapping row, else the connector's built-in
 *        table) is an open IMS status, read as two full sweeps of every status. A status the importer admits that has no reading is
 *        UNKNOWN_STATUS (the whole item). The SET must be exact; the VALUE (the order total, in the order's own currency) must agree
 *        within one minor unit of that currency (owner decision D1), and a currency that differs is a difference. An identity on
 *        both sides is always judged. A storefront order the store holds and IMS does not is judged only if the recorded boundaries put
 *        it in the population (created at or after the recorded initial import, inside the recorded retention horizon); a boundary with
 *        no record, or an order with no creation instant, makes the item inconclusive (NO_POPULATION_RECORD), never "in". An open IMS
 *        order the store does not list as open is ALWAYS judged, whatever its age (it was imported, and an old one is the likeliest to
 *        be stale). Empty on both sides passes only on the named proof that every enumerated status reported a total of zero on both
 *        reads.
 *   R13  TAX-RATE MAPPINGS, presence only. Every WooCommerce tax rate (the full list, walked twice) must have an IMS mapping, and
 *        every IMS mapping of the storefront must name a rate the storefront still has; every Xero tax rate must be held by an active
 *        IMS tax rate (its accounting tax type), and the reverse. The Xero list is not available in this build: the stored tax-rate
 *        read keeps only the IMS rates that drift from Xero (U13 in the plan, open), so the Xero leg is VENDOR_LIST_UNPROVEN unless a
 *        port proves a complete list. A WooCommerce leg with a finding is still a FAIL (it is true whatever the Xero leg says), and it
 *        carries VENDOR_LIST_UNPROVEN beside DIFFERENCES; a clean WooCommerce leg with an unproven Xero leg is inconclusive, never a pass.
 *
 * No difference is settled over later runs here (the pack carries no settling state for any item yet), so a difference seen is a
 * failure on this run.
 */

import { classifyPopulation } from '@/lib/reconciliation-pack/ims-readers'
import type { ImsRead, ImsReadOptions, OrderRow, PopulationBoundaries, StorefrontStatusConfig, TaxRateRow, TaxMappingRow } from '@/lib/reconciliation-pack/ims-readers'
import { compareItem, outcomeOfComparison, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import {
  IMS_OPEN_ORDER_STATUSES,
  WOO_BUILT_IN_STATUS_MAP,
  type PackReasonCode,
  type PackSourceCode,
} from '@/lib/reconciliation-pack/constants'
import { canonicalKey, isKey, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import { readWooOrders, readWooTaxRates, type WooGetPort, type WooOrderRow, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'
import { normaliseWcOrderStatus } from '@/lib/connectors/woocommerce/order-status-filter'

export const VENDOR_ITEM_IDS = ['R9', 'R13'] as const
export type VendorItemId = (typeof VENDOR_ITEM_IDS)[number]
export function isVendorItem(id: string): id is VendorItemId {
  return (VENDOR_ITEM_IDS as readonly string[]).includes(id)
}

/** Xero tax types held in IMS's stored copy of Xero's rate list, with the proof that it is the WHOLE list. Absent port or null = not available. */
export type XeroTaxTypeList = { complete: true; taxTypes: readonly string[] }

export type VendorPorts = {
  woo?: WooGetPort
  /** Reads the stored, proven-complete list of Xero tax types, or null. The build has none (U13); a test supplies one. */
  xeroTaxTypes?: () => Promise<XeroTaxTypeList | null>
}

export type VendorItemContext = {
  asOf: string
  /** The explicit opt-in. Anything but the boolean true is "off". */
  vendorReads?: boolean
  vendor?: VendorPorts
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Test seam for pacing and budget. */
  wooOptions?: WooSourceOptions
}

const IMS: PackSourceCode = 'ims-database'
const WOO: PackSourceCode = 'woocommerce-api'
const XERO: PackSourceCode = 'xero-api'

const inconclusive = (id: VendorItemId, sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

function fromComparison(id: VendorItemId, result: CompareResult, sources: readonly PackSourceCode[], extra: readonly PackReasonCode[] = []): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  const reasons = verdict.outcome === 'fail' ? [...new Set([...verdict.reasons, ...extra])] : verdict.reasons
  return { id, outcome: verdict.outcome, reasons, proof, sources: [...sources], entries: result.status === 'compared' ? result.buckets : undefined }
}

const ORDER_ID_RE = /^[1-9][0-9]{0,17}$/
const TAX_ID_RE = /^[1-9][0-9]{0,17}$/
const XERO_TAX_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

// ---------------------------------------------------------------------------------------------
// R9
// ---------------------------------------------------------------------------------------------

const OPEN_IMS: ReadonlySet<string> = new Set(IMS_OPEN_ORDER_STATUSES)

/**
 * The storefront statuses to walk: the importer's admitted statuses whose effective IMS reading is an open status, read by the importer's
 * own lookup rule (see below): a mapping row, else the built-in table. No reading is UNKNOWN_STATUS; a stored key the importer would never
 * match but that normalises to the status is AMBIGUOUS_STATUS_MAPPING.
 */
export function openStorefrontStatuses(config: StorefrontStatusConfig): { ok: true; statuses: string[] } | { ok: false; reason: 'UNKNOWN_STATUS' | 'AMBIGUOUS_STATUS_MAPPING' } {
  const statuses: string[] = []
  for (const slug of config.configured) {
    // THE CONNECTOR'S OWN RULE (lib/connectors/woocommerce/sync/status-mapping.ts findWcStatusMapping, lines 103-121): a row matches a
    // slug only when its externalStatus EQUALS the slug or `wc-<slug>`, case-insensitively and with NO trimming (lines 110-111); the row
    // that equals the slug exactly wins (line 119); otherwise the first match (line 121, in database order). The pack copies the rule
    // (the connector imports lib/db) and a test pins the two equal on the same fixtures.
    const matched = config.mappings.filter((row) => row.externalStatus.toLowerCase() === slug || row.externalStatus.toLowerCase() === `wc-${slug}`)
    // A row whose key only NORMALISES to the slug (padding, an odd prefix) is one the importer never matches. It is neither used nor
    // ignored: which reading the importer applies is then not what the stored data says, so the item is inconclusive.
    if (config.mappings.some((row) => normaliseWcOrderStatus(row.externalStatus) === slug && !matched.includes(row))) return { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' }
    const exact = matched.filter((row) => row.externalStatus === slug)
    let reading: string | null
    if (exact.length === 1) reading = exact[0]!.imsStatus
    else if (matched.length > 0) {
      // The importer takes the first row in database order, which is not defined: rows that disagree have no single reading.
      const distinct = new Set(matched.map((row) => row.imsStatus))
      if (distinct.size !== 1) return { ok: false, reason: 'UNKNOWN_STATUS' }
      reading = [...distinct][0]!
    } else reading = Object.prototype.hasOwnProperty.call(WOO_BUILT_IN_STATUS_MAP, slug) ? WOO_BUILT_IN_STATUS_MAP[slug]! : null
    if (reading === null) return { ok: false, reason: 'UNKNOWN_STATUS' }
    if (OPEN_IMS.has(reading)) statuses.push(slug)
  }
  return { ok: true, statuses }
}

const wooKey = (id: string): KeyPart[] => [{ kind: 'vendor-id', raw: id }]
const imsOnlyKey = (id: string): KeyPart[] => [{ kind: 'ims-id', raw: id }]

async function runR9(context: VendorItemContext): Promise<ItemInput> {
  const woo = context.vendor?.woo
  const readIms = context.ims
  if (woo === undefined || readIms === undefined) return inconclusive('R9', [], 'SOURCE_UNREADABLE')
  const read = await readIms({ sections: ['boundaries', 'orders', 'storefrontStatus'] })
  if (!read.ok) return inconclusive('R9', [IMS], read.reason)
  const failed = (['boundaries', 'orders', 'storefrontStatus'] as const).flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return inconclusive('R9', [IMS], ...failed)
  const boundaries = (read.sections.boundaries as { ok: true; value: PopulationBoundaries }).value
  const orders = (read.sections.orders as { ok: true; value: OrderRow[] }).value
  const config = (read.sections.storefrontStatus as { ok: true; value: StorefrontStatusConfig }).value

  const open = openStorefrontStatuses(config)
  if (!open.ok) return inconclusive('R9', [IMS], open.reason)

  // IMS side: the identity is the storefront order id; an open order without one is set aside, listed.
  const ims: SideRow[] = []
  const imsCreated = new Set<string>()
  const unlinked = new Set<string>()
  for (const order of orders) {
    const link = order.links.find((entry) => entry.connector === 'woocommerce')
    if (link === undefined) {
      const key = imsOnlyKey(order.id)
      if (!isKey(key)) return inconclusive('R9', [IMS], 'BAD_KEY')
      ims.push({ key, value: order.totalForeign, currency: order.currency })
      unlinked.add(canonicalKey(key))
      continue
    }
    if (!ORDER_ID_RE.test(link.externalOrderId)) return inconclusive('R9', [IMS], 'BAD_KEY')
    ims.push({ key: wooKey(link.externalOrderId), value: order.totalForeign, currency: order.currency })
    imsCreated.add(link.externalOrderId)
  }

  const walked = await readWooOrders(woo, open.statuses, context.wooOptions)
  if (!walked.ok) return inconclusive('R9', [IMS, WOO], walked.reason)
  const vendor: SideRow[] = walked.value.orders.map((order: WooOrderRow) => ({ key: wooKey(order.id), value: order.total, currency: order.currency }))
  const wooCreated = new Map(walked.value.orders.map((order) => [order.id, order.createdAt] as const))

  // Population. An identity on both sides is always judged. A storefront order the store holds that IMS does not is judged only if the
  // recorded boundaries say IMS should have it (it was created at or after the initial import, inside the retention horizon); one older
  // than that is listed out. An open IMS order the store does not list as open is ALWAYS judged: IMS holding an order is proof that it
  // was imported, and an old one is the likeliest to be stale, so its age is never a reason to set it aside.
  const population = new Set<string>()
  for (const row of [...ims, ...vendor]) {
    const canonical = canonicalKey(row.key)
    if (unlinked.has(canonical)) continue
    const id = (row.key[0]!.raw as string)
    if (imsCreated.has(id)) { population.add(canonical); continue }
    const verdict = classifyPopulation(boundaries, 'storefront-order', wooCreated.get(id)!, context.asOf)
    if (verdict.kind === 'unknown') return inconclusive('R9', [IMS, WOO], verdict.reason)
    if (verdict.kind === 'in') population.add(canonical)
  }

  const result = compareItem('R9', { ims, vendor, imsComplete: true, vendorComplete: true, population, emptyProof: walked.value.allZero ? 'per-status-total-zero' : undefined })
  return fromComparison('R9', result, [IMS, WOO])
}

// ---------------------------------------------------------------------------------------------
// R13
// ---------------------------------------------------------------------------------------------

const wooRateKey = (id: string): KeyPart[] => [{ kind: 'sku', raw: 'woo-tax-rate' }, { kind: 'vendor-id', raw: id }]
const xeroTypeKey = (taxType: string): KeyPart[] => [{ kind: 'sku', raw: 'xero-tax-type' }, { kind: 'sku', raw: taxType }]

async function runR13(context: VendorItemContext): Promise<ItemInput> {
  const woo = context.vendor?.woo
  const readIms = context.ims
  if (woo === undefined || readIms === undefined) return inconclusive('R13', [], 'SOURCE_UNREADABLE')
  const read = await readIms({ sections: ['taxes'] })
  if (!read.ok) return inconclusive('R13', [IMS], read.reason)
  const section = read.sections.taxes
  if (section === undefined || !section.ok) return inconclusive('R13', [IMS], section === undefined ? 'SOURCE_UNREADABLE' : section.reason)
  const rates: TaxRateRow[] = section.value.rates
  const mappings: TaxMappingRow[] = section.value.mappings.filter((mapping) => mapping.connector === 'woocommerce')

  const imsWoo: SideRow[] = []
  for (const mapping of mappings) {
    if (!TAX_ID_RE.test(mapping.externalTaxRateId)) return inconclusive('R13', [IMS], 'BAD_KEY')
    imsWoo.push({ key: wooRateKey(mapping.externalTaxRateId) })
  }
  const walked = await readWooTaxRates(woo, context.wooOptions)
  if (!walked.ok) return inconclusive('R13', [IMS, WOO], walked.reason)
  const vendorWoo: SideRow[] = walked.value.rates.map((rate) => ({ key: wooRateKey(rate.id) }))

  // The Xero leg: a stored list that is PROVEN complete, or nothing.
  let xero: XeroTaxTypeList | null = null
  try { xero = context.vendor?.xeroTaxTypes ? await context.vendor.xeroTaxTypes() : null } catch { xero = null }
  const xeroProven = typeof xero === 'object' && xero !== null && xero.complete === true && Array.isArray(xero.taxTypes)

  if (!xeroProven) {
    // The WooCommerce leg alone cannot pass the item, but a finding in it is a finding.
    const leg = compareItem('R13', { ims: imsWoo, vendor: vendorWoo, imsComplete: true, vendorComplete: true, emptyProof: walked.value.total === 0 ? 'vendor-total-zero' : undefined })
    if (leg.status === 'compared' && outcomeOfComparison(leg).outcome === 'fail') return fromComparison('R13', leg, [IMS, WOO], ['VENDOR_LIST_UNPROVEN'])
    if (leg.status === 'unreadable') return inconclusive('R13', [IMS, WOO], leg.reason, 'VENDOR_LIST_UNPROVEN')
    return inconclusive('R13', [IMS, WOO], 'VENDOR_LIST_UNPROVEN')
  }

  const types = (xero as XeroTaxTypeList).taxTypes
  if (!types.every((type) => typeof type === 'string' && XERO_TAX_TYPE_RE.test(type))) return inconclusive('R13', [IMS, WOO, XERO], 'BAD_KEY')
  const imsTypes = [...new Set(rates.filter((rate) => rate.active && rate.accountingTaxType !== null).map((rate) => rate.accountingTaxType as string))]
  if (!imsTypes.every((type) => XERO_TAX_TYPE_RE.test(type))) return inconclusive('R13', [IMS, WOO, XERO], 'BAD_KEY')
  const ims = [...imsWoo, ...imsTypes.map((type): SideRow => ({ key: xeroTypeKey(type) }))]
  const vendor = [...vendorWoo, ...types.map((type): SideRow => ({ key: xeroTypeKey(type) }))]
  const result = compareItem('R13', { ims, vendor, imsComplete: true, vendorComplete: true, emptyProof: walked.value.total === 0 && types.length === 0 ? 'vendor-total-zero' : undefined })
  return fromComparison('R13', result, [IMS, WOO, XERO])
}

/** Run one vendor item. With the opt-in absent or anything but true, NOTHING is read: no port is touched and no request is made. Never throws. */
export async function runVendorItem(id: VendorItemId, context: VendorItemContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id, outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  try {
    return id === 'R9' ? await runR9(context) : await runR13(context)
  } catch {
    return inconclusive(id, [], 'INTERNAL_ERROR')
  }
}
