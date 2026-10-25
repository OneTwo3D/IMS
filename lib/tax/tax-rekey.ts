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
 *   COUNTRY    where the IMS rate has a countryCode and the Xero name starts with a two-letter country prefix ("CY VAT"), they must agree.
 * It NEVER matches by code. Each rate gets ONE outcome (REKEY_OUTCOMES). Two further conditions are BLOCKERS that refuse the apply: two rates re-keying to one live type, and a live
 * type already carried by another active IMS rate that stays (a code on two active rates is ambiguous).
 *
 * THE APPLY (explicit). `confirm` must be the digest of the plan the operator saw. In ONE transaction inside the Xero connection fence (the lock #797's import takes, so a rebind or a second
 * run cannot interleave) the plan is rebuilt from the locked state; a different digest writes NOTHING. For each REKEY it then:
 *   1. creates a NEW TaxRate with the live code and the same name, rate, type, category, usedFor, country, flags and components; the old row is NEVER edited (documents reference it): it is only
 *      deactivated (and loses isDefault, which the new row takes);
 *   2. re-points the supplier default tax rates and the WooCommerce rate mappings (ShoppingTaxRateMapping) to the new row;
 *   3. leaves every POSTED document on the old row: its posted meaning cannot change;
 *   4. OPEN DOCUMENTS (see below).
 * A re-run finds the old rows inactive and the new rows ALREADY_CORRECT, so it writes nothing.
 *
 * OPEN DOCUMENTS - the decision. A sales order line / purchase order line posts the code of the TaxRate it references AT SEND TIME: the sales invoice is built when it is enqueued
 * (app/actions/sales.ts enqueueSalesInvoiceSync: `l.taxRate.accountingTaxType` read from the line's row, copied into the queued payload), the supplier bill likewise when it is raised
 * (app/actions/purchase-orders.ts createPurchaseInvoice reads each po line's taxRate and `supplier.taxRate`). A queued payload, by contrast, is a SNAPSHOT: lines[].taxType is sent as stored
 * (lib/connectors/xero/sync-processor.ts). So after a re-key:
 *   - POSTED documents keep the old row and the code they posted. Unchanged, and not counted as a problem.
 *   - UNPOSTED documents (an order with no invoice number / invoice id / invoice sync row / accounting event; a PO with no bill; neither cancelled) would still post the OLD code when they
 *     are sent, because their lines reference the old row. They BLOCK the apply (UNPOSTED_DOCUMENTS, with counts) unless the operator passes the explicit flag, which re-points those
 *     lines to the new row (same name, same percentage: no amount changes).
 *   - QUEUED payloads (an accounting sync row PENDING / PROCESSING / FAILED, or an accounting event PENDING / FAILED, whose lines carry the old code) are snapshots IMS does not rewrite.
 *     They BLOCK the apply (QUEUED_PAYLOADS) with no override: let them post, or cancel them, first.
 * The rows an operator-confirmed apply would re-point are those counted in the plan the digest covers.
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
  'CONFIRM_REQUIRED', 'DIGEST_MISMATCH', 'PLAN_HAS_BLOCKERS', 'UNPOSTED_DOCUMENTS', 'QUEUED_PAYLOADS',
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
  components: ImsComponentRow[]
}

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
}

export interface RekeyReferences {
  suppliers: number
  storefrontMappings: number
  isDefault: boolean
  /** Unposted documents (and their lines) that reference the old row. */
  unpostedSalesOrders: number
  unpostedSalesOrderLines: number
  unpostedPurchaseOrders: number
  unpostedPurchaseOrderLines: number
  /** Queued payloads whose lines carry the old code. */
  queuedSyncRows: number
  queuedEvents: number
  /** Information only (not in the digest): lines on posted documents, which stay on the old row. */
  postedSalesOrderLines: number
  postedPurchaseOrderLines: number
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
      rows.push({ ...base, outcome, matchedBy, target: target === null ? null : candidateOf(target), candidates, reason })
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
    const r = plan.references[id]!
    // Without the posted-line counts: information only, and they move whenever a document posts.
    return [id, {
      suppliers: r.suppliers, storefrontMappings: r.storefrontMappings, isDefault: r.isDefault,
      unpostedSalesOrders: r.unpostedSalesOrders, unpostedSalesOrderLines: r.unpostedSalesOrderLines,
      unpostedPurchaseOrders: r.unpostedPurchaseOrders, unpostedPurchaseOrderLines: r.unpostedPurchaseOrderLines,
      queuedSyncRows: r.queuedSyncRows, queuedEvents: r.queuedEvents,
    }] as const
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

/** The sales orders / purchase orders that reference `rateId` and have not posted, plus the lines of posted ones (information). Reads only. */
export async function openDocumentsOf(client: Client, rateId: string): Promise<{ salesOrderIds: string[]; salesLines: number; purchaseOrderIds: string[]; purchaseLines: number; postedSalesLines: number; postedPurchaseLines: number }> {
  const orders = await client.salesOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, accountingInvoiceId: true, invoicedAt: true, invoiceNumber: true, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  const orderIds = orders.map((order) => order.id)
  const logs = orderIds.length === 0 ? [] : await client.accountingSyncLog.findMany({ where: { referenceType: 'SalesOrder', referenceId: { in: orderIds }, type: { in: [...SALES_INVOICE_TYPES] } }, select: { referenceId: true } })
  const events = orderIds.length === 0 ? [] : await client.accountingEvent.findMany({ where: { sourceEntityType: 'SalesOrder', sourceEntityId: { in: orderIds } }, select: { sourceEntityId: true } })
  const touched = new Set([...logs.map((l) => l.referenceId), ...events.map((e) => e.sourceEntityId)])
  const salesOrderIds: string[] = []
  let salesLines = 0
  let postedSalesLines = 0
  for (const order of orders) {
    if (order.status === 'CANCELLED') continue
    const posted = order.accountingInvoiceId !== null || order.invoicedAt !== null || order.invoiceNumber !== null || touched.has(order.id)
    if (posted) postedSalesLines += order.lines.length
    else { salesOrderIds.push(order.id); salesLines += order.lines.length }
  }
  const pos = await client.purchaseOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, invoices: { select: { id: true }, take: 1 }, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  const purchaseOrderIds: string[] = []
  let purchaseLines = 0
  let postedPurchaseLines = 0
  for (const po of pos) {
    if (po.status === 'CANCELLED') continue
    if (po.invoices.length > 0) postedPurchaseLines += po.lines.length
    else { purchaseOrderIds.push(po.id); purchaseLines += po.lines.length }
  }
  return { salesOrderIds: salesOrderIds.sort(), salesLines, purchaseOrderIds: purchaseOrderIds.sort(), purchaseLines, postedSalesLines, postedPurchaseLines }
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

async function referencesOf(client: Client, row: RekeyRow, isDefault: boolean): Promise<RekeyReferences> {
  const [suppliers, storefrontMappings, open, queued] = await Promise.all([
    client.supplier.count({ where: { taxRateId: row.imsRateId } }),
    client.shoppingTaxRateMapping.count({ where: { taxRateId: row.imsRateId } }),
    openDocumentsOf(client, row.imsRateId),
    queuedCounts(client, row.currentCode),
  ])
  return {
    suppliers, storefrontMappings, isDefault,
    unpostedSalesOrders: open.salesOrderIds.length, unpostedSalesOrderLines: open.salesLines,
    unpostedPurchaseOrders: open.purchaseOrderIds.length, unpostedPurchaseOrderLines: open.purchaseLines,
    queuedSyncRows: queued.syncRows, queuedEvents: queued.events,
    postedSalesOrderLines: open.postedSalesLines, postedPurchaseOrderLines: open.postedPurchaseLines,
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
    select: { id: true, name: true, rate: true, usedFor: true, countryCode: true, accountingTaxType: true, isDefault: true, components: { where: { active: true }, select: { rate: true, compoundOnPrevious: true, active: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  const rates: RekeyImsRate[] = stored.map((r) => ({
    id: r.id, name: r.name, rate: r.rate.toFixed(4), usedFor: r.usedFor, countryCode: r.countryCode, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault,
    components: r.components.map((c) => ({ rate: c.rate.toFixed(4), compoundOnPrevious: c.compoundOnPrevious, active: c.active, sortOrder: c.sortOrder })),
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
}

/**
 * Write what `plan` says, INSIDE the caller's transaction (the fence's), over a plan rebuilt in that same transaction. Touches tax_rates / tax_rate_components by create and by the
 * old row's active + isDefault flags only, and the taxRateId of suppliers, storefront mappings and (only with `allowUnposted`) unposted document lines. The old row's name, rate, code
 * and components are never written. The re-point statements name the old row's id, so a re-run (old row inactive, nothing referencing it) matches nothing.
 */
export async function writeTaxRekey(tx: Client, plan: RekeyPlan, options: { allowUnposted: boolean }): Promise<RekeyWriteResult> {
  const result: RekeyWriteResult = { created: [], suppliersRepointed: 0, mappingsRepointed: 0, salesLinesRepointed: 0, purchaseLinesRepointed: 0 }
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
          create: old.components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: c.accountingTaxType, sortOrder: c.sortOrder, active: c.active })),
        },
      },
      select: { id: true },
    })
    const deactivated = await tx.taxRate.updateMany({ where: { id: old.id, active: true, accountingTaxType: row.currentCode }, data: { active: false, isDefault: false } })
    if (deactivated.count !== 1) throw new Error(`rate ${row.imsRateId} could not be deactivated`)
    result.suppliersRepointed += (await tx.supplier.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    result.mappingsRepointed += (await tx.shoppingTaxRateMapping.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    if (options.allowUnposted) {
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
  const unposted = refs.reduce((n, r) => n + r.unpostedSalesOrders + r.unpostedPurchaseOrders, 0)
  if (unposted > 0 && !allowUnposted) return { code: 'UNPOSTED_DOCUMENTS', detail: `${unposted} unposted order(s) reference a rate being re-keyed and would post the old code; pass the explicit flag to re-point their lines` }
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
