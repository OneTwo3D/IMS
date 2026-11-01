/**
 * THE ENQUEUE-TIME GUARD AGAINST A RE-KEYED-AWAY TAX CODE (lib/tax/tax-rekey.ts). Called by createAccountingSyncLogRow, the ONE place an accounting sync row is inserted
 * (tests/accounting/sync-log-row-primitive.test.ts holds the file to one insert), so every producer - the facade, the in-transaction enqueue, the connector queues, the daily batches
 * and the processors' follow-ups - passes through it.
 *
 * WHY. Producers read `line.taxRate.accountingTaxType` BEFORE they take the enqueue lock. A producer can build a payload with the old Demo code, pause, let the re-key apply commit (it
 * saw no queued row), and insert the stale payload later. In a code SWAP the old code is carried by another active rate afterwards (CY VAT's retired TAX005 is the live BG VAT's), so
 * neither "no rate carries it" nor elapsed time can tell a Cyprus payload from a Bulgarian one: only the SOURCE can.
 *
 * THE BINDING (elapsed time is no proof, so there is no time window). Each tax-code field of a payload carries, as a sibling key the senders never read, the id of the rate the producer
 * read the code from: `taxType` + `taxRateId`, `shippingTaxType` + `shippingTaxRateId`, `discountTaxType` + `discountTaxRateId` (lib/tax/tax-code-fields.ts bindingKeyFor). For a code a re-key
 * retired (setting RETIRED_CODES_SETTING), EVERY occurrence is admitted only if its bound rate is, now and under the lock, ACTIVE, not replaced, and has exactly that code as its
 * accountingTaxType. A stale read names the retired row (replaced) and is refused; a payload built from the new row names the new row and is admitted whenever it is enqueued. An occurrence
 * with no binding is refused (retired_tax_code_unbound): a producer must bind every code it can take from a rate. Codes a re-key never retired, Xero built-ins and TAX_RATE_SYNC
 * payloads (which define rates) are not looked at.
 *
 * THE LOCK. The check first takes the SAME advisory lock the re-key apply takes inside the Xero connection fence (ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY), transaction-scoped, so it is held
 * to the producer's commit and re-entrant when the enqueue already took it. Either the producer's row commits first (the apply then finds it queued and refuses), or the apply commits
 * first and this check, run after the lock, reads the committed rates.
 *
 * A CLEARED RATE'S MARKER IS ITS PERSISTENT IDENTITY AND IS NEVER REMOVED. The re-key records each CLEAR replacement in CLEARED_RATES_SETTING; nothing deletes the entry (the set grows by one
 * id per cleared rate and is not reaped). Under the lock the guard reads the bound rate as it is NOW and admits a binding to a marked rate ONLY when (1) the rate's current code is valid and live
 * (taxRateHasValidLiveCode: a Xero built-in or ACTIVE in the stored list of the organisation connected now) AND (2) the tax type the payload sent beside the binding IS that code exactly (for a
 * reverse-charge rate, or the configured reverse-charge type the senders swap it to). A rate with no valid code is refused as missing_tax_code; a missing, stale or different type is refused as
 * tax_code_not_current, so the producer rebuilds the payload from the rate as it is now (a payload built before a remap carried the order default's code, or none, and must not be admitted after it).
 * Because the marker is never dropped, a rate remapped and then cleared again (or whose code is later made invalid) is guarded again with no further step.
 *
 * EVERY WRITE THAT CHANGES A RATE'S accountingTaxType TAKES THE SELECTION LOCK FIRST (the tax-rate editor, link-by-name, generate-missing, the tax import, the re-key, the Xero rebind), held to its
 * commit, so the verdict the guard reaches under the same lock stands until the producer's commit: either the writer committed first and the guard reads its code, or the guard's transaction
 * commits first and the writer then changes the rate (the document was valid when it was queued).
 *
 * LOCK ORDER (one, for everyone): the connector-selection advisory lock FIRST, then the WooCommerce mapping lock (shared), then tax_rates rows (lib/tax/writable-tax-rate.ts, TAX RATE ROW LOCK
 * ORDER). The guard takes only the first and reads rate rows without locking them, so it adds no edge to the order.
 *
 * The refusal is a thrown RetiredTaxCodeInPayloadError after a best-effort row in the posting-refusal inbox on the pooled client; the producer's ordinary retry rebuilds the payload from
 * the current rates (the apply re-pointed the documents that could still post).
 */
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { taxCodeOccurrences, taxRateBindingLines, taxRateBindings } from '@/lib/tax/tax-code-fields'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'

const REVERSE_CHARGE_SALES_SETTING = 'accounting_reverse_charge_sales_tax_type'
const REVERSE_CHARGE_PURCHASE_SETTING = 'accounting_reverse_charge_purchase_tax_type'
const XERO_TAX_TYPE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export const RETIRED_CODES_SETTING = 'tax_rekey_retired_codes'
/** The replacements of rates a re-key CLEARED (no tax code): { [rateId]: { at } }. A payload bound to one is refused (missing_tax_code) while the rate still has no valid live code: the connectors would send NONE (or the order default's code) for a missing tax type. */
export const CLEARED_RATES_SETTING = 'tax_rekey_cleared_rates'
/** A payload line is bound to a rate a re-key cleared that has no valid live tax code now. */
export const MISSING_TAX_CODE_REASON = 'missing_tax_code'
/** A payload line is bound to a rate a re-key cleared whose current code is valid, but the line's tax type is missing or is not that code: the payload predates the remap or was built from a default. */
export const TAX_CODE_NOT_CURRENT_REASON = 'tax_code_not_current'
/** A retired code whose bound source rate is not the live carrier of it (a stale read of the retired row, a deactivated rate, a different code). */
export const RETIRED_TAX_CODE_REASON = 'retired_tax_code'
/** A retired code with no source binding at all. */
export const RETIRED_TAX_CODE_UNBOUND_REASON = 'retired_tax_code_unbound'

type Reason = typeof RETIRED_TAX_CODE_REASON | typeof RETIRED_TAX_CODE_UNBOUND_REASON | typeof MISSING_TAX_CODE_REASON | typeof TAX_CODE_NOT_CURRENT_REASON

export class RetiredTaxCodeInPayloadError extends Error {
  readonly codes: string[]
  readonly reason: Reason
  constructor(codes: string[], reason: Reason = RETIRED_TAX_CODE_REASON) {
    super(reason === TAX_CODE_NOT_CURRENT_REASON
      ? 'The accounting payload is bound to a tax rate a tax re-key cleared, and its tax type is missing or is not that rate\'s current code (the rate was mapped after the payload was built). It was not queued. Rebuild it from the current document (retry the action).'
      : reason === MISSING_TAX_CODE_REASON
      ? 'The accounting payload is built on a tax rate a tax re-key cleared: it has no tax code, and the accounting system would be sent NONE (or another rate\'s code). It was not queued. Map the tax rate to a live Xero tax type (Settings > Accounting > Tax), then retry.'
      : `The accounting payload carries tax code(s) ${codes.join(', ')} that a tax re-key retired${reason === RETIRED_TAX_CODE_REASON ? ', taken from a tax rate that no longer carries them' : ', with no record of which tax rate they were taken from'}; it was not queued. Rebuild it from the current document (retry the action).`)
    this.name = 'RetiredTaxCodeInPayloadError'
    this.codes = codes
    this.reason = reason
  }
}

type RateRow = { id: string; active: boolean; replacedById: string | null; accountingTaxType: string | null; reverseCharge?: boolean | null }

/** What the guard reads: a Prisma client or transaction. Structural, so a test double without these simply is not guarded. */
type GuardClient = {
  $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
  taxRate?: { findMany(args: { where: { id: { in: string[] } }; select: { id: true; active: true; replacedById: true; accountingTaxType: true; reverseCharge: true } }): Promise<RateRow[]> }
  setting?: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
  accountingToken?: { findUnique(args: { where: { connector: string }; select: { tenantId: true } }): Promise<{ tenantId: string } | null> }
  xeroTaxRate?: { findMany(args: { where: { connector: string; tenantId: string; status: string; taxType: { in: string[] } }; select: { taxType: true } }): Promise<Array<{ taxType: string }>> }
}

/**
 * Which of `codes` are VALID LIVE accounting codes right now: well formed, and either a Xero built-in or ACTIVE in the stored list of the organisation connected now. A code a re-key retired and the live
 * list does not carry (a stale Demo code) is therefore not valid; one that is live (a swap) is. A client that cannot answer (a structural double without the Xero store) is judged on the format alone.
 * Reads only; the caller holds the selection lock.
 */
async function validLiveCodes(c: GuardClient, codes: readonly string[]): Promise<Set<string>> {
  const wellFormed = [...new Set(codes)].filter((code) => XERO_TAX_TYPE_FORMAT.test(code))
  const valid = new Set(wellFormed.filter((code) => !isOrganisationSpecificTaxType(code)))
  const custom = wellFormed.filter((code) => isOrganisationSpecificTaxType(code))
  if (custom.length === 0) return valid
  if (c.accountingToken === undefined || c.xeroTaxRate === undefined) { for (const code of custom) valid.add(code); return valid }
  const tenant = await c.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
  if (tenant === null) return valid
  for (const row of await c.xeroTaxRate.findMany({ where: { connector: 'xero', tenantId: tenant.tenantId, status: 'ACTIVE', taxType: { in: custom } }, select: { taxType: true } })) valid.add(row.taxType)
  return valid
}

/** Take the connector-selection lock (to the caller's commit): the FIRST statement of every transaction that changes a tax rate's accountingTaxType. Re-entrant when the transaction already holds it. */
export async function lockTaxCodeWrites(tx: unknown): Promise<void> {
  const c = tx as GuardClient
  if (typeof c.$executeRaw === 'function') await c.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
}

export type RetiredCodes = Record<string, { rateId: string; newCode: string; at: string }>

export type ClearedRates = Record<string, { at: string }>
export function parseClearedRates(value: string | null | undefined): ClearedRates {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ClearedRates) : {}
  } catch { return {} }
}

export function parseRetiredCodes(value: string | null | undefined): RetiredCodes {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RetiredCodes) : {}
  } catch { return {} }
}

export type RetiredCodeFinding = { code: string; reason: Reason }

/** The retired codes in `payload` that must be refused; [] = fine. Takes the shared lock when the payload carries any custom code. */
export async function retiredTaxCodesInPayload(client: unknown, input: { type: string; payload: unknown }): Promise<RetiredCodeFinding[]> {
  if (input.type === 'TAX_RATE_SYNC') return []
  const occurrences = taxCodeOccurrences(input.payload).filter((o) => isOrganisationSpecificTaxType(o.code))
  const bound = taxRateBindings(input.payload)
  if (occurrences.length === 0 && bound.length === 0) return []
  const c = client as GuardClient
  if (typeof c.$executeRaw !== 'function' || c.taxRate === undefined || c.setting === undefined) return []
  await c.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
  const out = new Map<string, Reason>()
  // A line bound to a rate a re-key CLEARED (its marker is permanent) is admitted only on the rate's CURRENT valid live code, sent exactly (see the header).
  const cleared = parseClearedRates((await c.setting.findUnique({ where: { key: CLEARED_RATES_SETTING }, select: { value: true } }))?.value)
  const markedLines = taxRateBindingLines(input.payload).filter((b) => Object.prototype.hasOwnProperty.call(cleared, b.taxRateId))
  if (markedLines.length > 0) {
    const markedRows = new Map((await c.taxRate.findMany({ where: { id: { in: [...new Set(markedLines.map((b) => b.taxRateId))] } }, select: { id: true, active: true, replacedById: true, accountingTaxType: true, reverseCharge: true } })).map((r) => [r.id, r] as const))
    const valid = await validLiveCodes(c, [...markedRows.values()].map((r) => r.accountingTaxType).filter((t): t is string => typeof t === 'string'))
    const reverseChargeTypes = new Set<string>()
    if (markedLines.some((b) => markedRows.get(b.taxRateId)?.reverseCharge === true)) {
      for (const key of [REVERSE_CHARGE_SALES_SETTING, REVERSE_CHARGE_PURCHASE_SETTING]) {
        const value = (await c.setting.findUnique({ where: { key }, select: { value: true } }))?.value?.trim()
        if (value) reverseChargeTypes.add(value)
      }
    }
    for (const b of markedLines) {
      const row = markedRows.get(b.taxRateId)
      const current = row?.accountingTaxType
      if (row === undefined || typeof current !== 'string' || !valid.has(current)) { out.set(`rate:${b.taxRateId}`, MISSING_TAX_CODE_REASON); continue }
      const sentIsCurrent = b.code === current || (row.reverseCharge === true && b.code !== null && reverseChargeTypes.has(b.code))
      if (!sentIsCurrent) out.set(`stale:${b.taxRateId}`, TAX_CODE_NOT_CURRENT_REASON)
    }
  }
  const retired = parseRetiredCodes((await c.setting.findUnique({ where: { key: RETIRED_CODES_SETTING }, select: { value: true } }))?.value)
  const suspect = occurrences.filter((o) => Object.prototype.hasOwnProperty.call(retired, o.code))
  if (suspect.length > 0) {
    const ids = [...new Set(suspect.map((o) => o.taxRateId).filter((id): id is string => id !== null))]
    const rows = new Map((ids.length === 0 ? [] : await c.taxRate.findMany({ where: { id: { in: ids } }, select: { id: true, active: true, replacedById: true, accountingTaxType: true, reverseCharge: true } })).map((r) => [r.id, r] as const))
    for (const o of suspect) {
      if (o.taxRateId === null) { if (!out.has(o.code)) out.set(o.code, RETIRED_TAX_CODE_UNBOUND_REASON); continue }
      const row = rows.get(o.taxRateId)
      const live = row !== undefined && row.active && row.replacedById === null && row.accountingTaxType === o.code
      if (!live) out.set(o.code, RETIRED_TAX_CODE_REASON)
    }
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, reason]) => ({ code: code.startsWith('rate:') ? '(no tax code)' : code.startsWith('stale:') ? '(tax code not current)' : code, reason }))
}
