/**
 * ITEMS R1, R9 AND R13: THE VENDOR ITEMS, BEHIND AN EXPLICIT OPT-IN. R1 (the warehouse system) lives in wms-items.ts and is dispatched from here;
 * R9 and R13 (WooCommerce) follow.
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
 *        every IMS mapping of the storefront must name a rate the storefront still has; every Xero tax type IMS USES (an active IMS
 *        tax rate's accounting tax type, an active component's, and the two reverse-charge settings) must resolve to an ACTIVE type of the
 *        stored Xero list, else it is a finding; an ACTIVE Xero type nothing in IMS names is out of the population (NOT_REFERENCED_BY_IMS), listed and never a finding. The Xero list is IMS's stored copy of it (Xero is the tax-rate
 *        master; the xero-tax-rate-drift sweep replaces it whole), read in the same snapshot as the IMS rates for the organisation now
 *        connected, and it counts only when the header row proves it is one complete read (present for that organisation, its count
 *        equal to the rows read, its digest equal to the rows'); otherwise the Xero leg is VENDOR_LIST_UNPROVEN. No request is made to
 *        Xero. With an unproven Xero list the Woo-IMS identity checks still run (mapping presence and the set identity between the two systems, with no Xero
 *        rule); a difference they establish (Woo 20% against IMS 19%) is still a FAIL (it is true whatever the Xero leg says), and it
 *        carries VENDOR_LIST_UNPROVEN beside DIFFERENCES; a clean Woo-IMS result with an unproven Xero leg is inconclusive, never a pass.
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
import type { XeroVatVendor } from '@/lib/reconciliation-pack/vat-item'
import { compareVatSetIdentity } from '@/lib/reconciliation-pack/vat-set-identity'
import { runWmsItem } from '@/lib/reconciliation-pack/wms-items'
import type { WmsReadPort, WmsReadSession, WmsSourceOptions } from '@/lib/reconciliation-pack/wms-source'
import { readWooOrders, readWooTaxRateDetails, type WooGetPort, type WooOrderRow, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'
import { normaliseWcOrderStatus, resolveWcPullStatuses } from '@/lib/connectors/woocommerce/order-status-filter'

export const VENDOR_ITEM_IDS = ['R1', 'R9', 'R13'] as const
export type VendorItemId = (typeof VENDOR_ITEM_IDS)[number]
export function isVendorItem(id: string): id is VendorItemId {
  return (VENDOR_ITEM_IDS as readonly string[]).includes(id)
}

export type VendorPorts = {
  woo?: WooGetPort
  /** R12 only (vat-item.ts): the GET-only Xero port and the stored connection's binding reader. */
  xero?: XeroVatVendor
  /** The warehouse system (R1): GET only, the stored fixed key only. */
  wms?: WmsReadPort
}

export type VendorItemContext = {
  asOf: string
  /** The explicit opt-in. Anything but the boolean true is "off". */
  vendorReads?: boolean
  vendor?: VendorPorts
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Test seam for pacing and budget. */
  wooOptions?: WooSourceOptions
  /** Test seam for the warehouse system's pacing and budget. */
  wmsOptions?: WmsSourceOptions
  /** The run's shared warehouse-system read (R1 and R14 share it). */
  wmsSession?: WmsReadSession
  /** R1 and R9 (the items that settle): the state carried from the previous report and the stream stamp of this run (set by runItems). Absent = no stamp, so R9 is inconclusive STALE_BASIS and never a pass. */
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
/** A set-identity row: system, then the reason in lower case with hyphens (or "identical"), then the identity. A key part cannot hold an underscore. */
const setKey = (system: 'woo' | 'ims' | 'xero', id: string, reason: string | null): KeyPart[] => [
  { kind: 'sku', raw: 'vat-set' }, { kind: 'sku', raw: system }, { kind: 'sku', raw: reason === null ? 'identical' : reason.toLowerCase().replace(/_/g, '-') },
  system === 'woo' ? { kind: 'vendor-id', raw: id } : system === 'ims' ? { kind: 'ims-id', raw: id } : { kind: 'sku', raw: id },
]

async function runR13(context: VendorItemContext): Promise<ItemInput> {
  const woo = context.vendor?.woo
  const readIms = context.ims
  if (woo === undefined || readIms === undefined) return inconclusive('R13', [], 'SOURCE_UNREADABLE')
  const read = await readIms({ sections: ['taxes', 'xeroTaxRates'] })
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
  const walked = await readWooTaxRateDetails(woo, context.wooOptions)
  if (!walked.ok) return inconclusive('R13', [IMS, WOO], walked.reason)
  const vendorWoo: SideRow[] = walked.value.rates.map((rate) => ({ key: wooRateKey(rate.id) }))

  // The Xero leg: IMS's stored copy of Xero's tax-rate list (read in the SAME snapshot as the rates above, for the organisation now
  // connected), proven to be one complete read by its header row, or nothing. There is no port and no request to Xero here.
  const xeroSection = read.sections.xeroTaxRates
  const stored = xeroSection !== undefined && xeroSection.ok ? xeroSection.value : null
  if (stored === null || stored.state !== 'proven') {
    // The Xero leg cannot be judged, so R13 can never pass; but the WooCommerce-to-IMS identity needs no Xero list, so it is judged anyway
    // (mapping presence AND the set identity between the two systems that ARE proven: a Woo 20% against an IMS 19% is a finding whatever
    // state the Xero list is in). An established difference fails the item with VENDOR_LIST_UNPROVEN beside it; otherwise it is inconclusive.
    const imsLeg = [...imsWoo]
    const vendorLeg = [...vendorWoo]
    const legPopulation = new Set<string>()
    for (const row of [...imsWoo, ...vendorWoo]) legPopulation.add(canonicalKey(row.key))
    for (const row of compareVatSetIdentity({ woo: walked.value.rates, rates, mappings, componentRates: section.value.componentRates, xero: null })) {
      // With the Xero leg skipped there is no Xero row, and the only IMS-row reason left is MISSING_IN_WOO.
      const keys = row.reasons.length === 0 ? [setKey(row.system, row.id, null)] : row.reasons.map((reason) => setKey(row.system, row.id, reason))
      for (const key of keys) {
        imsLeg.push({ key })
        if (row.reasons.length === 0) vendorLeg.push({ key })
        legPopulation.add(canonicalKey(key))
      }
    }
    const leg = compareItem('R13', { ims: imsLeg, vendor: vendorLeg, imsComplete: true, vendorComplete: true, population: legPopulation, emptyProof: walked.value.total === 0 ? 'vendor-total-zero' : undefined })
    if (leg.status === 'compared' && outcomeOfComparison(leg).outcome === 'fail') return fromComparison('R13', leg, [IMS, WOO], ['VENDOR_LIST_UNPROVEN'])
    if (leg.status === 'unreadable') return inconclusive('R13', [IMS, WOO], leg.reason, 'VENDOR_LIST_UNPROVEN')
    return inconclusive('R13', [IMS, WOO], 'VENDOR_LIST_UNPROVEN')
  }

  // THE XERO LEG IS "ONLY THE TYPES IMS USES". Every Xero tax type IMS names must resolve to an ACTIVE type of the proven stored list; a
  // referenced type that is missing, DELETED, ARCHIVED or PENDING is a finding (onlyIms, listing the code). An ACTIVE Xero type that
  // nothing in IMS names is not a finding: it is listed as out of the population (NOT_REFERENCED_BY_IMS). IMS names a Xero tax type in
  // four places: an active tax rate, an active component of an active rate, and the two reverse-charge settings.
  const activeRates = new Set(rates.filter((rate) => rate.active).map((rate) => rate.id))
  const referenced = new Set<string>()
  for (const rate of rates) if (rate.active && rate.accountingTaxType !== null) referenced.add(rate.accountingTaxType)
  for (const component of section.value.componentTaxTypes) if (component.active && activeRates.has(component.taxRateId)) referenced.add(component.accountingTaxType)
  for (const type of [section.value.reverseCharge.sales, section.value.reverseCharge.purchase]) if (type !== '') referenced.add(type)
  const imsTypes = [...referenced]
  if (!imsTypes.every((type) => XERO_TAX_TYPE_RE.test(type))) return inconclusive('R13', [IMS, WOO, XERO], 'BAD_KEY')
  const types = stored.taxTypes.filter((entry) => entry.status === 'ACTIVE').map((entry) => entry.taxType)
  if (!types.every((type) => typeof type === 'string' && XERO_TAX_TYPE_RE.test(type))) return inconclusive('R13', [IMS, WOO, XERO], 'BAD_KEY')
  const ims: SideRow[] = [...imsWoo, ...imsTypes.map((type): SideRow => ({ key: xeroTypeKey(type) }))]
  const vendor: SideRow[] = [...vendorWoo, ...types.map((type): SideRow => ({ key: xeroTypeKey(type) }))]
  // Judged: every WooCommerce identity and every type IMS names. A Xero type nothing names is outside the population.
  const population = new Set<string>()
  for (const row of [...imsWoo, ...vendorWoo, ...imsTypes.map((type): SideRow => ({ key: xeroTypeKey(type) }))]) population.add(canonicalKey(row.key))
  // SET IDENTITY (lib/reconciliation-pack/vat-set-identity.ts): one listed identity per in-scope WooCommerce rate, IMS sales rate and Xero sales type.
  // An identical one is on both sides; one with reasons is on the IMS side only, once per reason (the reason is part of the key), so it is a finding.
  const setRows = compareVatSetIdentity({ woo: walked.value.rates, rates, mappings, componentRates: section.value.componentRates, xero: stored.rows })
  for (const row of setRows) {
    const keys = row.reasons.length === 0 ? [setKey(row.system, row.id, null)] : row.reasons.map((reason) => setKey(row.system, row.id, reason))
    for (const key of keys) {
      ims.push({ key })
      if (row.reasons.length === 0) vendor.push({ key })
      population.add(canonicalKey(key))
    }
  }
  const result = compareItem('R13', { ims, vendor, imsComplete: true, vendorComplete: true, population, emptyProof: walked.value.total === 0 && imsTypes.length === 0 ? 'vendor-total-zero' : undefined })
  return fromComparison('R13', result, [IMS, WOO, XERO])
}

/** Run one vendor item. With the opt-in absent or anything but true, NOTHING is read: no port is touched and no request is made. Never throws. */
export async function runVendorItem(id: VendorItemId, context: VendorItemContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id, outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  try {
    if (id === 'R1') return await runWmsItem({ vendorReads: context.vendorReads, wms: context.vendor?.wms, ims: context.ims, wmsOptions: context.wmsOptions, wmsSession: context.wmsSession, settling: context.settling })
    return id === 'R9' ? await runR9(context) : await runR13(context)
  } catch {
    return inconclusive(id, [], 'INTERNAL_ERROR')
  }
}
