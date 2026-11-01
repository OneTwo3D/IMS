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
 * A CLEARED RATE IS REFUSED ONLY WHILE IT STILL LACKS A VALID LIVE CODE. The re-key records each CLEAR replacement in CLEARED_RATES_SETTING; the marker says "look at this rate", not "refuse it for ever". Under the
 * lock the guard reads the bound rate as it is NOW (taxRateHasValidLiveCode: a code, a Xero built-in or ACTIVE in the stored list of the organisation connected now) and refuses only when it has none. A rate
 * an operator remapped (the tax-rate editor, link-by-name, generate-missing) is therefore admitted at once, whether or not the marker has been dropped; every writer that can give a rate a code also drops
 * its marker in the same transaction (releaseClearedRateMarkers), so the setting does not keep a list of rates that are no longer cleared.
 *
 * LOCK ORDER (one, for everyone): the connector-selection advisory lock FIRST (the Xero connection fence of every writer takes it, as does this guard), then the WooCommerce mapping lock (shared), then tax_rates
 * rows (lib/tax/writable-tax-rate.ts, TAX RATE ROW LOCK ORDER). The guard and releaseClearedRateMarkers take only the first and read or write the setting and the rate rows without locking them (the selection lock
 * already excludes every writer of a code), so they add no edge to the order; releaseClearedRateMarkers must therefore be called in a transaction that took the selection lock before any rate row lock.
 *
 * The refusal is a thrown RetiredTaxCodeInPayloadError after a best-effort row in the posting-refusal inbox on the pooled client; the producer's ordinary retry rebuilds the payload from
 * the current rates (the apply re-pointed the documents that could still post).
 */
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { taxCodeOccurrences, taxRateBindings } from '@/lib/tax/tax-code-fields'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'

const XERO_TAX_TYPE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export const RETIRED_CODES_SETTING = 'tax_rekey_retired_codes'
/** The replacements of rates a re-key CLEARED (no tax code): { [rateId]: { at } }. A payload bound to one is refused (missing_tax_code) while the rate still has no valid live code: the connectors would send NONE (or the order default's code) for a missing tax type. */
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

/** The ids among `rateIds` whose rate row has NO valid live code now (an unknown id counts as lacking one). Reads the rows as they are under the caller's lock. */
async function ratesLackingValidCode(c: GuardClient, rateIds: readonly string[]): Promise<Set<string>> {
  if (rateIds.length === 0 || c.taxRate === undefined) return new Set(rateIds)
  const rows = await c.taxRate.findMany({ where: { id: { in: [...rateIds] } }, select: { id: true, active: true, replacedById: true, accountingTaxType: true } })
  const valid = await validLiveCodes(c, rows.map((r) => r.accountingTaxType).filter((t): t is string => typeof t === 'string'))
  const have = new Set(rows.filter((r) => typeof r.accountingTaxType === 'string' && valid.has(r.accountingTaxType)).map((r) => r.id))
  return new Set(rateIds.filter((id) => !have.has(id)))
}

type MarkerClient = GuardClient & {
  setting?: GuardClient['setting'] & { upsert?(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }): Promise<unknown>; delete?(args: { where: { key: string } }): Promise<unknown> }
}

/**
 * Drop the cleared marker of every rate in `rateIds` that now has a valid live code. EVERY writer that can give a rate a code calls this IN THE SAME TRANSACTION as its write (the tax-rate editor,
 * link-by-name, generate-missing, the tax import, the re-key), so the marker leaves with the code or not at all. It takes the connector-selection lock itself (the lock the re-key holds when it writes the
 * setting, and the guard holds when it reads it), so a writer that forgot to take it first still cannot interleave with a re-key's read-modify-write of the setting; but it must be called before the
 * transaction takes any tax_rates row lock, or in a transaction that already holds the selection lock (all of them do: the fence), to keep the lock order above. Returns the ids dropped.
 */
export async function releaseClearedRateMarkers(tx: unknown, rateIds: readonly string[]): Promise<string[]> {
  const c = tx as MarkerClient
  const ids = [...new Set(rateIds)]
  if (ids.length === 0 || typeof c.$executeRaw !== 'function' || c.setting === undefined || c.setting.upsert === undefined) return []
  await c.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
  const cleared = parseClearedRates((await c.setting.findUnique({ where: { key: CLEARED_RATES_SETTING }, select: { value: true } }))?.value)
  const marked = ids.filter((id) => Object.prototype.hasOwnProperty.call(cleared, id))
  if (marked.length === 0) return []
  const lacking = await ratesLackingValidCode(c, marked)
  const drop = marked.filter((id) => !lacking.has(id))
  if (drop.length === 0) return []
  for (const id of drop) delete cleared[id]
  const value = JSON.stringify(cleared)
  await c.setting.upsert({ where: { key: CLEARED_RATES_SETTING }, create: { key: CLEARED_RATES_SETTING, value }, update: { value } })
  return drop
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
  // ... but only while the rate STILL has none: a rate remapped since the re-key is judged on the code it carries now, read here under the lock (the marker is a hint, not a verdict).
  const markedBound = bound.filter((id) => Object.prototype.hasOwnProperty.call(cleared, id))
  for (const id of await ratesLackingValidCode(c, markedBound)) out.set(`rate:${id}`, MISSING_TAX_CODE_REASON)
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
