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
 * The refusal is a thrown RetiredTaxCodeInPayloadError after a best-effort row in the posting-refusal inbox on the pooled client; the producer's ordinary retry rebuilds the payload from
 * the current rates (the apply re-pointed the documents that could still post).
 */
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { taxCodeOccurrences, taxRateBindings } from '@/lib/tax/tax-code-fields'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'

export const RETIRED_CODES_SETTING = 'tax_rekey_retired_codes'
/** The replacements of rates a re-key CLEARED (no tax code): { [rateId]: { at } }. A payload bound to one is refused (missing_tax_code): the connectors would send NONE (or the order default's code) for a missing tax type. */
export const CLEARED_RATES_SETTING = 'tax_rekey_cleared_rates'
/** A payload line is bound to a rate a re-key cleared, which has no tax code until someone maps it. */
export const MISSING_TAX_CODE_REASON = 'missing_tax_code'
/** A retired code whose bound source rate is not the live carrier of it (a stale read of the retired row, a deactivated rate, a different code). */
export const RETIRED_TAX_CODE_REASON = 'retired_tax_code'
/** A retired code with no source binding at all. */
export const RETIRED_TAX_CODE_UNBOUND_REASON = 'retired_tax_code_unbound'

type Reason = typeof RETIRED_TAX_CODE_REASON | typeof RETIRED_TAX_CODE_UNBOUND_REASON | typeof MISSING_TAX_CODE_REASON

export class RetiredTaxCodeInPayloadError extends Error {
  readonly codes: string[]
  readonly reason: Reason
  constructor(codes: string[], reason: Reason = RETIRED_TAX_CODE_REASON) {
    super(reason === MISSING_TAX_CODE_REASON
      ? 'The accounting payload is built on a tax rate a tax re-key cleared: it has no tax code, and the accounting system would be sent NONE (or another rate\'s code). It was not queued. Map the tax rate to a live Xero tax type (Settings > Accounting > Tax), then retry.'
      : `The accounting payload carries tax code(s) ${codes.join(', ')} that a tax re-key retired${reason === RETIRED_TAX_CODE_REASON ? ', taken from a tax rate that no longer carries them' : ', with no record of which tax rate they were taken from'}; it was not queued. Rebuild it from the current document (retry the action).`)
    this.name = 'RetiredTaxCodeInPayloadError'
    this.codes = codes
    this.reason = reason
  }
}

type RateRow = { id: string; active: boolean; replacedById: string | null; accountingTaxType: string | null }

/** What the guard reads: a Prisma client or transaction. Structural, so a test double without these simply is not guarded. */
type GuardClient = {
  $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
  taxRate?: { findMany(args: { where: { id: { in: string[] } }; select: { id: true; active: true; replacedById: true; accountingTaxType: true } }): Promise<RateRow[]> }
  setting?: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
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
  // A line bound to a rate a re-key CLEARED has no tax code: the connectors would send NONE (or the order default's code) for it. Refused, whatever code the payload happens to carry.
  const cleared = parseClearedRates((await c.setting.findUnique({ where: { key: CLEARED_RATES_SETTING }, select: { value: true } }))?.value)
  for (const id of bound) if (Object.prototype.hasOwnProperty.call(cleared, id)) out.set(`rate:${id}`, MISSING_TAX_CODE_REASON)
  const retired = parseRetiredCodes((await c.setting.findUnique({ where: { key: RETIRED_CODES_SETTING }, select: { value: true } }))?.value)
  const suspect = occurrences.filter((o) => Object.prototype.hasOwnProperty.call(retired, o.code))
  if (suspect.length > 0) {
    const ids = [...new Set(suspect.map((o) => o.taxRateId).filter((id): id is string => id !== null))]
    const rows = new Map((ids.length === 0 ? [] : await c.taxRate.findMany({ where: { id: { in: ids } }, select: { id: true, active: true, replacedById: true, accountingTaxType: true } })).map((r) => [r.id, r] as const))
    for (const o of suspect) {
      if (o.taxRateId === null) { if (!out.has(o.code)) out.set(o.code, RETIRED_TAX_CODE_UNBOUND_REASON); continue }
      const row = rows.get(o.taxRateId)
      const live = row !== undefined && row.active && row.replacedById === null && row.accountingTaxType === o.code
      if (!live) out.set(o.code, RETIRED_TAX_CODE_REASON)
    }
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, reason]) => ({ code: code.startsWith('rate:') ? '(no tax code)' : code, reason }))
}
