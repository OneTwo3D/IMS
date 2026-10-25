/**
 * THE VAT DIFFERENCE REPORT: ONE SET OF VAT RATES IN XERO, IMS AND WOOCOMMERCE, XERO THE MASTER. READ ONLY.
 *
 * Owner ruling 2026-10-25: the three systems use the SAME set of VAT rates and Xero is the master. WooCommerce tax-rate writes are
 * operator-manual at P1 (the owner corrects WooCommerce by hand, guided by this report) and IMS's own at P2 (a later build). This module
 * only COMPARES; it has no write path of any kind: the IMS and Xero sides are `find*` reads of a client, the WooCommerce side is
 * the GET-only port of the reconciliation pack (lib/reconciliation-pack/woo-transport.ts through the connector fetch seam).
 *
 * THE THREE SIDES
 *   Xero  : the stored, trusted copy of Xero's tax-rate list, through `readStoredXeroList` of lib/tax/purchase-tax-import.ts (header, row
 *           count, digest, last-success stamp, connected organisation, freshness). An unusable list REFUSES the whole report: it never
 *           says "no differences" about a side it could not read.
 *   IMS   : the tax_rates table (active rows, their active components) and the storefront tax-rate mappings (shopping_tax_rate_mappings).
 *   Woo   : GET /wp-json/wc/v3/taxes, every page (readWooTaxRateDetails: proven headers, double walk). A read that fails or cannot be
 *           proven REFUSES the report. The rate row carries its tax class, so /taxes/classes is not read.
 *
 * THE MAPPING between WooCommerce and IMS is the existing one R13 of the reconciliation pack relies on: `ShoppingTaxRateMapping`
 * (connector 'woocommerce', external tax-rate id -> IMS tax rate). IMS and Xero are tied by the IMS rate's `accountingTaxType` (the Xero
 * tax type). No third mapping is invented; no name matching is done.
 *
 * Every difference carries a CLOSED reason code (VAT_DIFFERENCE_REASONS) and the values on each side that disagree. Percentages are compared
 * as exact decimals; WooCommerce is held to Xero's percentage when the mapped IMS rate has an ACTIVE Xero type that states one, else to IMS's.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { Prisma as PrismaRuntime } from '@/app/generated/prisma/client'
import type { PackReasonCode } from '@/lib/reconciliation-pack/constants'
import type { WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'
import { VAT_DIFFERENCE_REASON_LIST, type VatDifferenceReason } from '@/lib/tax/vat-difference-reasons'
import { readStoredXeroList, type PurchaseTaxImportRefusalCode, type StoredXeroList } from '@/lib/tax/purchase-tax-import'

export { VAT_DIFFERENCE_REASONS, VAT_DIFFERENCE_REASON_LIST, type VatDifferenceReason } from '@/lib/tax/vat-difference-reasons'

/** Why the report was not produced. Closed. A refusal is never a report of no differences. */
export const VAT_REFUSAL_CODES = [
  ...([
    'XERO_NOT_CONNECTED', 'XERO_LIST_MISSING', 'XERO_LIST_UNREADABLE', 'XERO_LIST_NOT_STAMPED', 'XERO_LIST_STALE', 'XERO_LIST_WRONG_ORGANISATION',
  ] as const satisfies readonly PurchaseTaxImportRefusalCode[]),
  'IMS_UNREADABLE',
  'WOO_READ_FAILED',
] as const
export type VatRefusalCode = (typeof VAT_REFUSAL_CODES)[number]

export type VatDifference = {
  reason: VatDifferenceReason
  /** Which system the owner has to look at first. */
  subject: 'xero' | 'ims' | 'woo'
  /** Xero tax type, IMS rate id or WooCommerce rate id, as named by `subject`. */
  subjectId: string
  /** A label a person recognises (never a secret): the rate's own name. */
  label: string
  xeroTaxType: string | null
  imsRateId: string | null
  wooRateId: string | null
  /** The values that disagree, by system, as the systems state them (percent text for percentages). null = not stated / not applicable. */
  xero: string | null
  ims: string | null
  woo: string | null
}

export type VatDifferenceReport =
  | { status: 'refused'; code: VatRefusalCode; detail: string; wooReason?: PackReasonCode }
  | {
    status: 'compared'
    xero: { tenantId: string; fetchedAt: string; types: number; active: number }
    ims: { activeRates: number; mappings: number }
    woo: { rates: number }
    differences: VatDifference[]
    counts: Record<VatDifferenceReason, number>
  }

export type ImsComponentRow = { rate: string; compoundOnPrevious: boolean; active: boolean; sortOrder: number }
export type ImsRateRow = {
  id: string
  name: string
  /** Fraction text (Decimal(5,4)), for example "0.2000". */
  rate: string
  usedFor: string
  active: boolean
  accountingTaxType: string | null
  countryCode: string | null
  isCompound: boolean
  reverseCharge: boolean
  components: ImsComponentRow[]
}
export type ImsMappingRow = { externalTaxRateId: string; taxRateId: string; externalClass: string | null }
export type ImsXeroSnapshot = { xero: StoredXeroList; rates: ImsRateRow[]; mappings: ImsMappingRow[] }

/** The reads the snapshot makes, as a structural client: a Prisma client or transaction satisfies it, and none of these is a write. */
type ReadClient = Prisma.TransactionClient

const Dec = PrismaRuntime.Decimal
type Dec = InstanceType<typeof PrismaRuntime.Decimal>

/**
 * IMS rates + storefront mappings + the proven stored Xero list, read from ONE client (the caller opens a REPEATABLE READ READ ONLY
 * transaction, so the three come from one snapshot). The Xero list is proven first: an unusable list is a refusal, with the code the
 * import uses. Total: a failure to read is IMS_UNREADABLE, never a thrown error.
 */
export async function readImsXeroSnapshot(client: ReadClient, now: Date): Promise<{ ok: true; snapshot: ImsXeroSnapshot } | { ok: false; code: VatRefusalCode; detail: string }> {
  try {
    const token = await client.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
    const read = await readStoredXeroList(client, now, token?.tenantId ?? null)
    if (!read.ok) {
      const code = (VAT_REFUSAL_CODES as readonly string[]).includes(read.refusal.code) ? (read.refusal.code as VatRefusalCode) : 'XERO_LIST_UNREADABLE'
      return { ok: false, code, detail: read.refusal.detail }
    }
    const rows = await client.taxRate.findMany({
      select: {
        id: true, name: true, rate: true, usedFor: true, active: true, accountingTaxType: true, countryCode: true, isCompound: true, reverseCharge: true,
        components: { select: { rate: true, compoundOnPrevious: true, active: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    const mappings = await client.shoppingTaxRateMapping.findMany({
      where: { connector: 'woocommerce' },
      select: { externalTaxRateId: true, taxRateId: true, externalClass: true },
      orderBy: [{ externalTaxRateId: 'asc' }],
    })
    return {
      ok: true,
      snapshot: {
        xero: read.list,
        rates: rows.map((row) => ({
          id: row.id, name: row.name, rate: row.rate.toFixed(4), usedFor: row.usedFor, active: row.active, accountingTaxType: row.accountingTaxType,
          countryCode: row.countryCode, isCompound: row.isCompound, reverseCharge: row.reverseCharge,
          components: row.components.map((c) => ({ rate: c.rate.toFixed(4), compoundOnPrevious: c.compoundOnPrevious, active: c.active, sortOrder: c.sortOrder })),
        })),
        mappings,
      },
    }
  } catch {
    return { ok: false, code: 'IMS_UNREADABLE', detail: 'the IMS tax rates, the storefront mappings or the stored Xero list could not be read' }
  }
}

const REASON_ORDER = new Map(VAT_DIFFERENCE_REASON_LIST.map((reason, index) => [reason, index] as const))

const percentOfFraction = (fraction: string): Dec => new Dec(fraction).mul(100)
const text = (value: Dec): string => value.toFixed()
const normalClass = (value: string | null): string => {
  const slug = (value ?? '').trim().toLowerCase()
  return slug === '' ? 'standard' : slug
}
const sides = (usedFor: string): readonly string[] => (usedFor === 'BOTH' ? ['SALES', 'PURCHASE'] : [usedFor])

/** The percentage IMS computes tax at: the active components' (when it has any), else the rate column. */
function imsEffectivePercent(rate: ImsRateRow): Dec {
  const active = rate.components.filter((c) => c.active)
  if (active.length === 0) return percentOfFraction(rate.rate)
  const effective = effectiveTaxRateFromComponents(active.map((c) => ({ rate: Number(c.rate), compoundOnPrevious: c.compoundOnPrevious })))
  return effective === null ? percentOfFraction(rate.rate) : new Dec(String(effective)).mul(100)
}

/**
 * The comparison itself: pure over its three inputs, no clock, no database, no network. Every field it reads is validated by the readers
 * above it (the Xero list by the stored-list proof, the WooCommerce rows by readWooTaxRateDetails).
 */
export function compareVatSets(input: { snapshot: ImsXeroSnapshot; woo: readonly WooTaxRateDetail[] }): Extract<VatDifferenceReport, { status: 'compared' }> {
  const { snapshot, woo } = input
  const xeroByType = new Map(snapshot.xero.rows.map((row) => [row.taxType, row] as const))
  const xeroPercent = (taxType: string | null): Dec | null => {
    const row = taxType === null ? undefined : xeroByType.get(taxType)
    if (row === undefined || row.status !== 'ACTIVE') return null
    const stated = row.effectiveRate ?? row.displayTaxRate
    return stated === null ? null : new Dec(stated)
  }
  const activeRates = snapshot.rates.filter((rate) => rate.active)
  const ratesById = new Map(snapshot.rates.map((rate) => [rate.id, rate] as const))
  const differences: VatDifference[] = []
  const add = (reason: VatDifferenceReason, subject: VatDifference['subject'], subjectId: string, label: string, ids: { xeroTaxType?: string | null; imsRateId?: string | null; wooRateId?: string | null }, values: { xero?: string | null; ims?: string | null; woo?: string | null } = {}): void => {
    differences.push({
      reason, subject, subjectId, label,
      xeroTaxType: ids.xeroTaxType ?? null, imsRateId: ids.imsRateId ?? null, wooRateId: ids.wooRateId ?? null,
      xero: values.xero ?? null, ims: values.ims ?? null, woo: values.woo ?? null,
    })
  }

  // ---- Xero <-> IMS -------------------------------------------------------------------------------------
  const activeByType = new Map<string, ImsRateRow[]>()
  for (const rate of activeRates) {
    if (rate.accountingTaxType === null) { add('IMS_RATE_NO_XERO_TYPE', 'ims', rate.id, rate.name, { imsRateId: rate.id }, { ims: text(percentOfFraction(rate.rate)) }); continue }
    activeByType.set(rate.accountingTaxType, [...(activeByType.get(rate.accountingTaxType) ?? []), rate])
    const xero = xeroByType.get(rate.accountingTaxType)
    const ids = { xeroTaxType: rate.accountingTaxType, imsRateId: rate.id }
    if (xero === undefined) { add('MISSING_IN_XERO', 'ims', rate.id, rate.name, ids, { ims: text(percentOfFraction(rate.rate)) }); continue }
    if (xero.status !== 'ACTIVE') { add('INACTIVE_IN_XERO', 'ims', rate.id, rate.name, ids, { xero: xero.status, ims: text(percentOfFraction(rate.rate)) }); continue }
    const stated = xeroPercent(rate.accountingTaxType)
    if (stated === null) { add('XERO_RATE_NOT_STATED', 'xero', rate.accountingTaxType, xero.name, ids, { ims: text(percentOfFraction(rate.rate)) }); continue }
    const column = percentOfFraction(rate.rate)
    const effective = imsEffectivePercent(rate)
    if (!column.eq(stated)) add('PERCENTAGE_MISMATCH_IMS_XERO', 'ims', rate.id, rate.name, ids, { xero: text(stated), ims: text(column) })
    else if (!effective.eq(stated)) add('PERCENTAGE_MISMATCH_IMS_XERO', 'ims', rate.id, rate.name, ids, { xero: text(stated), ims: text(effective) })
  }
  for (const [taxType, rates] of activeByType) {
    const clash = rates.some((a, index) => rates.slice(index + 1).some((b) => sides(a.usedFor).some((side) => sides(b.usedFor).includes(side))))
    if (clash) add('AMBIGUOUS_IMS_MAPPING', 'xero', taxType, xeroByType.get(taxType)?.name ?? taxType, { xeroTaxType: taxType }, { ims: rates.map((r) => r.id).sort().join(',') })
  }
  for (const row of snapshot.xero.rows) {
    if (row.status === 'ACTIVE' && !activeByType.has(row.taxType)) {
      const stated = xeroPercent(row.taxType)
      add('MISSING_IN_IMS', 'xero', row.taxType, row.name, { xeroTaxType: row.taxType }, { xero: stated === null ? null : text(stated) })
    }
  }

  // ---- IMS <-> WooCommerce, through the existing mapping ---------------------------------------------------
  const wooById = new Map(woo.map((rate) => [rate.id, rate] as const))
  const mappingByWoo = new Map(snapshot.mappings.map((mapping) => [mapping.externalTaxRateId, mapping] as const))
  const reachedByWoo = new Set<string>()
  for (const rate of woo) {
    const mapping = mappingByWoo.get(rate.id)
    const label = rate.name === '' ? `${rate.class} ${rate.country}`.trim() : rate.name
    if (mapping === undefined) { add('WOO_RATE_NO_IMS_MAPPING', 'woo', rate.id, label, { wooRateId: rate.id }, { woo: rate.rate }); continue }
    const ims = ratesById.get(mapping.taxRateId)
    if (ims === undefined) { add('WOO_RATE_NO_IMS_MAPPING', 'woo', rate.id, label, { wooRateId: rate.id }, { woo: rate.rate }); continue }
    if (!ims.active) { add('WOO_MAPPED_TO_INACTIVE_IMS_RATE', 'woo', rate.id, label, { wooRateId: rate.id, imsRateId: ims.id, xeroTaxType: ims.accountingTaxType }, { ims: text(percentOfFraction(ims.rate)), woo: rate.rate }); continue }
    reachedByWoo.add(ims.id)
    const ids = { wooRateId: rate.id, imsRateId: ims.id, xeroTaxType: ims.accountingTaxType }
    const xeroPct = xeroPercent(ims.accountingTaxType)
    const imsPct = percentOfFraction(ims.rate)
    const reference = xeroPct ?? imsPct
    const wooPct = new Dec(rate.rate)
    if (!wooPct.eq(reference)) add('WOO_PERCENTAGE_MISMATCH', 'woo', rate.id, label, ids, { xero: xeroPct === null ? null : text(xeroPct), ims: text(imsPct), woo: text(wooPct) })
    // SCOPE, both ways: an empty country (Woo) and a null country (IMS) both mean "everywhere", so a country-specific rate on one side and a global one on the other is a difference.
    const imsScope = (ims.countryCode ?? '').trim().toUpperCase()
    const wooScope = rate.country.trim().toUpperCase()
    if (imsScope !== wooScope) add('WOO_COUNTRY_MISMATCH', 'woo', rate.id, label, ids, { ims: imsScope === '' ? '(any)' : imsScope, woo: wooScope === '' ? '(any)' : wooScope })
    // CLASS: the importer stores `wcRate.class || null` (lib/connectors/woocommerce/sync/taxes.ts), so a null recorded class is the store's empty = standard class,
    // and is compared with the live class like any other.
    if (normalClass(rate.class) !== normalClass(mapping.externalClass)) {
      add('WOO_CLASS_MISMATCH', 'woo', rate.id, label, ids, { ims: normalClass(mapping.externalClass), woo: normalClass(rate.class) })
    }
    if (rate.compound !== ims.isCompound) add('WOO_COMPOUND_MISMATCH', 'woo', rate.id, label, ids, { ims: String(ims.isCompound), woo: String(rate.compound) })
    if (!rate.shipping && reference.gt(0)) add('WOO_SHIPPING_NOT_TAXED', 'woo', rate.id, label, ids, { woo: 'shipping off' })
    if (rate.state !== '' || rate.postcode !== '' || rate.city !== '') {
      add('WOO_REGIONAL_SCOPE', 'woo', rate.id, label, ids, { woo: [rate.state, rate.postcode, rate.city].filter((part) => part !== '').join(' / ') })
    }
  }
  for (const mapping of snapshot.mappings) {
    if (wooById.has(mapping.externalTaxRateId)) continue
    const ims = ratesById.get(mapping.taxRateId)
    add('WOO_RATE_GONE', 'ims', mapping.taxRateId, ims?.name ?? mapping.taxRateId, { imsRateId: mapping.taxRateId, wooRateId: mapping.externalTaxRateId, xeroTaxType: ims?.accountingTaxType ?? null }, { ims: ims === undefined ? null : text(percentOfFraction(ims.rate)) })
  }
  for (const rate of activeRates) {
    if (rate.reverseCharge || !sides(rate.usedFor).includes('SALES') || reachedByWoo.has(rate.id)) continue
    add('MISSING_IN_WOO', 'ims', rate.id, rate.name, { imsRateId: rate.id, xeroTaxType: rate.accountingTaxType }, { ims: text(percentOfFraction(rate.rate)) })
  }

  differences.sort((a, b) => (REASON_ORDER.get(a.reason)! - REASON_ORDER.get(b.reason)!) || a.subjectId.localeCompare(b.subjectId) || (a.wooRateId ?? '').localeCompare(b.wooRateId ?? '', undefined, { numeric: true }))
  const counts = Object.fromEntries(VAT_DIFFERENCE_REASON_LIST.map((reason) => [reason, 0])) as Record<VatDifferenceReason, number>
  for (const difference of differences) counts[difference.reason] += 1
  return {
    status: 'compared',
    xero: { tenantId: snapshot.xero.tenantId, fetchedAt: snapshot.xero.fetchedAt.toISOString(), types: snapshot.xero.rows.length, active: snapshot.xero.rows.filter((row) => row.status === 'ACTIVE').length },
    ims: { activeRates: activeRates.length, mappings: snapshot.mappings.length },
    woo: { rates: woo.length },
    differences,
    counts,
  }
}
