/**
 * RE-KEY IMS TAX RATES TO THE CUSTOM TAX CODES OF THE XERO ORGANISATION CONNECTED NOW. Operator-confirmed; never calls Xero (it reads the stored copy of its list) and never writes to it.
 *
 * WHY. Xero numbers its CUSTOM tax types (TAX001..TAXnnn) per organisation, in creation order. IMS's per-country VAT rates ("CY VAT", "BE VAT" ...) were created against a Demo
 * organisation, so their `accountingTaxType` holds the DEMO organisation's numbers. In the live organisation the same codes mean other rates (live TAX005 is "BG VAT" where IMS's TAX005
 * is "CY VAT"). IMS posts a line's accountingTaxType, so a sale on IMS "CY VAT" would post as BG VAT. The code is therefore never trusted: a rate is tied to the live type by NAME.
 *
 * THE PLAN (read only). For every ACTIVE IMS rate whose code is not a Xero built-in (lib/tax/xero-built-in-tax-types.ts), find the live type it should carry:
 *   NAME       the live type whose name equals the IMS rate's name, trimmed, case-sensitive FIRST; only if that finds none, case-insensitive. The plan says which matched.
 *   STATUS     the live type must be ACTIVE in the trusted stored list (readStoredXeroList: the proof #797's import uses).
 *   PERCENTAGE exactly the same percentage: Xero's EffectiveRate, else DisplayTaxRate, against the rate column AND the percentage tax is computed at (the active components'). Never rounded.
 *   SIDE       the live type must be allowed on every side the IMS rate is used for (stored canApply.revenue for sales, canApply.expenses for purchases).
 *   MEANING    the component breakdown must be the same (count, each component's rate, compound flag; no non-recoverable component): componentMeaningDifference.
 *   COUNTRY    where the IMS rate has a countryCode and the Xero name starts with a two-letter country prefix ("CY VAT"), they must agree.
 * It NEVER matches by code. Each rate gets ONE outcome (REKEY_OUTCOMES). Two further conditions are BLOCKERS that refuse the apply: two rates re-keying to one live type, and a live
 * type already carried by another active IMS rate that stays (a code on two active rates is ambiguous).
 *
 * THE APPLY (explicit). `confirm` must be the digest of the plan the operator saw. In ONE transaction inside the Xero connection fence (the lock #797's import takes, so a rebind or a second
 * run cannot interleave) the plan is rebuilt from the locked state; a different digest writes NOTHING. For each REKEY it then:
 *   1. creates a NEW TaxRate (a component's own custom code that is not a live ACTIVE type is cleared to null on the new row, and listed in the plan) with the live code and the same name, rate, type, category, usedFor, country, flags and components; the old row is NEVER edited (documents reference it): it is only
 *      deactivated (and loses isDefault, which the new row takes);
 *   2. re-points the supplier default tax rates and the WooCommerce rate mappings (ShoppingTaxRateMapping) to the new row;
 *   3. OPEN DOCUMENTS (see below): documents and payloads already sent are not touched; documents that can still post are re-pointed only on request.
 * A re-run finds the old rows inactive and the new rows ALREADY_CORRECT, so it writes nothing.
 *
 * OPEN DOCUMENTS - the decision. A document line posts the code of the TaxRate it references whenever a Xero document is BUILT from it, not once. The paths that read
 * `line.taxRate.accountingTaxType` at send time:
 *   sales   app/actions/sales.ts queueSalesInvoiceForOrder (~1330-1445: the first SALES_INVOICE and every SALES_INVOICE_UPDATE after an edit), the credit
 *           note / refund accounting actions from an existing invoice (queueRefundAccountingActions, ~2000-2052), app/actions/sync-exceptions.ts (~1374, ~2751: re-send / credit-note rebuilds) and lib/domain/sales/refund-posted-tax-identity.ts
 *           (~334, ~836: a refund resolves its line identity from the original line's rate);
 *   purchase app/actions/purchase-orders.ts createInvoice (~3096-3186: EVERY bill, including the bill for the quantity still to bill on a part-billed PO), updateInvoice
 *           (~3465-3586), postSupplierCreditNote (~4505-4559) and lib/domain/purchasing/purchase-invoice-edit.ts (~208: PURCHASE_INVOICE_UPDATE).
 * A queued payload, by contrast, is a SNAPSHOT: lines[].taxType is sent as stored (lib/connectors/xero/sync-processor.ts). So after a re-key:
 *   - EVERY not-cancelled document whose lines reference the old row is a FUTURE POSTING SOURCE, posted or not: it would send the OLD code on its next build. They BLOCK the apply
 *     (UNPOSTED_DOCUMENTS, counts split into never-posted and already-posted) unless the operator passes the explicit flag, which re-points those lines to the new row. Documents
 *     and payloads that already went to Xero are not touched. Is a posted document's next update then a change of meaning? No: the new row is the live type of the SAME name,
 *     ACTIVE, with the same percentage, the same sides and the same component breakdown (the plan refuses otherwise), so the same tax meaning by construction; the old code was the
 *     other organisation's number, so the update is a correction. No amount changes (same percentage). Cancelled documents are left on the old row.
 *   - REFUND-LINE SNAPSHOTS: SalesOrderRefundLine.accountingTaxType is resolved at refund creation (lib/domain/sales/refund-service.ts) and the credit note build / retry prefers it to the
 *     order line's rate (lib/domain/sales/refund-posted-tax-identity.ts creditNoteLineTaxTypeResolver ~922-938 returns `refundLine.accountingTaxType`; priceSnapshottedTaxIdentity ~977). A refund
 *     whose credit note is not posted (SalesOrderRefund.accountingCreditNoteId null) may have no queued payload yet (enqueue failed / not yet run), so nothing else would stop the old
 *     code going out. They BLOCK the apply (PENDING_REFUND_SNAPSHOTS); with the flag their snapshot code is migrated to the new code, but only when the old code means the old row alone
 *     (no other IMS rate of another name or percentage carries it - else REFUND_SNAPSHOT_IDENTITY, no override). Posted credit notes are history. Other stored tax-type snapshots:
 *     accounting_sync_logs.payload and accounting_events.linesJson (in-flight ones block via QUEUED_PAYLOADS; sent ones are history); TaxRateComponent.accountingTaxType (cleared above);
 *     the reverse-charge tax-type SETTINGS (accounting_reverse_charge_*_tax_type) are separate configuration, reported not changed. No other model stores a tax type.
 *   - QUEUED payloads (an accounting sync row PENDING / PROCESSING / FAILED - a FAILED row keeps blocking until it is retried or cancelled - or an accounting event PENDING / FAILED,
 *     whose lines carry the old code) are snapshots IMS does not rewrite. They BLOCK the apply (QUEUED_PAYLOADS) with no override: let them post, or cancel them, first.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { readStoredXeroList, type PurchaseTaxImportRefusalCode } from '@/lib/tax/purchase-tax-import'
import { imsEffectivePercent, type ImsComponentRow } from '@/lib/tax/vat-difference-report'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'
import { REKEY_OUTCOMES, type RekeyOutcome } from '@/lib/tax/tax-rekey-outcomes'

export { REKEY_OUTCOMES, REKEY_OUTCOME_MEANING, type RekeyOutcome } from '@/lib/tax/tax-rekey-outcomes'

type Client = Prisma.TransactionClient
const Dec = Prisma.Decimal
type Dec = InstanceType<typeof Prisma.Decimal>

export const REKEY_BLOCKER_CODES = ['DUPLICATE_TARGET', 'TARGET_CODE_HELD'] as const
export type RekeyBlockerCode = (typeof REKEY_BLOCKER_CODES)[number]
export interface RekeyBlocker { code: RekeyBlockerCode; imsRateId: string; taxType: string; detail: string }

export const REKEY_REFUSAL_CODES = [
  'XERO_NOT_CONNECTED', 'XERO_CONNECTION_CHANGED', 'XERO_LIST_MISSING', 'XERO_LIST_UNREADABLE', 'XERO_LIST_NOT_STAMPED', 'XERO_LIST_STALE', 'XERO_LIST_WRONG_ORGANISATION',
  'CONFIRM_REQUIRED', 'DIGEST_MISMATCH', 'PLAN_HAS_BLOCKERS', 'UNPOSTED_DOCUMENTS', 'QUEUED_PAYLOADS', 'PENDING_REFUND_SNAPSHOTS', 'REFUND_SNAPSHOT_IDENTITY',
] as const
export type RekeyRefusalCode = (typeof REKEY_REFUSAL_CODES)[number]
export interface RekeyRefusal { code: RekeyRefusalCode; detail: string }

export interface RekeyImsRate {
  id: string
  name: string
  /** Fraction text, Decimal(5,4), for example "0.1900". */
  rate: string
  usedFor: string
  countryCode: string | null
  accountingTaxType: string | null
  isDefault: boolean
  components: Array<ImsComponentRow & { name?: string; accountingTaxType?: string | null }>
}

export interface RekeyClearedComponent { sortOrder: number; name: string; taxType: string }

export interface RekeyCandidate { taxType: string; name: string; status: string; percent: string | null }

export interface RekeyRow {
  imsRateId: string
  name: string
  usedFor: string
  countryCode: string | null
  currentCode: string
  outcome: RekeyOutcome
  /** Which comparison found the name: exact (trimmed, case-sensitive) or case-insensitive (only tried when exact found nothing). null when no live type has the name. */
  matchedBy: 'EXACT' | 'CASE_INSENSITIVE' | null
  /** The live type the rate is (or would be) tied to: set for ALREADY_CORRECT, REKEY and PERCENTAGE_DIFFERS. */
  target: RekeyCandidate | null
  /** Every live type with the name (any status), for a person to read. */
  candidates: RekeyCandidate[]
  /** Percent text. */
  imsPercent: string
  /** The percentage tax is computed at (active components), when it differs from the column. */
  imsEffectivePercent: string | null
  reason: string
  /** REKEY only: components of the old rate whose own custom code is not a live ACTIVE type; the new row's copy of each gets null (as the importer writes). Built-in and live-valid codes are kept. */
  clearedComponents: RekeyClearedComponent[]
}

export interface RekeyReferences {
  suppliers: number
  storefrontMappings: number
  isDefault: boolean
  /** Documents (not cancelled) that reference the old row and have NO posting evidence yet: the first post will read the old code. */
  unpostedSalesOrders: number
  unpostedSalesOrderLines: number
  unpostedPurchaseOrders: number
  unpostedPurchaseOrderLines: number
  /** Documents (not cancelled) that reference the old row and HAVE posted: an edit / re-send / credit note / refund / further bill re-reads the line's rate, so they are future posting sources too. */
  postedSalesOrders: number
  postedSalesOrderLines: number
  postedPurchaseOrders: number
  postedPurchaseOrderLines: number
  /**
   * Refund lines (SalesOrderRefundLine.accountingTaxType, resolved at creation and preferred over the order line's rate when the credit note is built or retried) that carry the old code on
   * a refund whose credit note is not posted (SalesOrderRefund.accountingCreditNoteId null): no queued payload exists to block on, but a later enqueue / retry would send the old code.
   */
  pendingRefunds: number
  pendingRefundLines: number
  /** True when another IMS rate (any status) carries the old code with another name or percentage: the snapshot's tax identity is then not the old row's, and it is not migrated. */
  refundSnapshotConflict: boolean
  /** Queued payloads whose lines carry the old code. */
  queuedSyncRows: number
  queuedEvents: number
}

export interface RekeyPlan {
  list: { tenantId: string; fetchedAt: string; rowCount: number; digest: string }
  /** Active IMS rates looked at (custom code) / left alone (no code, or a Xero built-in). */
  inScope: number
  outOfScope: number
  rows: RekeyRow[]
  counts: Record<RekeyOutcome, number>
  blockers: RekeyBlocker[]
  /** Per REKEY row, keyed by the old IMS rate id. */
  references: Record<string, RekeyReferences>
  /** Sha-256 of the plan's decision-bearing content. The apply needs exactly this. */
  digest: string
}

export type RekeyPlanRead = { ok: true; plan: RekeyPlan } | { ok: false; refusal: RekeyRefusal }

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = { UK: 'GB', EL: 'GR' }
const normaliseCountry = (code: string): string => {
  const upper = code.trim().toUpperCase()
  return ALIASES[upper] ?? upper
}

/** "CY VAT" -> "CY"; a name with no leading two-capital-letter word gives null. */
export function xeroNameCountry(name: string): string | null {
  const match = /^([A-Z]{2})(?:[\s-]|$)/.exec(name.trim())
  return match ? normaliseCountry(match[1]!) : null
}

const sides = (usedFor: string): readonly string[] => (usedFor === 'BOTH' ? ['SALES', 'PURCHASE'] : [usedFor])
const overlap = (a: string, b: string): boolean => sides(a).some((side) => sides(b).includes(side))
const statedPercent = (row: NormalisedXeroTaxRate): Dec | null => {
  const stated = row.effectiveRate ?? row.displayTaxRate
  return stated === null ? null : new Dec(stated)
}
/**
 * Do the IMS rate and the live type tax the same way? Each side is reduced to its ordered components (rate, compound): the IMS rate's ACTIVE components, else one component at the
 * rate column when it is above zero; the live type's stored components (Xero's TaxComponents: name, rate, compound, nonRecoverable), else one at its stated percentage. Names are not
 * compared. A non-recoverable live component can't be expressed by an IMS rate (the importer refuses it for the same reason). Returns why they differ, or null.
 */
export function componentMeaningDifference(rate: Pick<RekeyImsRate, 'rate' | 'components'>, live: NormalisedXeroTaxRate): string | null {
  if (live.components.some((c) => c.nonRecoverable)) return 'the live type has a non-recoverable component, which an IMS rate cannot express'
  const column = new Dec(rate.rate).mul(100)
  const imsActive = rate.components.filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder)
  const ims = imsActive.length > 0 ? imsActive.map((c) => ({ rate: new Dec(c.rate).mul(100), compound: c.compoundOnPrevious })) : column.gt(0) ? [{ rate: column, compound: false }] : []
  const stated = statedPercent(live)
  const theirs = live.components.length > 0 ? live.components.map((c) => ({ rate: new Dec(c.rate), compound: c.compound })) : stated !== null && stated.gt(0) ? [{ rate: stated, compound: false }] : []
  if (ims.length !== theirs.length) return `the IMS rate has ${ims.length} component(s), the live type ${theirs.length}`
  for (const [index, mine] of ims.entries()) {
    if (!mine.rate.eq(theirs[index]!.rate)) return `component ${index + 1} is ${mine.rate.toFixed()}% in IMS and ${theirs[index]!.rate.toFixed()}% in Xero`
    if (mine.compound !== theirs[index]!.compound) return `component ${index + 1} differs on compounding`
  }
  return null
}
const candidateOf = (row: NormalisedXeroTaxRate): RekeyCandidate => ({ taxType: row.taxType, name: row.name, status: row.status, percent: statedPercent(row)?.toFixed() ?? null })

/**
 * Decide the outcome of every active rate with an organisation-specific code. Pure over its inputs; the stored list must already be proven. `rates` is EVERY active IMS rate (the
 * blockers need to see the codes the others hold).
 */
export function matchRekeyRates(input: { rates: readonly RekeyImsRate[]; xero: readonly NormalisedXeroTaxRate[] }): Pick<RekeyPlan, 'inScope' | 'outOfScope' | 'rows' | 'counts' | 'blockers'> {
  const { rates, xero } = input
  const scoped = rates.filter((rate) => rate.accountingTaxType !== null && isOrganisationSpecificTaxType(rate.accountingTaxType))
  const rows: RekeyRow[] = []
  for (const rate of [...scoped].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const currentCode = rate.accountingTaxType!
    const name = rate.name.trim()
    const column = new Dec(rate.rate).mul(100)
    const effective = imsEffectivePercent(rate)
    const base = {
      imsRateId: rate.id, name: rate.name, usedFor: rate.usedFor, countryCode: rate.countryCode, currentCode,
      imsPercent: column.toFixed(), imsEffectivePercent: effective.eq(column) ? null : effective.toFixed(),
    }
    const exact = xero.filter((row) => row.name.trim() === name)
    const tier = exact.length > 0 ? exact : xero.filter((row) => row.name.trim().toLowerCase() === name.toLowerCase())
    const matchedBy = exact.length > 0 ? 'EXACT' as const : tier.length > 0 ? 'CASE_INSENSITIVE' as const : null
    const candidates = tier.map(candidateOf)
    const done = (outcome: RekeyOutcome, target: NormalisedXeroTaxRate | null, reason: string): void => {
      const cleared: RekeyClearedComponent[] = []
      if (outcome === 'REKEY') {
        for (const [index, c] of rate.components.entries()) {
          const t = c.accountingTaxType ?? null
          if (t === null || !isOrganisationSpecificTaxType(t)) continue
          if (xero.some((x) => x.taxType === t && x.status === 'ACTIVE')) continue
          cleared.push({ sortOrder: c.sortOrder ?? index, name: c.name ?? '', taxType: t })
        }
      }
      rows.push({ ...base, outcome, matchedBy, target: target === null ? null : candidateOf(target), candidates, reason, clearedComponents: cleared })
    }
    if (tier.length === 0) { done('NO_MATCH', null, 'no live Xero tax type has this name'); continue }
    const active = tier.filter((row) => row.status === 'ACTIVE')
    if (active.length === 0) { done('NAME_MATCHES_INACTIVE', null, `the live type(s) with this name are ${[...new Set(tier.map((row) => row.status))].join('/')}, not ACTIVE`); continue }
    const imsCountry = rate.countryCode === null || rate.countryCode.trim() === '' ? null : normaliseCountry(rate.countryCode)
    const compatible = active.filter((row) => {
      const prefix = xeroNameCountry(row.name)
      return imsCountry === null || prefix === null || prefix === imsCountry
    })
    if (compatible.length === 0) { done('NO_MATCH', null, `the active live type(s) with this name carry another country (IMS ${imsCountry})`); continue }
    if (compatible.length > 1) { done('AMBIGUOUS', null, `${compatible.length} active live types have this name: ${compatible.map((row) => row.taxType).sort().join(', ')}`); continue }
    const live = compatible[0]!
    const percent = statedPercent(live)
    if (percent === null) { done('PERCENTAGE_DIFFERS', live, 'Xero states no percentage for the live type'); continue }
    if (!percent.eq(column) || !percent.eq(effective)) {
      done('PERCENTAGE_DIFFERS', live, `the live type is ${percent.toFixed()}% but the IMS rate is ${column.toFixed()}%${effective.eq(column) ? '' : ` (computed at ${effective.toFixed()}%)`}`)
      continue
    }
    // Applicability (stored list: canApply.revenue / canApply.expenses, from Xero's CanApplyToRevenue / CanApplyToExpenses): every side the IMS rate is used for must be allowed.
    const wrongSides = sides(rate.usedFor).filter((side) => (side === 'SALES' ? live.canApply.revenue : live.canApply.expenses) !== true)
    if (wrongSides.length > 0) { done('SIDE_NOT_ALLOWED', live, `Xero does not allow ${live.taxType} on ${wrongSides.map((side) => (side === 'SALES' ? 'revenue' : 'expenses')).join(' and ')}, which the IMS rate is used for`); continue }
    // Component treatment (stored list: components[] = name, rate, compound, nonRecoverable): same count, each rate, each compound flag, nothing non-recoverable.
    const meaning = componentMeaningDifference(rate, live)
    if (meaning !== null) { done('MEANING_DIFFERS', live, meaning); continue }
    done(live.taxType === currentCode ? 'ALREADY_CORRECT' : 'REKEY', live, live.taxType === currentCode ? 'the code is already the live type of this name' : `live type ${live.taxType} has this name; ${currentCode} does not`)
  }

  const counts = Object.fromEntries(REKEY_OUTCOMES.map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length])) as Record<RekeyOutcome, number>
  const blockers: RekeyBlocker[] = []
  const moving = rows.filter((row) => row.outcome === 'REKEY')
  const movingIds = new Set(moving.map((row) => row.imsRateId))
  const byId = new Map(rates.map((rate) => [rate.id, rate] as const))
  for (const row of moving) {
    const type = row.target!.taxType
    for (const other of moving) {
      if (other.imsRateId > row.imsRateId && other.target!.taxType === type && overlap(row.usedFor, other.usedFor)) {
        blockers.push({ code: 'DUPLICATE_TARGET', imsRateId: row.imsRateId, taxType: type, detail: `"${row.name}" and "${other.name}" would both be tied to ${type} on an overlapping side` })
      }
    }
    for (const holder of rates) {
      if (movingIds.has(holder.id) || holder.id === row.imsRateId || holder.accountingTaxType !== type || !overlap(row.usedFor, holder.usedFor)) continue
      blockers.push({ code: 'TARGET_CODE_HELD', imsRateId: row.imsRateId, taxType: type, detail: `${type} is already carried by the active IMS rate "${byId.get(holder.id)!.name}" which stays: two active rates on one code would be ambiguous` })
    }
  }
  blockers.sort((a, b) => a.imsRateId.localeCompare(b.imsRateId) || a.code.localeCompare(b.code) || a.taxType.localeCompare(b.taxType))
  return { inScope: scoped.length, outOfScope: rates.length - scoped.length, rows, counts, blockers }
}

/** A canonical, order-independent digest of everything the apply decides on. Not the list's fetch time (the hourly job moves it without changing a row), but the list's own digest. */
export function digestRekeyPlan(plan: Pick<RekeyPlan, 'list' | 'rows' | 'blockers' | 'references'>): string {
  const refs = Object.keys(plan.references).sort().map((id) => {
    return [id, plan.references[id]!] as const
  })
  const canonical = { v: 1, tenantId: plan.list.tenantId, list: plan.list.digest, rows: plan.rows, blockers: plan.blockers, references: refs }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** The IMS rates as they stand after a plan's REKEY rows are applied (a pure projection of what the write does), for the VAT difference report's compare. */
export function projectRatesAfterRekey<T extends { id: string; name: string; active: boolean; accountingTaxType: string | null; usedFor: string }>(rates: readonly T[], plan: Pick<RekeyPlan, 'rows'>): T[] {
  const out: T[] = []
  for (const rate of rates) {
    const row = plan.rows.find((r) => r.outcome === 'REKEY' && r.imsRateId === rate.id)
    if (row === undefined) { out.push(rate); continue }
    out.push({ ...rate, active: false })
    out.push({ ...rate, id: `${rate.id}:rekeyed`, accountingTaxType: row.target!.taxType, active: true })
  }
  return out
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SALES_INVOICE_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const
const IN_FLIGHT_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const
const IN_FLIGHT_EVENT_STATUSES = ['PENDING', 'FAILED'] as const

/**
 * The not-cancelled sales orders / purchase orders that reference `rateId`, split by whether they have posted. BOTH kinds can still post the line's rate code, so both are future posting
 * sources (see the header). Cancelled documents are left alone. Reads only.
 */
export async function openDocumentsOf(client: Client, rateId: string): Promise<{
  salesOrderIds: string[]; unpostedSalesOrders: number; unpostedSalesLines: number; postedSalesOrders: number; postedSalesLines: number
  purchaseOrderIds: string[]; unpostedPurchaseOrders: number; unpostedPurchaseLines: number; postedPurchaseOrders: number; postedPurchaseLines: number
}> {
  const orders = await client.salesOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, accountingInvoiceId: true, invoicedAt: true, invoiceNumber: true, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  const orderIds = orders.map((order) => order.id)
  const logs = orderIds.length === 0 ? [] : await client.accountingSyncLog.findMany({ where: { referenceType: 'SalesOrder', referenceId: { in: orderIds }, type: { in: [...SALES_INVOICE_TYPES] } }, select: { referenceId: true } })
  const events = orderIds.length === 0 ? [] : await client.accountingEvent.findMany({ where: { sourceEntityType: 'SalesOrder', sourceEntityId: { in: orderIds } }, select: { sourceEntityId: true } })
  const touched = new Set([...logs.map((l) => l.referenceId), ...events.map((e) => e.sourceEntityId)])
  const out = { salesOrderIds: [] as string[], unpostedSalesOrders: 0, unpostedSalesLines: 0, postedSalesOrders: 0, postedSalesLines: 0, purchaseOrderIds: [] as string[], unpostedPurchaseOrders: 0, unpostedPurchaseLines: 0, postedPurchaseOrders: 0, postedPurchaseLines: 0 }
  for (const order of orders) {
    if (order.status === 'CANCELLED') continue
    out.salesOrderIds.push(order.id)
    const posted = order.accountingInvoiceId !== null || order.invoicedAt !== null || order.invoiceNumber !== null || touched.has(order.id)
    if (posted) { out.postedSalesOrders += 1; out.postedSalesLines += order.lines.length } else { out.unpostedSalesOrders += 1; out.unpostedSalesLines += order.lines.length }
  }
  const pos = await client.purchaseOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, invoices: { select: { id: true }, take: 1 }, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  for (const po of pos) {
    if (po.status === 'CANCELLED') continue
    out.purchaseOrderIds.push(po.id)
    if (po.invoices.length > 0) { out.postedPurchaseOrders += 1; out.postedPurchaseLines += po.lines.length } else { out.unpostedPurchaseOrders += 1; out.unpostedPurchaseLines += po.lines.length }
  }
  out.salesOrderIds.sort()
  out.purchaseOrderIds.sort()
  return out
}

async function queuedCounts(client: Client, taxType: string): Promise<{ syncRows: number; events: number }> {
  const syncRows = await client.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM accounting_sync_logs
    WHERE status::text = ANY(${[...IN_FLIGHT_SYNC_STATUSES]}) AND payload IS NOT NULL
      AND jsonb_path_exists(payload::jsonb, '$.** ? (@.taxType == $t)', jsonb_build_object('t', ${taxType}::text))`
  const events = await client.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM accounting_events
    WHERE status = ANY(${[...IN_FLIGHT_EVENT_STATUSES]})
      AND jsonb_path_exists("linesJson"::jsonb, '$.** ? (@.taxType == $t)', jsonb_build_object('t', ${taxType}::text))`
  return { syncRows: Number(syncRows[0]?.n ?? 0), events: Number(events[0]?.n ?? 0) }
}

/** The refund-line snapshots (see RekeyReferences.pendingRefundLines) on not-yet-posted refunds that carry `code`. */
async function pendingRefundSnapshots(client: Client, code: string): Promise<{ refunds: number; lines: number }> {
  const lines = await client.salesOrderRefundLine.findMany({ where: { accountingTaxType: code, refund: { accountingCreditNoteId: null } }, select: { refundId: true } })
  return { refunds: new Set(lines.map((l) => l.refundId)).size, lines: lines.length }
}

async function referencesOf(client: Client, row: RekeyRow, isDefault: boolean): Promise<RekeyReferences> {
  const [suppliers, storefrontMappings, open, queued, refunds, sharing] = await Promise.all([
    client.supplier.count({ where: { taxRateId: row.imsRateId } }),
    client.shoppingTaxRateMapping.count({ where: { taxRateId: row.imsRateId } }),
    openDocumentsOf(client, row.imsRateId),
    queuedCounts(client, row.currentCode),
    pendingRefundSnapshots(client, row.currentCode),
    client.taxRate.findMany({ where: { accountingTaxType: row.currentCode, id: { not: row.imsRateId } }, select: { id: true, name: true, rate: true, accountingTaxType: true } }),
  ])
  const refundSnapshotConflict = sharing.some((other) => other.id !== row.imsRateId && other.accountingTaxType === row.currentCode
    && (other.name.trim() !== row.name.trim() || !new Dec(other.rate.toFixed(4)).mul(100).eq(row.imsPercent)))
  return {
    suppliers, storefrontMappings, isDefault,
    unpostedSalesOrders: open.unpostedSalesOrders, unpostedSalesOrderLines: open.unpostedSalesLines,
    unpostedPurchaseOrders: open.unpostedPurchaseOrders, unpostedPurchaseOrderLines: open.unpostedPurchaseLines,
    postedSalesOrders: open.postedSalesOrders, postedSalesOrderLines: open.postedSalesLines,
    postedPurchaseOrders: open.postedPurchaseOrders, postedPurchaseOrderLines: open.postedPurchaseLines,
    pendingRefunds: refunds.refunds, pendingRefundLines: refunds.lines, refundSnapshotConflict,
    queuedSyncRows: queued.syncRows, queuedEvents: queued.events,
  }
}

/**
 * Build the plan: prove the stored list (same checks as the import), read the active IMS rates, match, count the references. Read only. `client` is the plain client for a preview
 * and the fence's transaction for an apply. Total over a database that answers: a list that cannot be proven is a named refusal, never a plan.
 */
export async function readRekeyPlan(client: Client, options: { now: Date; connectedTenantId: string | null }): Promise<RekeyPlanRead> {
  const read = await readStoredXeroList(client, options.now, options.connectedTenantId)
  if (!read.ok) {
    const code = (REKEY_REFUSAL_CODES as readonly string[]).includes(read.refusal.code) ? (read.refusal.code as PurchaseTaxImportRefusalCode as RekeyRefusalCode) : 'XERO_LIST_UNREADABLE'
    return { ok: false, refusal: { code, detail: read.refusal.detail } }
  }
  const stored = await client.taxRate.findMany({
    where: { active: true },
    select: { id: true, name: true, rate: true, usedFor: true, countryCode: true, accountingTaxType: true, isDefault: true, components: { select: { name: true, rate: true, compoundOnPrevious: true, accountingTaxType: true, active: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  const rates: RekeyImsRate[] = stored.map((r) => ({
    id: r.id, name: r.name, rate: r.rate.toFixed(4), usedFor: r.usedFor, countryCode: r.countryCode, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault,
    components: r.components.map((c) => ({ name: c.name, rate: c.rate.toFixed(4), compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: c.accountingTaxType, active: c.active, sortOrder: c.sortOrder })),
  }))
  const matched = matchRekeyRates({ rates, xero: read.list.rows })
  const references: Record<string, RekeyReferences> = {}
  for (const row of matched.rows) {
    if (row.outcome !== 'REKEY') continue
    references[row.imsRateId] = await referencesOf(client, row, rates.find((r) => r.id === row.imsRateId)!.isDefault)
  }
  const list = { tenantId: read.list.tenantId, fetchedAt: read.list.fetchedAt.toISOString(), rowCount: read.list.rows.length, digest: digestTaxRateList(read.list.tenantId, read.list.rows) }
  const plan: RekeyPlan = { list, ...matched, references, digest: '' }
  plan.digest = digestRekeyPlan(plan)
  return { ok: true, plan }
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

export interface RekeyWriteResult {
  created: Array<{ oldId: string; newId: string; name: string; fromCode: string; toCode: string }>
  suppliersRepointed: number
  mappingsRepointed: number
  salesLinesRepointed: number
  purchaseLinesRepointed: number
  refundLinesRepointed: number
}

/**
 * Write what `plan` says, INSIDE the caller's transaction (the fence's), over a plan rebuilt in that same transaction. Touches tax_rates / tax_rate_components by create and by the
 * old row's active + isDefault flags only, and the taxRateId of suppliers, storefront mappings and (only with `allowUnposted`) unposted document lines. The old row's name, rate, code
 * and components are never written. The re-point statements name the old row's id, so a re-run (old row inactive, nothing referencing it) matches nothing.
 */
export async function writeTaxRekey(tx: Client, plan: RekeyPlan, options: { allowUnposted: boolean }): Promise<RekeyWriteResult> {
  const result: RekeyWriteResult = { created: [], suppliersRepointed: 0, mappingsRepointed: 0, salesLinesRepointed: 0, purchaseLinesRepointed: 0, refundLinesRepointed: 0 }
  for (const row of plan.rows) {
    if (row.outcome !== 'REKEY') continue
    const old = await tx.taxRate.findUnique({ where: { id: row.imsRateId }, include: { components: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } })
    if (old === null || !old.active || old.accountingTaxType !== row.currentCode) throw new Error(`rate ${row.imsRateId} changed since the plan was built`)
    const toCode = row.target!.taxType
    const fresh = await tx.taxRate.create({
      data: {
        name: old.name, rate: old.rate, type: old.type, taxCategory: old.taxCategory, usedFor: old.usedFor, accountingTaxType: toCode, countryCode: old.countryCode,
        isCompound: old.isCompound, reverseCharge: old.reverseCharge, reportingCategory: old.reportingCategory, active: true, isDefault: old.isDefault,
        components: old.components.length === 0 ? undefined : {
          create: old.components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: row.clearedComponents.some((x) => x.sortOrder === c.sortOrder && x.taxType === c.accountingTaxType) ? null : c.accountingTaxType, sortOrder: c.sortOrder, active: c.active })),
        },
      },
      select: { id: true },
    })
    const deactivated = await tx.taxRate.updateMany({ where: { id: old.id, active: true, accountingTaxType: row.currentCode }, data: { active: false, isDefault: false } })
    if (deactivated.count !== 1) throw new Error(`rate ${row.imsRateId} could not be deactivated`)
    result.suppliersRepointed += (await tx.supplier.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    result.mappingsRepointed += (await tx.shoppingTaxRateMapping.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    if (options.allowUnposted) {
      // Refund-line snapshots on refunds not yet posted: migrated only when the snapshot's tax identity IS the old row's (the plan refused otherwise).
      const snap = plan.references[row.imsRateId]
      if (snap !== undefined && snap.pendingRefundLines > 0 && !snap.refundSnapshotConflict) {
        result.refundLinesRepointed += (await tx.salesOrderRefundLine.updateMany({ where: { accountingTaxType: row.currentCode, refund: { accountingCreditNoteId: null } }, data: { accountingTaxType: toCode } })).count
      }
      const open = await openDocumentsOf(tx, old.id)
      if (open.salesOrderIds.length > 0) result.salesLinesRepointed += (await tx.salesOrderLine.updateMany({ where: { taxRateId: old.id, orderId: { in: open.salesOrderIds } }, data: { taxRateId: fresh.id } })).count
      if (open.purchaseOrderIds.length > 0) result.purchaseLinesRepointed += (await tx.purchaseOrderLine.updateMany({ where: { taxRateId: old.id, poId: { in: open.purchaseOrderIds } }, data: { taxRateId: fresh.id } })).count
    }
    result.created.push({ oldId: old.id, newId: fresh.id, name: old.name, fromCode: row.currentCode, toCode })
  }
  if (result.created.length > 0) {
    await tx.activityLog.create({
      data: {
        entityType: 'SETTING', entityId: null, action: 'tax_rates_rekeyed_to_xero_codes', tag: 'settings', level: 'INFO',
        description: `Re-keyed ${result.created.length} IMS tax rate(s) to the custom tax codes of the connected Xero organisation (new rows created, old rows deactivated, defaults and storefront mappings re-pointed)`,
        metadata: { planDigest: plan.digest, allowUnposted: options.allowUnposted, ...result },
      },
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

export interface TaxRekeyRunOptions {
  apply: boolean
  /** The plan digest the operator saw. Required by an apply. */
  confirm?: string
  /** Also re-point the lines of unposted documents (otherwise they block the apply). */
  allowUnposted?: boolean
  now?: Date
}

export interface TaxRekeyRunResult {
  applied: boolean
  wrote: boolean
  plan: RekeyPlan | null
  refusal: RekeyRefusal | null
  written: RekeyWriteResult | null
}

const DIGEST_RE = /^[0-9a-f]{64}$/

/** Why an apply must not proceed on this (locked) plan, or null. Pure. */
export function applyRefusal(plan: RekeyPlan, allowUnposted: boolean): RekeyRefusal | null {
  if (plan.blockers.length > 0) return { code: 'PLAN_HAS_BLOCKERS', detail: plan.blockers.map((b) => `${b.code} ${b.taxType}`).join(', ') }
  const refs = Object.values(plan.references)
  const queued = refs.reduce((n, r) => n + r.queuedSyncRows + r.queuedEvents, 0)
  if (queued > 0) return { code: 'QUEUED_PAYLOADS', detail: `${queued} queued accounting payload(s) still carry a code being re-keyed; let them post or cancel them first` }
  const conflicted = refs.filter((r) => r.pendingRefundLines > 0 && r.refundSnapshotConflict).length
  if (conflicted > 0) return { code: 'REFUND_SNAPSHOT_IDENTITY', detail: `${conflicted} re-keyed rate(s) share their old code with a rate of another name or percentage, so the pending refund lines that carry it cannot be shown to mean the old row; resolve them first (no override)` }
  const pendingRefunds = refs.reduce((n, r) => n + r.pendingRefundLines, 0)
  if (pendingRefunds > 0 && !allowUnposted) return { code: 'PENDING_REFUND_SNAPSHOTS', detail: `${pendingRefunds} refund line(s) on refunds not yet posted carry a tax code being re-keyed in their stored snapshot (a later enqueue or retry prefers it to the order line's rate); pass the explicit flag to migrate them` }
  const sources = refs.reduce((n, r) => n + r.unpostedSalesOrders + r.unpostedPurchaseOrders + r.postedSalesOrders + r.postedPurchaseOrders, 0)
  if (sources > 0 && !allowUnposted) return { code: 'UNPOSTED_DOCUMENTS', detail: `${sources} order(s) (posted or not) still reference a rate being re-keyed and can post its old code (first post, edit, re-send, credit note, refund, further bill); pass the explicit flag to re-point their lines` }
  return null
}

/**
 * The action. A preview (`apply: false`) reads only. An apply rebuilds the plan INSIDE the connection fence's transaction (the mapping-selection lock: two runs, or a run and a rebind,
 * cannot interleave), refuses unless its digest is the one confirmed, and writes that plan. Nothing to re-key is a no-op, not a refusal (the idempotent re-run).
 */
export async function runTaxRekey(options: TaxRekeyRunOptions): Promise<TaxRekeyRunResult> {
  const refuse = (refusal: RekeyRefusal, plan: RekeyPlan | null = null): TaxRekeyRunResult => ({ applied: options.apply, wrote: false, plan, refusal, written: null })
  // Before the database is touched: an apply with no digest never reads anything.
  if (options.apply && (options.confirm === undefined || !DIGEST_RE.test(options.confirm))) return refuse({ code: 'CONFIRM_REQUIRED', detail: 'an apply needs the exact 64-character plan digest the operator saw in the preview' })
  const { db } = await import('@/lib/db')
  const { captureXeroConnection, withXeroConnectionFence } = await import('@/lib/connectors/xero/connection-fence')
  const now = options.now ?? new Date()
  const connection = await captureXeroConnection()
  const first = await readRekeyPlan(db as unknown as Client, { now, connectedTenantId: connection?.tenantId ?? null })
  if (!first.ok) return refuse(first.refusal)
  if (!options.apply) return { applied: false, wrote: false, plan: first.plan, refusal: null, written: null }
  if (connection === null) return refuse({ code: 'XERO_NOT_CONNECTED', detail: 'no Xero organisation is connected' }, first.plan)
  const seen: { plan: RekeyPlan | null } = { plan: null }
  const fenced = await withXeroConnectionFence(connection, async (tx) => {
    const read = await readRekeyPlan(tx, { now, connectedTenantId: connection.tenantId })
    if (!read.ok) return { refusal: read.refusal, plan: null as RekeyPlan | null, written: null as RekeyWriteResult | null }
    seen.plan = read.plan
    const plan = read.plan
    if (plan.counts.REKEY === 0 && plan.blockers.length === 0) return { refusal: null, plan, written: null }
    if (plan.digest !== options.confirm) return { refusal: { code: 'DIGEST_MISMATCH', detail: 'the plan changed since it was previewed (or this is not its digest); preview again' } as RekeyRefusal, plan, written: null }
    const refusal = applyRefusal(plan, options.allowUnposted === true)
    if (refusal !== null) return { refusal, plan, written: null }
    return { refusal: null, plan, written: await writeTaxRekey(tx, plan, { allowUnposted: options.allowUnposted === true }) }
  })
  if (!fenced.ok) return refuse({ code: 'XERO_CONNECTION_CHANGED', detail: fenced.error }, seen.plan ?? first.plan)
  const { refusal, plan, written } = fenced.value
  return { applied: true, wrote: written !== null && written.created.length > 0, plan: plan ?? first.plan, refusal, written }
}
