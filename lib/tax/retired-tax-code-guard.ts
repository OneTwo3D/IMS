/**
 * THE ENQUEUE-TIME GUARD AGAINST A RE-KEYED-AWAY TAX CODE (lib/tax/tax-rekey.ts). Called by createAccountingSyncLogRow, the ONE place an accounting sync row is inserted
 * (tests/accounting/sync-log-row-primitive.test.ts holds the file to one insert), so every producer - the facade, the in-transaction enqueue, the connector queues, the daily batches
 * and the processors' follow-ups - passes through it.
 *
 * WHY. Invoice / bill producers read `line.taxRate.accountingTaxType` BEFORE they take the enqueue lock. A producer can therefore build a payload with the old Demo code, pause, let the
 * re-key apply commit (it saw no queued row), and then insert the stale payload. The apply's queued-payload check cannot see a row that does not exist yet; this check, made at the
 * insert and under the lock, can.
 *
 * THE LOCK. The check first takes the SAME advisory lock the re-key apply takes inside the Xero connection fence (ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY,
 * lockAccountingMappingSelection) - transaction-scoped, so it is held to the producer's commit and re-entrant when the enqueue already took it (every in-transaction enqueue does,
 * accounting.ts pinnedLedgerIsServicedUnderLock). Either the producer's row commits first (the apply then finds it queued and refuses), or the apply commits first and this check, run after
 * the lock, reads the committed rates and refuses the stale code. A shared lock rather than a new one is the choice: one lock order, no new deadlock edge.
 *
 * WHAT IS REFUSED. A payload (of any type except TAX_RATE_SYNC, which defines rates) carrying a tax code that a re-key retired (recorded by the apply under RETIRED_CODES_SETTING) AND that
 * no ACTIVE IMS rate carries now. Deliberately NOT "any code only an inactive rate carries": an operator may deactivate a rate and still need a credit note for its historical invoices
 * with its code; only the other organisation's number a re-key retired is wrong to send. Codes no rate carries at all (settings-held reverse-charge types) and Xero built-ins pass.
 * The refusal is a thrown RetiredTaxCodeInPayloadError after a best-effort row in the posting-refusal inbox on the pooled client; the producer's ordinary retry rebuilds the payload from
 * the current rates (the apply re-pointed the documents that could still post). A cancelled document that still references a retired rate cannot enqueue a Xero payload with that code.
 */
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { taxCodesInPayload } from '@/lib/tax/tax-code-fields'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'

export const RETIRED_CODES_SETTING = 'tax_rekey_retired_codes'
export const RETIRED_TAX_CODE_REASON = 'retired_tax_code'

export class RetiredTaxCodeInPayloadError extends Error {
  readonly codes: string[]
  constructor(codes: string[]) {
    super(`The accounting payload carries tax code(s) ${codes.join(', ')} that a tax re-key retired and that no active IMS tax rate carries now; it was not queued. Rebuild it from the current document (retry the action).`)
    this.name = 'RetiredTaxCodeInPayloadError'
    this.codes = codes
  }
}

/** What the guard reads: a Prisma client or transaction. Structural, so a test double without these simply is not guarded. */
type GuardClient = {
  $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
  taxRate?: { findMany(args: { where: { accountingTaxType: { in: string[] }; active: true }; select: { accountingTaxType: true } }): Promise<Array<{ accountingTaxType: string | null }>> }
  setting?: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
}

export type RetiredCodes = Record<string, { rateId: string; newCode: string; at: string }>

export function parseRetiredCodes(value: string | null | undefined): RetiredCodes {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RetiredCodes) : {}
  } catch { return {} }
}

/** The retired codes in `payload` that no active rate carries; [] = fine. Takes the shared lock when the payload carries any custom code. */
export async function retiredTaxCodesInPayload(client: unknown, input: { type: string; payload: unknown }): Promise<string[]> {
  if (input.type === 'TAX_RATE_SYNC') return []
  const codes = taxCodesInPayload(input.payload).filter(isOrganisationSpecificTaxType)
  if (codes.length === 0) return []
  const c = client as GuardClient
  if (typeof c.$executeRaw !== 'function' || c.taxRate === undefined || c.setting === undefined) return []
  await c.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
  const retired = parseRetiredCodes((await c.setting.findUnique({ where: { key: RETIRED_CODES_SETTING }, select: { value: true } }))?.value)
  const suspect = codes.filter((code) => Object.prototype.hasOwnProperty.call(retired, code))
  if (suspect.length === 0) return []
  const active = new Set((await c.taxRate.findMany({ where: { accountingTaxType: { in: suspect }, active: true }, select: { accountingTaxType: true } })).map((r) => r.accountingTaxType))
  return suspect.filter((code) => !active.has(code))
}
