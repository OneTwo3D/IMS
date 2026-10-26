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
 *   REPORT     the live type's ReportTaxType must equal the VAT-return box IMS assigns the rate: lib/connectors/xero/tax-rate-report-type.ts xeroReportTaxType (reportingCategory, side, the name's
 *              EU/VOEC country, zero rate) - the helper that creates Xero rates, so EU sales are MOSSSALES. A different box is REPORT_TYPE_DIFFERS (both values shown); a live type that states none, or a
 *              reporting category IMS does not map, is REPORT_TYPE_UNKNOWN (refused, not guessed). Checked for ALREADY_CORRECT too, and bound by the digest.
 *   COUNTRY    where the IMS rate has a countryCode and the Xero name starts with a two-letter country prefix ("CY VAT"), they must agree.
 * It NEVER matches by code. Each rate gets ONE outcome (REKEY_OUTCOMES). Two further conditions are BLOCKERS that refuse the apply: two rates re-keying to one live type, and a live
 * type already carried by another active IMS rate that stays (a code on two active rates is ambiguous).
 *
 * THE GUARANTEE: A RE-KEY IS A PRE-P2 OPERATION. The apply is refused (XERO_NOT_HELD) unless Xero writes are HELD: the producer-side hold is enforced for xero and no outbound grant /
 * live-from instant is in force (xeroHoldState below). While held every Xero producer writes a shadow that is never delivered, and the writer-side cut-off at go-live refuses to deliver
 * any row created before the live-from instant, so no payload built around the re-key - however long its producer paused between reading a rate and enqueueing - can reach Xero. The
 * enqueue guard (lib/tax/retired-tax-code-guard.ts) and the queued-payload block below are belt and braces on top of that.
 *
 * NO PARTIAL APPLY: the apply is refused (UNRESOLVED_RATES) while any in-scope active rate has an outcome other than REKEY or ALREADY_CORRECT, unless the clear choice (part of the plan and the
 * digest) turns each into a CLEAR row: retired like a re-key, but its replacement carries NO tax code and the old code joins the retired set. The connectors send NONE for a line with no tax type and
 * the invoice falls back to the order default's code, so the enqueue guard refuses a payload bound to a cleared rate (missing_tax_code) until someone maps it.
 *
 * WHAT THE DIGEST DOES NOT BIND: it binds the plan (rows, outcomes, targets, report types, cleared components, counts, the clear choice, the list digest), not every field copied to the new row
 * (reverseCharge, isCompound, taxCategory, component details beyond count / rate / compound / active). Those are protected by the row locks held from before the plan is built and by the
 * comparison of the old row after its deactivation - a known limit, tracked separately.
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
 *     other organisation's number, so the update is a correction. No amount changes (same percentage). CANCELLED documents are re-pointed by every apply and never block it (nothing posted changes; a storefront status sync can reopen a cancelled order, and its next invoice build would otherwise read the retired code); they are their own bucket in the plan and the digest.
 *   - REFUND-LINE SNAPSHOTS: SalesOrderRefundLine.accountingTaxType is resolved at refund creation (lib/domain/sales/refund-service.ts) and the credit note build / retry prefers it to the
 *     order line's rate (lib/domain/sales/refund-posted-tax-identity.ts creditNoteLineTaxTypeResolver ~922-938 returns `refundLine.accountingTaxType`; priceSnapshottedTaxIdentity ~977). A refund
 *     whose credit note is not posted (SalesOrderRefund.accountingCreditNoteId null) may have no queued payload yet (enqueue failed / not yet run), so nothing else would stop the old
 *     code going out. They BLOCK the apply (PENDING_REFUND_SNAPSHOTS); with the flag their snapshot code is migrated to the new code, but only when the old code means the old row alone
 *     (no other IMS rate of another name or percentage carries it - else REFUND_SNAPSHOT_IDENTITY, no override). Posted credit notes are history. Other stored tax-type snapshots:
 *     accounting_sync_logs.payload and accounting_events.linesJson (in-flight ones block via QUEUED_PAYLOADS; sent ones are history); TaxRateComponent.accountingTaxType (cleared above);
 *     the reverse-charge tax-type SETTINGS (accounting_reverse_charge_*_tax_type) are separate configuration, reported not changed. No other model stores a tax type.
 *   - STALE FORMS: the old row stays in forms opened before the apply and in imports that read it earlier, so every writer that persists a tax rate id (sales / purchase order create and
 *     edit, clone, supplier default, storefront rate mappings, WooCommerce order import) resolves a supplied id through lib/tax/writable-tax-rate.ts: an id of a row this apply retired
 *     (TaxRate.replacedById, written here) resolves to the replacement, a plainly inactive rate is refused. The helper share-locks the rows it relies on; this apply's UPDATE of the old row
 *     waits for such a writer, then re-counts (a document created meanwhile is re-pointed with the flag, else the apply rolls back: DOCUMENT_CREATED_DURING_APPLY). Every writer resolves INSIDE its
 *     own writing transaction, so the lock is held to commit; a refund share-locks the rate rows its tax identity is read from before reading them (lib/domain/sales/refund-service.ts), and the
 *     apply counts pending refund snapshots again after the deactivation and migrates them (same identity rules) or rolls back. Suppliers and mappings are re-pointed after it too.
 *   - ENQUEUE RACE: a producer reads the line's rate BEFORE it takes the enqueue lock, so it can build an old-code payload, pause while this apply commits (no queued row to see), then
 *     insert it. createAccountingSyncLogRow (the one insert of a sync row) therefore refuses, under the lock this apply holds, any payload with a code recorded here as retired (setting
 *     tax_rekey_retired_codes, written in the apply's transaction) unless EVERY occurrence of that code names, beside it, a source rate that is active, not replaced and carries exactly that code; an
 *     unbound occurrence is refused too. NO TIME WINDOW: elapsed time is no evidence (a producer can pause for hours), and in a code swap the retired code is carried by another active rate, so only
 *     the source can tell the two apart. Every producer binds its codes (the census in tests/tax/retired-tax-code-guard.test.ts lists them). lib/tax/retired-tax-code-guard.ts. The producer's retry rebuilds from the re-pointed rows.
 *   - QUEUED payloads (an accounting sync row PENDING / PROCESSING / FAILED - a FAILED row keeps blocking until it is retried or cancelled - or an accounting event PENDING / FAILED,
 *     whose lines carry the old code) are snapshots IMS does not rewrite. They BLOCK the apply (QUEUED_PAYLOADS) with no override: let them post, or cancel them, first.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { producerGrantCutoffAgreement } from '@/lib/security/producer-disposition'
import { readProducerEnforcement } from '@/lib/security/producer-seam'
import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { readStoredXeroList, type PurchaseTaxImportRefusalCode } from '@/lib/tax/purchase-tax-import'
import { imsEffectivePercent, type ImsComponentRow } from '@/lib/tax/vat-difference-report'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'
import { xeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'
import { taxCodesInPayload } from '@/lib/tax/tax-code-fields'
import { CLEARED_RATES_SETTING, RETIRED_CODES_SETTING, parseClearedRates, parseRetiredCodes, type RetiredCodes } from '@/lib/tax/retired-tax-code-guard'
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
  'CONFIRM_REQUIRED', 'DIGEST_MISMATCH', 'PLAN_HAS_BLOCKERS', 'UNPOSTED_DOCUMENTS', 'QUEUED_PAYLOADS', 'PENDING_REFUND_SNAPSHOTS', 'REFUND_SNAPSHOT_IDENTITY', 'XERO_NOT_HELD', 'DOCUMENT_CREATED_DURING_APPLY', 'UNRESOLVED_RATES',
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
  /** The rest of what makes a rate mean what it means on a document (the refund-snapshot identity check compares them). Optional so a fixture may omit the defaults. */
  isCompound?: boolean
  reverseCharge?: boolean
  reportingCategory?: string | null
  components: Array<ImsComponentRow & { name?: string; accountingTaxType?: string | null }>
}

export interface RekeyClearedComponent { sortOrder: number; name: string; taxType: string }

export interface RekeyCandidate { taxType: string; name: string; status: string; percent: string | null }

export interface RekeyRow {
  /** CLEAR rows only: the outcome the rate would have had without the clear-unresolved choice. */
  wasOutcome?: RekeyOutcome
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
  /** The VAT-return treatment: what IMS assigns this rate (the same helper that creates Xero rates, lib/connectors/xero/tax-rate-report-type.ts) and what the live type states. null before the check is reached. */
  reportType: { expected: string | null; live: string | null }
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
  /** CANCELLED documents (and their lines) on the old row: never blocking, re-pointed by every apply (nothing posted changes; the new row means the same by construction). In the digest. */
  cancelledSalesOrders: number
  cancelledSalesOrderLines: number
  cancelledPurchaseOrders: number
  cancelledPurchaseOrderLines: number
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
  /** True when the plan was built with the clear-unresolved choice (bound into the digest): unresolved rates are CLEAR rows instead of a refusal. */
  clearUnresolved: boolean
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

const KNOWN_REPORTING_CATEGORIES: ReadonlySet<string> = new Set(['DOMESTIC', 'REVERSE_CHARGE', 'EC_SALES', 'OSS'])
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
/**
 * Do two IMS rates mean the same thing on a document? Name (trimmed), percentage, ordered active components (rate, compound; a rate with none is one component at its column),
 * country, side, isCompound, reverseCharge and reportingCategory. Used by the refund-snapshot identity check: a stored code is migrated only if EVERY carrier of the old code
 * means exactly what the re-keyed row means. Returns the first difference, or null. (The live-type counterpart for Xero is componentMeaningDifference.)
 */
export function imsMeaningDifference(a: RekeyImsRate, b: RekeyImsRate): string | null {
  if (a.name.trim() !== b.name.trim()) return 'name'
  if (!new Dec(a.rate).eq(new Dec(b.rate))) return 'percentage'
  const shape = (r: RekeyImsRate) => {
    const active = r.components.filter((c) => c.active).sort((x, y) => x.sortOrder - y.sortOrder)
    return active.length > 0 ? active.map((c) => ({ rate: new Dec(c.rate), compound: c.compoundOnPrevious })) : new Dec(r.rate).gt(0) ? [{ rate: new Dec(r.rate), compound: false }] : []
  }
  const sa = shape(a)
  const sb = shape(b)
  if (sa.length !== sb.length || sa.some((c, i) => !c.rate.eq(sb[i]!.rate) || c.compound !== sb[i]!.compound)) return 'component breakdown'
  const country = (r: RekeyImsRate): string => (r.countryCode ?? '').trim().toUpperCase()
  if (country(a) !== country(b)) return 'country'
  if (a.usedFor !== b.usedFor) return 'side'
  if ((a.isCompound ?? false) !== (b.isCompound ?? false)) return 'isCompound'
  if ((a.reverseCharge ?? false) !== (b.reverseCharge ?? false)) return 'reverseCharge'
  if ((a.reportingCategory ?? null) !== (b.reportingCategory ?? null)) return 'reportingCategory'
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
    let reportType: { expected: string | null; live: string | null } = { expected: null, live: null }
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
      rows.push({ ...base, outcome, matchedBy, target: target === null ? null : candidateOf(target), candidates, reason, reportType, clearedComponents: cleared })
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
    // VAT-return treatment (Xero ReportTaxType): the live type must file to the box IMS assigns this rate - the helper that creates Xero rates decides (reportingCategory, side, name's country, zero rate).
    // A category the helper does not know would silently fall to its default, which is a guess: refused.
    const category = (rate.reportingCategory ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
    const expectedReport = xeroReportTaxType({ reportingCategory: rate.reportingCategory, usedFor: rate.usedFor, name: rate.name, rate: Number(rate.rate) })
    const liveReport = live.reportTaxType === null ? null : live.reportTaxType.trim().toUpperCase()
    reportType = { expected: expectedReport, live: liveReport }
    if (category !== '' && !KNOWN_REPORTING_CATEGORIES.has(category)) { done('REPORT_TYPE_UNKNOWN', live, `the reporting category "${rate.reportingCategory}" is not one IMS maps to a VAT-return box`); continue }
    if (liveReport === null) { done('REPORT_TYPE_UNKNOWN', live, `the live type states no ReportTaxType, so ${expectedReport} cannot be confirmed`); continue }
    if (liveReport !== expectedReport) { done('REPORT_TYPE_DIFFERS', live, `IMS files this rate under ${expectedReport}, the live type under ${liveReport}`); continue }
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
export function digestRekeyPlan(plan: Pick<RekeyPlan, 'list' | 'rows' | 'blockers' | 'references' | 'clearUnresolved'>): string {
  const refs = Object.keys(plan.references).sort().map((id) => {
    return [id, plan.references[id]!] as const
  })
  const canonical = { v: 2, clearUnresolved: plan.clearUnresolved, tenantId: plan.list.tenantId, list: plan.list.digest, rows: plan.rows, blockers: plan.blockers, references: refs }
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
 * sources (see the header). CANCELLED documents are their own bucket: they do not block (nothing posted changes), but they are re-pointed by every apply, because a storefront status
 * sync can move a cancelled order back to a posting status and its next invoice update would read the line's rate. Reads only.
 */
export async function openDocumentsOf(client: Client, rateId: string): Promise<{
  salesOrderIds: string[]; unpostedSalesOrders: number; unpostedSalesLines: number; postedSalesOrders: number; postedSalesLines: number
  purchaseOrderIds: string[]; unpostedPurchaseOrders: number; unpostedPurchaseLines: number; postedPurchaseOrders: number; postedPurchaseLines: number
  cancelledSalesOrderIds: string[]; cancelledSalesLines: number; cancelledPurchaseOrderIds: string[]; cancelledPurchaseLines: number
}> {
  const orders = await client.salesOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, accountingInvoiceId: true, invoicedAt: true, invoiceNumber: true, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  const orderIds = orders.map((order) => order.id)
  const logs = orderIds.length === 0 ? [] : await client.accountingSyncLog.findMany({ where: { referenceType: 'SalesOrder', referenceId: { in: orderIds }, type: { in: [...SALES_INVOICE_TYPES] } }, select: { referenceId: true } })
  const events = orderIds.length === 0 ? [] : await client.accountingEvent.findMany({ where: { sourceEntityType: 'SalesOrder', sourceEntityId: { in: orderIds } }, select: { sourceEntityId: true } })
  const touched = new Set([...logs.map((l) => l.referenceId), ...events.map((e) => e.sourceEntityId)])
  const out = { salesOrderIds: [] as string[], unpostedSalesOrders: 0, unpostedSalesLines: 0, postedSalesOrders: 0, postedSalesLines: 0, cancelledSalesOrderIds: [] as string[], cancelledSalesLines: 0, cancelledPurchaseOrderIds: [] as string[], cancelledPurchaseLines: 0, purchaseOrderIds: [] as string[], unpostedPurchaseOrders: 0, unpostedPurchaseLines: 0, postedPurchaseOrders: 0, postedPurchaseLines: 0 }
  for (const order of orders) {
    if (order.status === 'CANCELLED') { out.cancelledSalesOrderIds.push(order.id); out.cancelledSalesLines += order.lines.length; continue }
    out.salesOrderIds.push(order.id)
    const posted = order.accountingInvoiceId !== null || order.invoicedAt !== null || order.invoiceNumber !== null || touched.has(order.id)
    if (posted) { out.postedSalesOrders += 1; out.postedSalesLines += order.lines.length } else { out.unpostedSalesOrders += 1; out.unpostedSalesLines += order.lines.length }
  }
  const pos = await client.purchaseOrder.findMany({
    where: { lines: { some: { taxRateId: rateId } } },
    select: { id: true, status: true, invoices: { select: { id: true }, take: 1 }, lines: { where: { taxRateId: rateId }, select: { id: true } } },
  })
  for (const po of pos) {
    if (po.status === 'CANCELLED') { out.cancelledPurchaseOrderIds.push(po.id); out.cancelledPurchaseLines += po.lines.length; continue }
    out.purchaseOrderIds.push(po.id)
    if (po.invoices.length > 0) { out.postedPurchaseOrders += 1; out.postedPurchaseLines += po.lines.length } else { out.unpostedPurchaseOrders += 1; out.unpostedPurchaseLines += po.lines.length }
  }
  out.salesOrderIds.sort()
  out.purchaseOrderIds.sort()
  out.cancelledSalesOrderIds.sort()
  out.cancelledPurchaseOrderIds.sort()
  return out
}

/**
 * Queued accounting payloads (sync rows PENDING / PROCESSING / FAILED, events PENDING / FAILED) carrying `taxType` as ANY tax-code field (lib/tax/tax-code-fields.ts: line `taxType`,
 * `shippingTaxType`, `discountTaxType`, header `taxType`, ...). The sync rows are scanned on their own: the event mirror is best-effort and may be missing. TAX_RATE_SYNC rows define
 * rates and are excluded. The text prefilter only narrows the rows; the key-aware scan decides.
 */
async function queuedCounts(client: Client, taxType: string): Promise<{ syncRows: number; events: number }> {
  const syncRows = await client.$queryRaw<Array<{ payload: unknown }>>`
    SELECT payload FROM accounting_sync_logs
    WHERE status::text = ANY(${[...IN_FLIGHT_SYNC_STATUSES]}) AND type::text <> 'TAX_RATE_SYNC' AND payload IS NOT NULL
      AND position(${taxType} in payload::text) > 0`
  const events = await client.$queryRaw<Array<{ payload: unknown }>>`
    SELECT "linesJson" AS payload FROM accounting_events
    WHERE status = ANY(${[...IN_FLIGHT_EVENT_STATUSES]})
      AND position(${taxType} in "linesJson"::text) > 0`
  const carries = (row: { payload: unknown }): boolean => taxCodesInPayload(row.payload).includes(taxType)
  return { syncRows: syncRows.filter(carries).length, events: events.filter(carries).length }
}

/** The refund-line snapshots (see RekeyReferences.pendingRefundLines) on not-yet-posted refunds that carry `code`. */
async function pendingRefundSnapshots(client: Client, code: string): Promise<{ refunds: number; lines: number }> {
  const lines = await client.salesOrderRefundLine.findMany({ where: { accountingTaxType: code, refund: { accountingCreditNoteId: null } }, select: { refundId: true } })
  return { refunds: new Set(lines.map((l) => l.refundId)).size, lines: lines.length }
}

async function referencesOf(client: Client, row: RekeyRow, rate: RekeyImsRate): Promise<RekeyReferences> {
  const isDefault = rate.isDefault
  const [suppliers, storefrontMappings, open, queued, refunds, sharing] = await Promise.all([
    client.supplier.count({ where: { taxRateId: row.imsRateId } }),
    client.shoppingTaxRateMapping.count({ where: { taxRateId: row.imsRateId } }),
    openDocumentsOf(client, row.imsRateId),
    queuedCounts(client, row.currentCode),
    pendingRefundSnapshots(client, row.currentCode),
    client.taxRate.findMany({
      where: { accountingTaxType: row.currentCode, id: { not: row.imsRateId } },
      select: { id: true, name: true, rate: true, usedFor: true, countryCode: true, isCompound: true, reverseCharge: true, reportingCategory: true, accountingTaxType: true, components: { select: { rate: true, compoundOnPrevious: true, active: true, sortOrder: true } } },
    }),
  ])
  // ANY other carrier of the old code (active or not) that differs in ANY posting meaning makes a stored snapshot of the code ambiguous: the snapshot is then not migrated.
  const refundSnapshotConflict = sharing.some((other) => other.id !== row.imsRateId && other.accountingTaxType === row.currentCode
    && imsMeaningDifference(rate, {
      id: other.id, name: other.name, rate: other.rate.toFixed(4), usedFor: other.usedFor, countryCode: other.countryCode, accountingTaxType: other.accountingTaxType, isDefault: false,
      isCompound: other.isCompound, reverseCharge: other.reverseCharge, reportingCategory: other.reportingCategory,
      components: (other.components ?? []).map((c) => ({ rate: c.rate.toFixed(4), compoundOnPrevious: c.compoundOnPrevious, active: c.active, sortOrder: c.sortOrder })),
    }) !== null)
  return {
    suppliers, storefrontMappings, isDefault,
    unpostedSalesOrders: open.unpostedSalesOrders, unpostedSalesOrderLines: open.unpostedSalesLines,
    unpostedPurchaseOrders: open.unpostedPurchaseOrders, unpostedPurchaseOrderLines: open.unpostedPurchaseLines,
    postedSalesOrders: open.postedSalesOrders, postedSalesOrderLines: open.postedSalesLines,
    postedPurchaseOrders: open.postedPurchaseOrders, postedPurchaseOrderLines: open.postedPurchaseLines,
    cancelledSalesOrders: open.cancelledSalesOrderIds.length, cancelledSalesOrderLines: open.cancelledSalesLines,
    cancelledPurchaseOrders: open.cancelledPurchaseOrderIds.length, cancelledPurchaseOrderLines: open.cancelledPurchaseLines,
    pendingRefunds: refunds.refunds, pendingRefundLines: refunds.lines, refundSnapshotConflict,
    queuedSyncRows: queued.syncRows, queuedEvents: queued.events,
  }
}

/**
 * Build the plan: prove the stored list (same checks as the import), read the active IMS rates, match, count the references. Read only. `client` is the plain client for a preview
 * and the fence's transaction for an apply. Total over a database that answers: a list that cannot be proven is a named refusal, never a plan.
 */
export async function readRekeyPlan(client: Client, options: { now: Date; connectedTenantId: string | null; clearUnresolved?: boolean }): Promise<RekeyPlanRead> {
  const read = await readStoredXeroList(client, options.now, options.connectedTenantId)
  if (!read.ok) {
    const code = (REKEY_REFUSAL_CODES as readonly string[]).includes(read.refusal.code) ? (read.refusal.code as PurchaseTaxImportRefusalCode as RekeyRefusalCode) : 'XERO_LIST_UNREADABLE'
    return { ok: false, refusal: { code, detail: read.refusal.detail } }
  }
  const stored = await client.taxRate.findMany({
    where: { active: true },
    select: { id: true, name: true, rate: true, usedFor: true, countryCode: true, accountingTaxType: true, isDefault: true, isCompound: true, reverseCharge: true, reportingCategory: true, components: { select: { name: true, rate: true, compoundOnPrevious: true, accountingTaxType: true, active: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  const rates: RekeyImsRate[] = stored.map((r) => ({
    id: r.id, name: r.name, rate: r.rate.toFixed(4), usedFor: r.usedFor, countryCode: r.countryCode, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault,
    isCompound: r.isCompound, reverseCharge: r.reverseCharge, reportingCategory: r.reportingCategory,
    components: r.components.map((c) => ({ name: c.name, rate: c.rate.toFixed(4), compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: c.accountingTaxType, active: c.active, sortOrder: c.sortOrder })),
  }))
  const matched = matchRekeyRates({ rates, xero: read.list.rows })
  // The clear-unresolved choice turns every in-scope rate with no resolved live type into a CLEAR row (same transaction, same copy path, NO code); without it they are a refusal of the apply.
  if (options.clearUnresolved === true) {
    matched.rows = matched.rows.map((row) => (row.outcome === 'REKEY' || row.outcome === 'ALREADY_CORRECT' ? row : { ...row, outcome: 'CLEAR' as const, wasOutcome: row.outcome, reason: `${row.outcome}: ${row.reason}`, clearedComponents: [] }))
    matched.counts = Object.fromEntries(REKEY_OUTCOMES.map((outcome) => [outcome, matched.rows.filter((row) => row.outcome === outcome).length])) as Record<RekeyOutcome, number>
  }
  const references: Record<string, RekeyReferences> = {}
  for (const row of matched.rows) {
    if (row.outcome !== 'REKEY' && row.outcome !== 'CLEAR') continue
    references[row.imsRateId] = await referencesOf(client, row, rates.find((r) => r.id === row.imsRateId)!)
  }
  const list = { tenantId: read.list.tenantId, fetchedAt: read.list.fetchedAt.toISOString(), rowCount: read.list.rows.length, digest: digestTaxRateList(read.list.tenantId, read.list.rows) }
  const plan: RekeyPlan = { list, ...matched, references, clearUnresolved: options.clearUnresolved === true, digest: '' }
  plan.digest = digestRekeyPlan(plan)
  return { ok: true, plan }
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** A document referencing a rate being re-keyed was committed by a concurrent writer while the apply ran (writable-tax-rate.ts share lock); the apply rolled back. */
export class RekeyDocumentRaceError extends Error {
  constructor(rateId: string) {
    super(`a document referencing rate ${rateId} was created while the re-key was applying; nothing was written, run the preview again`)
    this.name = 'RekeyDocumentRaceError'
  }
}

export interface RekeyWriteResult {
  /** toCode is null for a CLEAR (the new rate carries no tax code). */
  created: Array<{ oldId: string; newId: string; name: string; fromCode: string; toCode: string | null }>
  suppliersRepointed: number
  mappingsRepointed: number
  salesLinesRepointed: number
  purchaseLinesRepointed: number
  cancelledLinesRepointed: number
  refundLinesRepointed: number
}

/**
 * Write what `plan` says, INSIDE the caller's transaction (the fence's), over a plan rebuilt in that same transaction. Touches tax_rates / tax_rate_components by create and by the
 * old row's active + isDefault flags only, and the taxRateId of suppliers, storefront mappings and (only with `allowUnposted`) unposted document lines. The old row's name, rate, code
 * and components are never written. The re-point statements name the old row's id, so a re-run (old row inactive, nothing referencing it) matches nothing.
 */
export async function writeTaxRekey(tx: Client, plan: RekeyPlan, options: { allowUnposted: boolean }): Promise<RekeyWriteResult> {
  const result: RekeyWriteResult = { created: [], suppliersRepointed: 0, mappingsRepointed: 0, salesLinesRepointed: 0, purchaseLinesRepointed: 0, cancelledLinesRepointed: 0, refundLinesRepointed: 0 }
  for (const row of plan.rows) {
    if (row.outcome !== 'REKEY' && row.outcome !== 'CLEAR') continue
    const old = await tx.taxRate.findUnique({ where: { id: row.imsRateId }, include: { components: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } })
    if (old === null || !old.active || old.accountingTaxType !== row.currentCode || !old.rate.mul(100).equals(new Dec(row.imsPercent))) throw new Error(`rate ${row.imsRateId} changed since the plan was built`)
    // CLEAR: the Demo-organisation code is not carried over - the replacement has NO code (and its components none), the old code is retired below, and documents on it refuse to post.
    const toCode: string | null = row.outcome === 'CLEAR' ? null : row.target!.taxType
    const fresh = await tx.taxRate.create({
      data: {
        name: old.name, rate: old.rate, type: old.type, taxCategory: old.taxCategory, usedFor: old.usedFor, accountingTaxType: toCode, countryCode: old.countryCode,
        isCompound: old.isCompound, reverseCharge: old.reverseCharge, reportingCategory: old.reportingCategory, active: true, isDefault: old.isDefault,
        components: old.components.length === 0 ? undefined : {
          create: old.components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: row.outcome === 'CLEAR' ? null : row.clearedComponents.some((x) => x.sortOrder === c.sortOrder && x.taxType === c.accountingTaxType) ? null : c.accountingTaxType, sortOrder: c.sortOrder, active: c.active })),
        },
      },
      select: { id: true },
    })
    const deactivated = await tx.taxRate.updateMany({ where: { id: old.id, active: true, accountingTaxType: row.currentCode }, data: { active: false, isDefault: false, replacedById: fresh.id } })
    if (deactivated.count !== 1) throw new Error(`rate ${row.imsRateId} could not be deactivated`)
    // Belt and braces behind the row locks the apply holds: the row as it stands after the deactivation (which waits for anything still holding the row) must be what was copied.
    const after = await tx.taxRate.findUniqueOrThrow({ where: { id: old.id }, include: { components: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } })
    const sameMeaning = after.rate.equals(old.rate) && after.name === old.name && after.usedFor === old.usedFor && after.countryCode === old.countryCode && after.isCompound === old.isCompound && after.reverseCharge === old.reverseCharge
      && after.reportingCategory === old.reportingCategory && after.components.length === old.components.length && after.components.every((c, i) => c.rate.equals(old.components[i]!.rate) && c.compoundOnPrevious === old.components[i]!.compoundOnPrevious && c.active === old.components[i]!.active)
    if (!sameMeaning) throw new RekeyDocumentRaceError(row.imsRateId)
    // The UPDATE above waited for every writer that holds a share lock on the old row (lib/tax/writable-tax-rate.ts). A document such a writer committed meanwhile references the old row:
    // without the flag that is a source the plan did not count, so the apply stops (and rolls back); with it, the re-pointing below picks it up.
    if (!options.allowUnposted) {
      const late = await openDocumentsOf(tx, old.id)
      const lateRefunds = await pendingRefundSnapshots(tx, row.currentCode)
      if (late.salesOrderIds.length + late.purchaseOrderIds.length + lateRefunds.lines > 0) throw new RekeyDocumentRaceError(row.imsRateId)
    }
    result.suppliersRepointed += (await tx.supplier.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    result.mappingsRepointed += (await tx.shoppingTaxRateMapping.updateMany({ where: { taxRateId: old.id }, data: { taxRateId: fresh.id } })).count
    if (options.allowUnposted) {
      // Refund-line snapshots on refunds not yet posted: the conflict check is made here per rate (they are MOVED by id after the loop, see below). COUNTED AGAIN here, after the deactivation (which waited for any refund transaction holding a share lock on the old row - see
      // refund-service.ts), so a snapshot a concurrent refund committed after the plan counted is migrated too (its identity is the old row's: the plan found no conflicting carrier), or the apply stops.
      const late = await pendingRefundSnapshots(tx, row.currentCode)
      if (late.lines > 0) {
        const snap = plan.references[row.imsRateId]
        if (snap !== undefined && snap.refundSnapshotConflict) throw new RekeyDocumentRaceError(row.imsRateId)
      }
      const open = await openDocumentsOf(tx, old.id)
      if (open.salesOrderIds.length > 0) result.salesLinesRepointed += (await tx.salesOrderLine.updateMany({ where: { taxRateId: old.id, orderId: { in: open.salesOrderIds } }, data: { taxRateId: fresh.id } })).count
      if (open.purchaseOrderIds.length > 0) result.purchaseLinesRepointed += (await tx.purchaseOrderLine.updateMany({ where: { taxRateId: old.id, poId: { in: open.purchaseOrderIds } }, data: { taxRateId: fresh.id } })).count
    }
    // CANCELLED documents follow too, whatever the flag (they never block): a storefront status sync can reopen a cancelled order, and its next invoice build would read the line's rate.
    const cancelled = await openDocumentsOf(tx, old.id)
    if (cancelled.cancelledSalesOrderIds.length > 0) result.cancelledLinesRepointed += (await tx.salesOrderLine.updateMany({ where: { taxRateId: old.id, orderId: { in: cancelled.cancelledSalesOrderIds } }, data: { taxRateId: fresh.id } })).count
    if (cancelled.cancelledPurchaseOrderIds.length > 0) result.cancelledLinesRepointed += (await tx.purchaseOrderLine.updateMany({ where: { taxRateId: old.id, poId: { in: cancelled.cancelledPurchaseOrderIds } }, data: { taxRateId: fresh.id } })).count
    result.created.push({ oldId: old.id, newId: fresh.id, name: old.name, fromCode: row.currentCode, toCode })
  }
  // REFUND-LINE SNAPSHOTS ARE MOVED BY ID, EXACTLY ONCE. They hold a CODE, and in a swap (A: X->Y, B: Y->X) or a rotation (X->Y->Z->X) an update "by the old code's value" run one rate after the
  // other would pick up the rows the previous update had just moved and move them again, leaving A's refund with B's identity. So (after every rate is deactivated, which waited for any refund
  // transaction still holding a share lock) the ids of the pending snapshots are captured per ORIGINAL code in one pass with no write in between, each id is claimed by the first rate with that
  // code, and each captured set is then updated once, to its own replacement's code. (Every other statement in this function is keyed by an id that cannot chain: suppliers, mappings and document
  // lines by the OLD rate's id; the retired / cleared settings by old code / new id; the replacement rows are created with their final codes. Nothing else updates a code by value.)
  if (options.allowUnposted && result.created.length > 0) {
    const claimed = new Set<string>()
    const captured: Array<{ ids: string[]; toCode: string | null }> = []
    for (const c of result.created) {
      const rows = await tx.salesOrderRefundLine.findMany({ where: { accountingTaxType: c.fromCode, refund: { accountingCreditNoteId: null } }, select: { id: true } })
      const ids = rows.map((r) => r.id).filter((id) => !claimed.has(id))
      for (const id of ids) claimed.add(id)
      captured.push({ ids, toCode: c.toCode })
    }
    for (const { ids, toCode } of captured) {
      if (ids.length > 0) result.refundLinesRepointed += (await tx.salesOrderRefundLine.updateMany({ where: { id: { in: ids } }, data: { accountingTaxType: toCode } })).count
    }
  }
  if (result.created.length > 0) {
    // The enqueue guard's memory of what was retired (lib/tax/retired-tax-code-guard.ts), written in this same transaction under the same lock.
    const existing = parseRetiredCodes((await tx.setting.findUnique({ where: { key: RETIRED_CODES_SETTING }, select: { value: true } }))?.value)
    const retired: RetiredCodes = { ...existing }
    const at = new Date().toISOString()
    for (const c of result.created) retired[c.fromCode] = { rateId: c.oldId, newCode: c.toCode ?? '', at }
    // The replacements of CLEARED rates carry no code: a document whose line is on one would reach Xero as 'NONE' (the connectors' default for a missing tax type) or as the order default's code, so the
    // enqueue guard refuses a payload bound to one of them (missing_tax_code) until the rate is mapped to a live code by hand.
    const clearedNow = result.created.filter((c) => c.toCode === null)
    if (clearedNow.length > 0) {
      const prior = parseClearedRates((await tx.setting.findUnique({ where: { key: CLEARED_RATES_SETTING }, select: { value: true } }))?.value)
      for (const c of clearedNow) prior[c.newId] = { at }
      const clearedValue = JSON.stringify(prior)
      await tx.setting.upsert({ where: { key: CLEARED_RATES_SETTING }, create: { key: CLEARED_RATES_SETTING, value: clearedValue }, update: { value: clearedValue } })
    }
    // A code that is both retired (from one rate) and a target (of another: the swap) STAYS in the set: it changed meaning, and the guard admits it only for occurrences bound to a rate that carries it now.
    const value = JSON.stringify(retired)
    await tx.setting.upsert({ where: { key: RETIRED_CODES_SETTING }, create: { key: RETIRED_CODES_SETTING, value }, update: { value } })
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
// The structural guarantee: a re-key runs only while Xero writes are HELD
// ---------------------------------------------------------------------------

/** The environment variables the Xero hold is read from; the CLI hands exactly these (and nothing else) to the run, since it replaces the rest of its environment. */
export const XERO_HOLD_ENV_NAMES = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.xero, PRODUCER_CUTOFF_ENV.xero] as const

export function pickXeroHoldEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of XERO_HOLD_ENV_NAMES) {
    const value = Object.prototype.hasOwnProperty.call(source, name) ? source[name] : undefined
    if (typeof value === 'string') out[name] = value
  }
  return out
}

export interface XeroHoldState { held: boolean; detail: string }

/**
 * IS XERO HELD? True only when the producer-side hold is ENFORCED for xero (PRODUCER_HOLD_ENFORCED_DESTINATIONS readable and naming xero or all) AND the destination is NOT live: no outbound
 * grant and no live-from instant (producerGrantCutoffAgreement = agreed_held). It is the reading `npm run outbound:status` makes (lib/ops/outbound-producer-status.ts: enforced, agreement).
 * Anything else - not enforced, an unreadable switch, a grant, a live-from instant (set, future or past), inconsistent or unreadable - is NOT held. Pure over the environment; never throws.
 *
 * WHY THIS IS THE GUARANTEE. While held, every Xero producer writes a SHADOW that is never delivered (lib/domain/accounting/xero-producer-seam.ts, createAccountingSyncLogRow's
 * producer seam). At go-live, the writer-side cut-off (xeroCutoffFloor / xeroBeforeCutoffRefusal / xeroNotBeforeCutoffWhere, used by the sync processor's claims and re-queues; the same
 * floor the outbox uses) refuses to deliver any row created before XERO_WRITES_LIVE_FROM. So no payload built around a re-key - however long its producer paused between reading a rate
 * and enqueueing - can ever reach Xero. The enqueue guard (lib/tax/retired-tax-code-guard.ts) stays as belt and braces. A re-key is therefore a PRE-P2 operation: permitted only while
 * Xero writes are held.
 */
export function xeroHoldState(env: Readonly<Record<string, string | undefined>> = process.env): XeroHoldState {
  try {
    const enforcement = readProducerEnforcement({ ...env })
    if (!enforcement.enforced) return { held: false, detail: `${PRODUCER_HOLD_ENFORCED_ENV} is not set, so the producer-side hold is not enforced and Xero producers would still queue deliverable work` }
    if (!enforcement.readable) return { held: false, detail: `${PRODUCER_HOLD_ENFORCED_ENV} is set but cannot be read` }
    if (!enforcement.destinations.has('xero')) return { held: false, detail: `${PRODUCER_HOLD_ENFORCED_ENV} does not name xero` }
    const agreement = producerGrantCutoffAgreement('xero', { ...env })
    if (agreement.state !== 'agreed_held') return { held: false, detail: `Xero is not held: ${agreement.text}` }
    return { held: true, detail: `Xero is held: ${PRODUCER_HOLD_ENFORCED_ENV} names xero, no outbound grant and no live-from instant are set` }
  } catch {
    return { held: false, detail: 'the Xero hold could not be read' }
  }
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
  /** Retire every in-scope rate with no resolved live type (a CLEAR row) instead of refusing the apply for it. Part of the plan, so of the digest. */
  clearUnresolved?: boolean
  /** The Xero hold variables (XERO_HOLD_ENV_NAMES) to read; default the process environment (the web app's own, which is the one its producers obey). The CLI passes its caller's. */
  producerEnv?: Readonly<Record<string, string | undefined>>
  now?: Date
}

export interface TaxRekeyRunResult {
  applied: boolean
  wrote: boolean
  plan: RekeyPlan | null
  refusal: RekeyRefusal | null
  written: RekeyWriteResult | null
  /** Whether Xero writes are held (an apply is refused unless they are). Shown with a preview so the operator knows before applying. */
  hold: XeroHoldState
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
  // NO PARTIAL APPLY: every in-scope active rate with a custom code must end re-keyed, already correct, or (with the explicit clear choice, part of the digest) cleared. A rate left active with its
  // Demo-organisation code would be posted under whatever that number means in this organisation.
  const unresolved = plan.rows.filter((r) => r.outcome !== 'REKEY' && r.outcome !== 'ALREADY_CORRECT' && r.outcome !== 'CLEAR')
  if (unresolved.length > 0) return { code: 'UNRESOLVED_RATES', detail: `${unresolved.length} active rate(s) with a custom code have no resolved live type and would stay active with their Demo-organisation code: ${unresolved.map((r) => `${r.name} (${r.currentCode}) ${r.outcome}`).join('; ')}. Fix them, or choose to clear them (retired, replaced by rates with no tax code that refuse to post until mapped)` }
  return null
}

/**
 * The action. A preview (`apply: false`) reads only. An apply rebuilds the plan INSIDE the connection fence's transaction (the mapping-selection lock: two runs, or a run and a rebind,
 * cannot interleave), refuses unless its digest is the one confirmed, and writes that plan. Nothing to re-key is a no-op, not a refusal (the idempotent re-run).
 */
export async function runTaxRekey(options: TaxRekeyRunOptions): Promise<TaxRekeyRunResult> {
  const hold = xeroHoldState(options.producerEnv ?? process.env)
  const refuse = (refusal: RekeyRefusal, plan: RekeyPlan | null = null): TaxRekeyRunResult => ({ applied: options.apply, wrote: false, plan, refusal, written: null, hold })
  // Before the database is touched: an apply with no digest never reads anything.
  if (options.apply && (options.confirm === undefined || !DIGEST_RE.test(options.confirm))) return refuse({ code: 'CONFIRM_REQUIRED', detail: 'an apply needs the exact 64-character plan digest the operator saw in the preview' })
  // A re-key is a pre-P2 operation: refused unless Xero writes are held (see xeroHoldState). Checked before the database is touched.
  if (options.apply && !hold.held) return refuse({ code: 'XERO_NOT_HELD', detail: `${hold.detail}. Re-keying is allowed only while Xero writes are held (before go-live): an in-flight producer could otherwise enqueue a payload with a retired code that would be delivered.` })
  const { db } = await import('@/lib/db')
  const { captureXeroConnection, withXeroConnectionFence } = await import('@/lib/connectors/xero/connection-fence')
  const now = options.now ?? new Date()
  const connection = await captureXeroConnection()
  const first = await readRekeyPlan(db as unknown as Client, { now, connectedTenantId: connection?.tenantId ?? null, clearUnresolved: options.clearUnresolved === true })
  if (!first.ok) return refuse(first.refusal)
  if (!options.apply) return { applied: false, wrote: false, plan: first.plan, refusal: null, written: null, hold }
  if (connection === null) return refuse({ code: 'XERO_NOT_CONNECTED', detail: 'no Xero organisation is connected' }, first.plan)
  const seen: { plan: RekeyPlan | null } = { plan: null }
  let fenced: Awaited<ReturnType<typeof withXeroConnectionFence<{ refusal: RekeyRefusal | null; plan: RekeyPlan | null; written: RekeyWriteResult | null }>>>
  try {
  fenced = await withXeroConnectionFence(connection, async (tx) => {
    // Lock EVERY active rate and component row the plan reads and copies from, BEFORE the plan is built (FOR NO KEY UPDATE: an editor's UPDATE and its own lock wait, a document's foreign-key
    // check does not), so the plan the digest binds is the plan of rows nobody can change until commit: an editor that held the lock first has committed (the digest then differs from the
    // operator's and the apply refuses), and one that arrives later waits and finds the row replaced (lib/tax/tax-rate-replaced.ts).
    await tx.$queryRaw`SELECT id FROM tax_rates WHERE active ORDER BY id FOR NO KEY UPDATE`
    await tx.$queryRaw`SELECT c.id FROM tax_rate_components c JOIN tax_rates t ON t.id = c.tax_rate_id WHERE t.active ORDER BY c.id FOR NO KEY UPDATE OF c`
    const read = await readRekeyPlan(tx, { now, connectedTenantId: connection.tenantId, clearUnresolved: options.clearUnresolved === true })
    if (!read.ok) return { refusal: read.refusal, plan: null as RekeyPlan | null, written: null as RekeyWriteResult | null }
    seen.plan = read.plan
    const plan = read.plan
    const unresolved = plan.rows.some((r) => r.outcome !== 'REKEY' && r.outcome !== 'ALREADY_CORRECT' && r.outcome !== 'CLEAR')
    if (plan.counts.REKEY === 0 && plan.counts.CLEAR === 0 && plan.blockers.length === 0 && !unresolved) return { refusal: null, plan, written: null }
    if (plan.digest !== options.confirm) return { refusal: { code: 'DIGEST_MISMATCH', detail: 'the plan changed since it was previewed (or this is not its digest); preview again' } as RekeyRefusal, plan, written: null }
    const refusal = applyRefusal(plan, options.allowUnposted === true)
    if (refusal !== null) return { refusal, plan, written: null }
    return { refusal: null, plan, written: await writeTaxRekey(tx, plan, { allowUnposted: options.allowUnposted === true }) }
  })
  } catch (error) {
    if (error instanceof RekeyDocumentRaceError) return refuse({ code: 'DOCUMENT_CREATED_DURING_APPLY', detail: error.message }, seen.plan ?? first.plan)
    throw error
  }
  if (!fenced.ok) return refuse({ code: 'XERO_CONNECTION_CHANGED', detail: fenced.error }, seen.plan ?? first.plan)
  const { refusal, plan, written } = fenced.value
  return { applied: true, wrote: written !== null && written.created.length > 0, plan: plan ?? first.plan, refusal, written, hold }
}
