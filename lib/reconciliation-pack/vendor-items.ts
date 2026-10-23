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
 *        both sides is always judged, and so is every other identity: NO order is set aside by its age. The importer admits an order by its
 *        CURRENT status alone, whatever its age (the initial import asks the store for the selected statuses with no date bound,
 *        initial-import.ts:270-276; the ongoing sweep asks for the selected statuses modified after a cursor, order-import.ts:3160-3166;
 *        a webhook admits on the current status, order-status-filter.ts:166), so an order created before the initial import that entered
 *        an admitted open status later is one IMS should hold. Retention archives only TERMINAL orders (data-retention.ts:689-706), so it
 *        never removes an open order either. Comparing a storefront timestamp with an IMS one to exclude an order is cross-system clock
 *        ordering, which the pack never does. The only identities set aside are open IMS orders that have no storefront order id at all
 *        (no identity to compare), listed. Empty on both sides passes only on the named proof that every enumerated status reported a
 *        total of zero in both sweeps.
 *
 *   R13  TAX-RATE MAPPINGS, presence only. Every WooCommerce tax rate (the full list, walked twice) must have an IMS mapping, and
 *        every IMS mapping of the storefront must name a rate the storefront still has; every Xero tax rate must be held by an active
 *        IMS tax rate (its accounting tax type), and the reverse. The Xero list is not available in this build: the stored tax-rate
 *        read keeps only the IMS rates that drift from Xero (U13 in the plan, open), so the Xero leg is VENDOR_LIST_UNPROVEN unless a
 *        port proves a complete list. A WooCommerce leg with a finding is still a FAIL (it is true whatever the Xero leg says), and it
 *        carries VENDOR_LIST_UNPROVEN beside DIFFERENCES; a clean WooCommerce leg with an unproven Xero leg is inconclusive, never a pass.
 *
 * R9 SETTLES (owner decision D7): a difference first seen is UNSETTLED (inconclusive UNSETTLED_PENDING), and fails only when it is still
 * there after two LATER successful runs of the order sweep stream, counted as distinct last-success stamps carried in the pack's own
 * reports (compare.ts advanceDifference, settling.ts for what may be carried). R13 does not settle: its difference fails at once.
 */

import type { ImsRead, ImsReadOptions, OrderRow, StorefrontStatusConfig, TaxRateRow, TaxMappingRow } from '@/lib/reconciliation-pack/ims-readers'
import { compareItem, outcomeOfComparison, type CompareResult, type SettlingInput, type SideRow } from '@/lib/reconciliation-pack/compare'
import {
  IMS_OPEN_ORDER_STATUSES,
  WOO_BUILT_IN_STATUS_MAP,
  WOO_HISTORICAL_IMPORT_EXTRA_STATUS,
  type PackReasonCode,
  type PackSourceCode,
} from '@/lib/reconciliation-pack/constants'
import { canonicalKey, isKey, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import { readWooOrders, readWooTaxRates, type WooGetPort, type WooOrderRow, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'
import { normaliseWcOrderStatus, resolveWcPullStatuses } from '@/lib/connectors/woocommerce/order-status-filter'

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
  /** R9 only: the state carried from the previous report and the stream stamp of this run (set by runItems). Absent = no stamp, so R9 is inconclusive STALE_BASIS and never a pass. */
  settling?: SettlingInput
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
 * THE STATUSES THE IMPORTER ADMITS, by every route that admits an order by status, from the SHARED pure rule the connector itself uses
 * (order-status-filter.ts resolveWcPullStatuses, no database in it):
 *   - the initial import: the selected statuses only (initial-import.ts:210, getWcPullStatuses('initial'));
 *   - the live poll and the reconcile sweeps: the selected statuses, plus the two customer-withdrawal statuses, plus `completed` for the
 *     reconcile routes (order-import.ts:3000-3006 and order-status-filter.ts resolveWcPullStatuses);
 *   - a webhook: the selected statuses plus the withdrawal pair, judged on the order's current status (order-admission.ts:81,
 *     order-status-filter.ts:166);
 *   - the manual historical import: `completed` and `delivered` within a date range (connectors/woocommerce/orders.ts:139);
 *   - an EMPTY selection admits nothing on the sweeps, the webhook and the initial import, the withdrawal statuses included; the manual
 *     historical import does not consult the selection, so `completed` and `delivered` stay in the union.
 * The pack walks the union, so a status admitted by any route is never left out. Each admitted status is then read as follows.
 *   - A SELECTED status: the importer's own mapping lookup (see below), else the built-in table; no reading is UNKNOWN_STATUS.
 *   - The WITHDRAWAL-SUBMITTED status: always walked. A linked order in it is held ON_HOLD by the withdrawal handler (sync/withdrawal.ts,
 *     which takes the transition before any status mapping), and an IMS hold must find its storefront order.
 *   - Any other route-added status (approved, completed, delivered): walked only if a mapping row reads it as an open IMS status; with
 *     no reading it is closed, not unknown (the importer closes it too: withdrawn cancels, completed completes).
 * A stored key the importer would never match but that normalises to an admitted status is AMBIGUOUS_STATUS_MAPPING.
 */
export function openStorefrontStatuses(config: StorefrontStatusConfig): { ok: true; statuses: string[] } | { ok: false; reason: 'UNKNOWN_STATUS' | 'AMBIGUOUS_STATUS_MAPPING' } {
  const statuses: string[] = []
  const admitted = [...new Set([...(config.configured.length === 0 ? [] : resolveWcPullStatuses('reconcile', config.configured, config.withdrawal)), 'completed', WOO_HISTORICAL_IMPORT_EXTRA_STATUS])]
  for (const slug of admitted) {
    const selected = config.configured.includes(slug)
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
    if (slug === config.withdrawal.submitted) { statuses.push(slug); continue }
    if (reading === null) {
      if (selected) return { ok: false, reason: 'UNKNOWN_STATUS' }
      continue
    }
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
  const read = await readIms({ sections: ['orders', 'storefrontStatus'] })
  if (!read.ok) return inconclusive('R9', [IMS], read.reason)
  const failed = (['orders', 'storefrontStatus'] as const).flatMap((name) => {
    const section = read.sections[name]
    return section === undefined ? ['SOURCE_UNREADABLE' as const] : section.ok ? [] : [section.reason]
  })
  if (failed.length > 0) return inconclusive('R9', [IMS], ...failed)
  const orders = (read.sections.orders as { ok: true; value: OrderRow[] }).value
  const config = (read.sections.storefrontStatus as { ok: true; value: StorefrontStatusConfig }).value

  const open = openStorefrontStatuses(config)
  if (!open.ok) return inconclusive('R9', [IMS], open.reason)

  // IMS side: the identity is the storefront order id; an open order without one is set aside, listed.
  const ims: SideRow[] = []
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
  }

  const walked = await readWooOrders(woo, open.statuses, context.wooOptions)
  if (!walked.ok) return inconclusive('R9', [IMS, WOO], walked.reason)
  const vendor: SideRow[] = walked.value.orders.map((order: WooOrderRow) => ({ key: wooKey(order.id), value: order.total, currency: order.currency }))

  // Population: every identity is judged except an open IMS order with no storefront order id (listed, never compared). No order is set
  // aside by an instant: see the header for the importer rules (file:line) that admit an order by its current status whatever its age.
  const population = new Set<string>()
  for (const row of [...ims, ...vendor]) {
    const canonical = canonicalKey(row.key)
    if (!unlinked.has(canonical)) population.add(canonical)
  }

  // R9 settles (its catalogue row): a difference fails only after two later successful runs of the order sweep. Without the run's settling
  // input there is no stamp to settle under, and the comparator says so (STALE_BASIS); it never falls back to failing at once.
  const settling: SettlingInput = context.settling ?? { carried: new Map(), usable: false, stamp: null }
  const result = compareItem('R9', { ims, vendor, imsComplete: true, vendorComplete: true, population, emptyProof: walked.value.allZero ? 'per-status-total-zero' : undefined, settling })
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
