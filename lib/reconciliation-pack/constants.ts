/**
 * THE ONE PLACE THE RECONCILIATION PACK'S WORDS, NAMES AND NUMBERS LIVE.
 *
 * The pack answers, item by item (R1..R15), whether IMS agrees with a vendor or with its own ledger.
 * It is NOT a second readiness gate and it renders NO overall verdict: each item ends in exactly one
 * of four outcomes and the go/no-go decision stays with the gate. Everything an operator reads about
 * it (the item catalogue, the tolerance rules, the outcome and reason words, the exit-code table, the
 * paragraphs docs/installation.md carries) is defined here and nowhere else. The code imports these
 * values; the docs carry marked blocks whose body must equal the text below byte for byte, and
 * tests/reconciliation-pack/docs.test.ts checks EVERY marked block against this module.
 *
 * Imports are types and the gate's existing item list only: no database, no framework.
 */

import { PACK_ITEMS, type PackItemId, type ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import type { ReadSyncStreamId } from '@/lib/ops/read-sync-liveness-constants'

export { PACK_ITEM_IDS } from '@/lib/ops/readiness-gate-constants'
export type { PackItemId } from '@/lib/ops/readiness-gate-constants'

export const PACK_COMMAND = 'npm run reconcile:pack'
export const PACK_REPORT_KIND = 'reconciliation-pack'
export const PACK_SCHEMA_VERSION = 1
export const PACK_REPORT_JSON = 'reconciliation-pack.json'
export const PACK_REPORT_MARKDOWN = 'reconciliation-pack.md'
export const PACK_EVIDENCE_FILE = 'evidence.jsonl'
export const PACK_LOCK_FILE = '.run.lock'
export const PACK_RECLAIM_FILE = '.run.lock.reclaim'
export const DEFAULT_PACK_REPORT_DIR = '/var/tmp/ims-reconciliation-pack-reports'

// ---------------------------------------------------------------------------------------------
// Outcomes and reasons. Closed sets: nothing outside them ever reaches a report's text.
// ---------------------------------------------------------------------------------------------

export const PACK_OUTCOMES = ['pass', 'fail', 'inconclusive', 'not-applicable'] as const
export type PackOutcome = (typeof PACK_OUTCOMES)[number]

export const PACK_OUTCOME_MEANING: Record<PackOutcome, string> = {
  pass: 'the claim was compared on a complete, stable basis and held; nothing differs, nothing is unsettled',
  fail: 'at least one identity is on one side only, or differs beyond the tolerance, and the difference has persisted (or needs no settling)',
  inconclusive: 'the claim could not be proven either way (unreadable, incomplete, stale or still settling); never a pass, and the gate reads it as unreadable',
  'not-applicable': 'the claim does not apply in this phase; the gate reads it as not available',
}

/** Why an outcome is what it is. Every code a report may carry, with its meaning, in one table. */
export const PACK_REASON_CODES = {
  DIFFERENCES: 'one or more identities are on one side only or differ beyond the tolerance',
  UNSETTLED_PENDING: 'a difference was seen but has not yet persisted across two later successful runs of its stream',
  STALE_BASIS: 'a stream the item depends on is stale, off, or reported no usable last-success stamp',
  BASIS_MOVED: 'the stream stamp changed between the start and the end of the read, so the read is not one consistent basis',
  READ_INCOMPLETE: 'a side of the comparison was not read completely',
  EMPTY_UNPROVEN: 'both sides were empty and nothing positively proves that empty is the true answer',
  DUPLICATE_KEY: 'two rows on one side carry the same identity; they are never summed or picked between',
  BAD_KEY: 'a row has no usable identity (a key part that is not a non-empty string or a safe whole number, an unknown kind, no parts, or a row that is not an object); nothing is matched on a guessed identity',
  VALUE_MISSING: 'a value-bearing comparison has a row with no value on one side or both; a missing value is never read as equal',
  BAD_TOLERANCE: 'the tolerance rule is missing, unknown or carries a limit that is not a non-negative plain decimal',
  BAD_MODE: 'the comparison mode (values or presence) is missing or unknown',
  BAD_VALUE: 'a row carries a value that is not a finite decimal number',
  VALUE_SHAPE_MISMATCH: 'one side carries values and the other does not',
  CURRENCY_UNKNOWN: 'the currency of a money comparison is missing or not a known code',
  SOURCE_UNREADABLE: 'a source (database, file or vendor) could not be read or was not trusted',
  CAP_EXCEEDED: 'a read hit its cap, so the population is not proven complete; capped scans never pass',
  NO_POPULATION_RECORD: 'the recorded population the comparison is bounded by is missing or unreadable',
  NO_RUNNER: 'no runner exists on this build for the item',
  PHASE_NOT_APPLICABLE: 'the item does not apply in the phase asked about',
  INTERNAL_ERROR: 'the item runner failed unexpectedly',
} as const
export type PackReasonCode = keyof typeof PACK_REASON_CODES
export const PACK_REASON_CODE_LIST = Object.keys(PACK_REASON_CODES) as PackReasonCode[]

export function isPackReasonCode(value: unknown): value is PackReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PACK_REASON_CODES, value)
}

/**
 * The currencies a minor-unit comparison knows (ISO 4217 alphabetic codes in current use, without the fund and
 * testing codes). A code outside it is CURRENCY_UNKNOWN: there is no default number of decimals for a currency this
 * list does not name. The digits come from the repository's one minor-unit table (lib/domain/math/decimal.ts).
 */
export const PACK_KNOWN_CURRENCIES: ReadonlySet<string> = new Set(('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UYW UZS VED VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG').split(' '))
export function isKnownCurrency(value: unknown): value is string {
  return typeof value === 'string' && PACK_KNOWN_CURRENCIES.has(value)
}

/** Where an item's data came from. A pass must name exactly the sources its catalogue row lists. */
export const PACK_SOURCE_CODES = {
  'ims-database': 'the IMS database, read in one read-only transaction',
  'ims-ledger': 'the IMS accounting subledger as of the cycle date',
  'invariant-report': 'the IMS invariant report',
  'mintsoft-api': 'Mintsoft (GET only)',
  'woocommerce-api': 'WooCommerce (GET only)',
  'xero-api': 'Xero (GET only)',
  'xero-trial-balance': 'the stored Xero trial-balance snapshot',
  'qoblex-file': 'the Qoblex export file named in its manifest',
} as const
export type PackSourceCode = keyof typeof PACK_SOURCE_CODES
export function isPackSourceCode(value: unknown): value is PackSourceCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PACK_SOURCE_CODES, value)
}

/** What can positively prove that an EMPTY population is the true one. A pass with nothing compared must name one. */
export const PACK_EMPTY_PROOF_CODES = {
  'snapshot-run-row-present': 'the as-of snapshot run row exists and records no rows for the population',
  'per-status-total-zero': 'every enumerated status reported a vendor total of zero, read twice',
  'vendor-total-zero': 'the vendor reported a total of zero for the whole population',
  'invariant-report-clean': 'the invariant report ran to the end and lists no finding',
} as const
export type PackEmptyProofCode = keyof typeof PACK_EMPTY_PROOF_CODES
export function isPackEmptyProofCode(value: unknown): value is PackEmptyProofCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PACK_EMPTY_PROOF_CODES, value)
}

/** The proof a pass carries: it compared at least one identity, or it names the evidence that empty is true. */
export type ItemProof = { kind: 'compared' } | { kind: 'proven-empty'; source: PackEmptyProofCode }

/** Why the trend reader or the publisher refused to go on. Closed; printed as these words only. */
export const PACK_CHAIN_CODES = {
  DIR_UNTRUSTED: 'the report directory or an ancestor could be modified by another account, or is not a real directory',
  DIR_UNREADABLE: 'the report directory could not be listed',
  TOO_MANY: 'more report directories than the reader will walk',
  PAIR_INVALID: 'a report pair failed verification (untrusted, unreadable, malformed, or its digests or derived values disagree)',
  GAP: 'a sequence number is missing from the chain',
  FORK: 'two reports claim the same sequence or the same predecessor',
  LINK_BROKEN: 'a report\'s previousReportSha256 is not the digest of the report before it',
  SYSTEM_MISMATCH: 'the chain mixes reports of different system identifiers',
  LOCK_HELD: 'another run holds the run lock (a live holder is never displaced, however old its lock)',
  LOCK_UNREADABLE: 'the run lock exists but cannot be read or understood, so it was not taken',
  LOCK_STALE_CONTENDED: 'a stale lock is being reclaimed by another run, or a reclaim guard was left behind',
  LOCK_UNPROVABLE: 'the run lock exists but its holder cannot be shown dead (no process identity on this host, or a lock written without one); an operator must check the holder and remove the lock by hand',
  LOCK_ERROR: 'the run lock could not be created',
  SEQUENCE_CLAIMED: 'the next sequence number already has a claim file (a run committed it, or died after claiming it); an operator must check the report directory',
  LOCK_LOST: 'the run lock was no longer this run\'s at the moment of commit, so nothing was published',
  WRITE_FAILED: 'a report file could not be written or renamed',
} as const
export type PackChainCode = keyof typeof PACK_CHAIN_CODES

/**
 * Every input shape the comparator refuses, and the closed code it gives. Nothing here reaches a bucket and nothing
 * becomes equal by default: an unreadable input is inconclusive. tests/reconciliation-pack/input-shapes.test.ts runs
 * a case for EVERY id below and fails if an id has no case or a case has no id.
 */
export const PACK_INPUT_SHAPES: ReadonlyArray<{ id: string; shape: string; reason: PackReasonCode }> = [
  { id: 'side-not-array', shape: 'a side that is not a list of rows', reason: 'SOURCE_UNREADABLE' },
  { id: 'row-not-object', shape: 'a row that is null, a number, a string or a list', reason: 'BAD_KEY' },
  { id: 'key-not-list', shape: 'a row whose key is not a list of parts', reason: 'BAD_KEY' },
  { id: 'key-empty', shape: 'a row with no key parts', reason: 'BAD_KEY' },
  { id: 'key-part-not-object', shape: 'a key part that is not an object', reason: 'BAD_KEY' },
  { id: 'key-kind-unknown', shape: 'a key part of an unknown kind', reason: 'BAD_KEY' },
  { id: 'key-raw-object', shape: 'a key part whose raw value is an object, a list, a date, a boolean, a bigint, null or undefined', reason: 'BAD_KEY' },
  { id: 'key-raw-number', shape: 'a key part whose raw value is NaN, infinite, negative, fractional, or not a safe integer', reason: 'BAD_KEY' },
  { id: 'key-raw-string', shape: 'a key part whose raw value is an empty string, a string over 512 characters, or contains a control character', reason: 'BAD_KEY' },
  { id: 'duplicate-key', shape: 'two rows on one side with the same identity', reason: 'DUPLICATE_KEY' },
  { id: 'mode-unknown', shape: 'a comparison mode that is missing or not values or presence', reason: 'BAD_MODE' },
  { id: 'value-missing', shape: 'a value-bearing comparison with a row whose value is missing, null or undefined (either side, or both)', reason: 'VALUE_MISSING' },
  { id: 'value-not-decimal', shape: 'a value that is not a plain decimal string: NaN, Infinity, empty, spaces, exponent, plus sign, hex, comma, non-ASCII digits, a number type, more than 12 decimals or 30 integer digits', reason: 'BAD_VALUE' },
  { id: 'value-in-presence', shape: 'a presence-only comparison with a row that carries a value', reason: 'VALUE_SHAPE_MISMATCH' },
  { id: 'tolerance-missing', shape: 'a value-bearing comparison with no tolerance, an unknown rule, or a limit that is missing, negative or not a plain decimal', reason: 'BAD_TOLERANCE' },
  { id: 'currency-unknown', shape: 'a minor-unit comparison where either currency is missing, lower case, padded, or not in the known list', reason: 'CURRENCY_UNKNOWN' },
  { id: 'currency-one-sided', shape: 'a comparison where one side carries a currency and the other does not', reason: 'CURRENCY_UNKNOWN' },
  { id: 'complete-not-true', shape: 'a side whose completeness is anything other than the boolean true', reason: 'READ_INCOMPLETE' },
  { id: 'empty-unproven', shape: 'nothing compared and no valid empty-population proof', reason: 'EMPTY_UNPROVEN' },
  { id: 'population-not-set', shape: 'a population or exclusion list that is not a set', reason: 'NO_POPULATION_RECORD' },
  { id: 'carried-malformed', shape: 'carried settling state that is not a map of well-formed records', reason: 'SOURCE_UNREADABLE' },
  { id: 'stamp-unusable', shape: 'a settling stamp that is missing or not an ISO time', reason: 'STALE_BASIS' },
]
export function renderPackInputShapeTable(): string {
  return ['| Unreadable input | Reason code |', '|---|---|', ...PACK_INPUT_SHAPES.map((r) => `| ${r.shape} | ${r.reason} |`)].join('\n')
}

/** The buckets of a keyed comparison. Counts are derived from the lists, never stored on their own. */
export const COMPARISON_BUCKETS = ['onlyIms', 'onlyVendor', 'bothEqual', 'bothDiffer', 'unsettled', 'outOfPopulation', 'excluded'] as const
export type ComparisonBucket = (typeof COMPARISON_BUCKETS)[number]
/** The buckets that make an item fail once settled. */
export const FINDING_BUCKETS = ['onlyIms', 'onlyVendor', 'bothDiffer'] as const

// ---------------------------------------------------------------------------------------------
// Tolerances. Each is a rule, a value and a source, stated as a chosen default.
// ---------------------------------------------------------------------------------------------

export const TOLERANCE_RULES = ['exact', 'absolute', 'composite-max-abs-or-relative', 'order-currency-minor-unit', 'none'] as const
export type ToleranceRule = (typeof TOLERANCE_RULES)[number]

/** Quantities and stored decimals: equal to within 0.0001 (the finest stored precision). */
export const EXACT_DECIMAL_TOLERANCE = '0.0001'
export const GBP_ONE_TOLERANCE = '1'
export const VAT_TOLERANCE_GBP = '0.05'
/** R5: max(GBP 1, 0.05% of the larger of the two totals). The base is the larger absolute value so the rule is symmetric. */
export const R5_ABSOLUTE_FLOOR_GBP = '1'
export const R5_RELATIVE_FRACTION = '0.0005'
/** R5 also lists every SKU whose own valuation differs by more than 0.5%; the list never decides the outcome. */
export const R5_PER_SKU_LIST_FRACTION = '0.005'

/** After a difference is first seen, this many LATER successful runs of its stream (distinct last-success stamps) must still show it. */
export const PENDING_PERSISTENCE_RUNS = 2

/** The tolerance rules the comparator can apply. The catalogue names which one each item uses (`measure`). */
export type Tolerance =
  | { rule: 'exact' }
  | { rule: 'absolute'; limit: string }
  | { rule: 'composite'; floor: string; fraction: string }
  | { rule: 'minor-unit' }

export type PackToleranceSpec = { rule: ToleranceRule; value: string; source: string }

// ---------------------------------------------------------------------------------------------
// The item catalogue.
// ---------------------------------------------------------------------------------------------

export const PACK_CADENCES = ['daily', 'weekly', 'monthly'] as const
export type PackCadence = (typeof PACK_CADENCES)[number]
/** How old the newest report may be before the gate stops believing it (D6). */
export const PACK_CADENCE_MAX_AGE_MS: Record<PackCadence, number> = {
  daily: 36 * 60 * 60 * 1000,
  weekly: 8 * 24 * 60 * 60 * 1000,
  monthly: 35 * 24 * 60 * 60 * 1000,
}

export const PACK_APPLICABILITY = ['applicable', 'listed-only', 'not-applicable'] as const
export type PackApplicability = (typeof PACK_APPLICABILITY)[number]

export type PackItemSpec = {
  id: PackItemId
  title: string
  /** values: every identity carries a decimal value on both sides and the values are compared. presence: no value is carried and only the set of identities is compared. Chosen per item, never inferred from the data. */
  mode: 'values' | 'presence'
  /** The tolerance the comparison applies; null exactly when the mode is presence. The reader re-checks every evidence entry against it. */
  measure: Tolerance | null
  claim: string
  exactness: 'exact' | 'tolerance' | 'set-exact-value-tolerance' | 'presence'
  tolerance: PackToleranceSpec
  cadence: PackCadence
  phases: Record<ReadinessPhase, PackApplicability>
  /** The read-sync streams whose freshness the item depends on; a stale or off one makes it inconclusive. */
  streams: readonly ReadSyncStreamId[]
  /** The sources a pass must name, exactly. */
  sources: readonly PackSourceCode[]
  /** How the population the comparison is bounded by is decided (from RECORDED identities, never from a timestamp ordering). */
  population: string
}

const NONE: PackToleranceSpec = { rule: 'none', value: '-', source: 'a count of identities, not a measure' }
const EXACT: PackToleranceSpec = { rule: 'exact', value: EXACT_DECIMAL_TOLERANCE, source: 'stored quantities carry four decimals (plan)' }
const GBP1: PackToleranceSpec = { rule: 'absolute', value: GBP_ONE_TOLERANCE, source: 'owner decision D1' }
const P = (p0: PackApplicability, p1: PackApplicability, p2: PackApplicability): Record<ReadinessPhase, PackApplicability> => ({ P0: p0, P1: p1, P2: p2 })
const VENDOR_P1 = P('not-applicable', 'applicable', 'applicable')

const TITLES = new Map(PACK_ITEMS.map((item) => [item.id, item.title]))
function item(spec: Omit<PackItemSpec, 'title'>): PackItemSpec {
  const title = TITLES.get(spec.id)
  if (!title) throw new Error(`pack item ${spec.id} is not in the readiness gate's list`)
  return { ...spec, title }
}

export const PACK_ITEM_CATALOGUE: readonly PackItemSpec[] = [
  item({ id: 'R1', mode: 'values', measure: { rule: 'exact' }, claim: 'IMS stock_levels equal Mintsoft on-hand per (SKU, bound warehouse)', exactness: 'exact', tolerance: EXACT, cadence: 'daily', phases: VENDOR_P1, streams: ['mintsoft-stock-sync'], sources: ['ims-database', 'mintsoft-api'], population: 'the SKUs and warehouses IMS has bound to Mintsoft, while Mintsoft alignment is unconfirmed' }),
  item({ id: 'R2', mode: 'values', measure: { rule: 'exact' }, claim: 'IMS equals Qoblex StockOnHand per non-3PL location', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'listed-only', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the non-3PL locations named in the Qoblex export manifest' }),
  item({ id: 'R3', mode: 'values', measure: { rule: 'exact' }, claim: 'StockLevel.quantity equals the sum of CostLayer.remainingQty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R4', mode: 'values', measure: { rule: 'exact' }, claim: 'StockLevel.reservedQty equals the sum of OrderAllocation.qty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R5', mode: 'values', measure: { rule: 'composite', floor: R5_ABSOLUTE_FLOOR_GBP, fraction: R5_RELATIVE_FRACTION }, claim: 'inventory valuation per warehouse and company equals Qoblex', exactness: 'tolerance', tolerance: { rule: 'composite-max-abs-or-relative', value: `max(GBP ${R5_ABSOLUTE_FLOOR_GBP}, ${R5_RELATIVE_FRACTION} of the larger total)`, source: 'owner decision D2 and unverified formula U14' }, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the warehouses and companies named in the Qoblex export manifest' }),
  item({ id: 'R6', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'the IMS inventory subledger as of the cycle date equals Xero Inventory plus Allocated Inventory', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the accounts configured for inventory and allocated inventory' }),
  item({ id: 'R7', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'open purchase orders equal Qoblex Incoming (set exact, value exact in GBP, GBP 1 across FX)', exactness: 'set-exact-value-tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the open purchase orders in the Qoblex export manifest' }),
  item({ id: 'R8', mode: 'values', measure: { rule: 'exact' }, claim: 'outstanding quantity of part-received purchase-order lines equals Qoblex Incoming', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the open purchase-order lines in the Qoblex export manifest' }),
  item({ id: 'R9', mode: 'values', measure: { rule: 'minor-unit' }, claim: 'open sales orders equal WooCommerce by order id (set exact, value within one minor unit of the order currency)', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'order-currency-minor-unit', value: '1 minor unit', source: 'owner decision D1' }, cadence: 'daily', phases: VENDOR_P1, streams: ['woocommerce-order-sweep'], sources: ['ims-database', 'woocommerce-api'], population: 'the order statuses enumerated one by one, walked twice' }),
  item({ id: 'R10', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'Xero control accounts (Inventory, Allocated, Transit) agree with IMS, and no IMS-originated posting reached COGS or Unearned Revenue', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the configured control accounts; postings since the P0 start' }),
  item({ id: 'R11', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'Stock in Transit equals the open-purchase-order transit schedule, and the transit account differs from the allocated account', exactness: 'tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: ['xero-balance-snapshots'], sources: ['ims-database', 'xero-trial-balance'], population: 'the open purchase orders with goods in transit' }),
  item({ id: 'R12', mode: 'values', measure: { rule: 'absolute', limit: VAT_TOLERANCE_GBP }, claim: 'VAT per (country, reporting category, period) agrees across IMS, Xero and WooCommerce', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'absolute', value: VAT_TOLERANCE_GBP, source: 'owner decision D1' }, cadence: 'monthly', phases: VENDOR_P1, streams: ['xero-tax-rates', 'woocommerce-order-sweep'], sources: ['ims-ledger', 'xero-api', 'woocommerce-api'], population: 'the closed reporting periods inside the budgeted window' }),
  item({ id: 'R13', mode: 'presence', measure: null, claim: 'every WooCommerce and Xero tax rate is mapped', exactness: 'presence', tolerance: NONE, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-tax-rates'], sources: ['woocommerce-api', 'xero-api'], population: 'the full tax-rate lists of both systems' }),
  item({ id: 'R14', mode: 'presence', measure: null, claim: 'every SKU is present in Qoblex, WooCommerce, Mintsoft and IMS, except the written exclusions', exactness: 'presence', tolerance: NONE, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file', 'woocommerce-api', 'mintsoft-api'], population: 'the union of the four systems minus unexpired written exclusions' }),
  item({ id: 'R15', mode: 'values', measure: { rule: 'exact' }, claim: 'the invariant report shows zero critical findings and every warning is accepted in writing', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'the whole invariant report' }),
]

export function getPackItem(id: PackItemId): PackItemSpec {
  const found = PACK_ITEM_CATALOGUE.find((spec) => spec.id === id)
  if (!found) throw new Error(`pack item ${id} is not in the catalogue`)
  return found
}

export function itemApplicability(id: PackItemId, phase: ReadinessPhase): PackApplicability {
  return getPackItem(id).phases[phase]
}

// ---------------------------------------------------------------------------------------------
// Exit codes, documented once.
// ---------------------------------------------------------------------------------------------

export type PackExitCode = { code: number; name: string; meaning: string }
export const PACK_EXIT_CODES: readonly PackExitCode[] = [
  { code: 0, name: 'all-pass', meaning: 'every applicable item passed, at least one item passed, and the report was published' },
  { code: 1, name: 'fail', meaning: 'at least one item failed; the report was published and names each' },
  { code: 5, name: 'inconclusive', meaning: 'no item failed, but at least one item could not be proven (or nothing at all was proven); the report was published. Never a pass' },
  { code: 2, name: 'refused', meaning: 'the pack refused to run (bad arguments, an unsafe report directory, a held run lock, a broken report chain); no item was run and nothing was published' },
  { code: 3, name: 'report-not-published', meaning: 'a verdict per item was reached but the report could not be durably published; the outcomes are not evidence and must not be relied on' },
  { code: 4, name: 'internal', meaning: 'the pack itself failed unexpectedly before it could reach an outcome; treat as inconclusive' },
]

export function packExitCode(name: string): number {
  const found = PACK_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`pack exit code ${name} is not in the table`)
  return found.code
}

export function renderPackExitCodeTable(): string {
  const rows = [...PACK_EXIT_CODES].sort((a, b) => a.code - b.code).map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Run lock and publication limits.
// ---------------------------------------------------------------------------------------------

export const PACK_SEQUENCE_CLAIM_PREFIX = '.seq-'
/** The most report pairs the trend reader will walk; more is refused, not truncated. */
export const MAX_REPORTS_READ = 5000
export const MAX_REPORT_JSON_BYTES = 4 * 1024 * 1024
export const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024
/** Every identity of an item is one evidence line, equal ones included; more than this and the item cannot pass. */
export const MAX_EVIDENCE_LINES_PER_ITEM = 100000
/** A bound on what the builder will even look at: a longer list in one bucket is refused outright. */
export const MAX_ENTRIES_PER_BUCKET = 1000000
/** The system identifier is what PostgreSQL itself produces (pg_control_system().system_identifier): digits only. Nothing free-form. */
export const SYSTEM_IDENTIFIER_RE = /^[0-9]{10,20}$/

// ---------------------------------------------------------------------------------------------
// The docs. Marked blocks in docs/installation.md equal these bodies byte for byte.
// ---------------------------------------------------------------------------------------------

/**
 * EVERY FIELD THAT CAN REACH PUBLISHED OUTPUT (the JSON, the Markdown, evidence.jsonl, the directory and claim file
 * names, the run lock), each with the anchored allowlist grammar it must match. There is no free-form text field.
 * A test publishes a rich report, walks every key and string value of every output, and fails on a key that has no
 * row here or a value that does not match its row.
 */
export type PackPublishedField = { field: string; where: string; grammar: string; pattern: RegExp | null }
const CODE = (words: readonly string[]) => new RegExp(`^(?:${words.join('|')})$`)
const HEX64 = /^[0-9a-f]{64}$/
const ISO_STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/
export const PACK_PUBLISHED_FIELDS: readonly PackPublishedField[] = [
  { field: 'schemaVersion', where: 'JSON', grammar: 'the integer 1', pattern: null },
  { field: 'kind', where: 'JSON; proof.kind', grammar: 'reconciliation-pack, compared or proven-empty', pattern: /^(?:reconciliation-pack|compared|proven-empty)$/ },
  { field: 'runId', where: 'JSON, Markdown, directory name, claim file', grammar: '8 digits, T, 6 digits, Z, a hyphen and 12 lower-case hex digits', pattern: /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/ },
  { field: 'systemIdentifier', where: 'JSON, Markdown', grammar: '10 to 20 digits: the identifier PostgreSQL itself produces for the cluster', pattern: /^[0-9]{10,20}$/ },
  { field: 'phase', where: 'JSON, Markdown', grammar: 'P0, P1 or P2', pattern: /^P[012]$/ },
  { field: 'asOf', where: 'JSON, Markdown', grammar: 'a real calendar date, YYYY-MM-DD', pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ },
  { field: 'startedAt', where: 'JSON, Markdown', grammar: 'an ISO time in UTC with a trailing Z', pattern: ISO_STAMP },
  { field: 'finishedAt', where: 'JSON, Markdown', grammar: 'an ISO time in UTC with a trailing Z', pattern: ISO_STAMP },
  { field: 'start', where: 'JSON stream brackets', grammar: 'an ISO time in UTC with a trailing Z, or null', pattern: ISO_STAMP },
  { field: 'end', where: 'JSON stream brackets', grammar: 'an ISO time in UTC with a trailing Z, or null', pattern: ISO_STAMP },
  { field: 'first', where: 'evidence settling', grammar: 'an ISO time in UTC with a trailing Z', pattern: ISO_STAMP },
  { field: 'later', where: 'evidence settling', grammar: 'a list of ISO times in UTC with a trailing Z', pattern: ISO_STAMP },
  { field: 'streams', where: 'JSON', grammar: 'at most six stream brackets', pattern: null },
  { field: 'items', where: 'JSON', grammar: 'exactly fifteen item records, R1 to R15 in order', pattern: null },
  { field: 'evidence', where: 'JSON', grammar: 'an object with file, sha256 and lines', pattern: null },
  { field: 'proof', where: 'JSON items', grammar: 'null, or an object with kind (and source)', pattern: null },
  { field: 'sequence', where: 'JSON', grammar: 'a positive whole number', pattern: null },
  { field: 'previousReportSha256', where: 'JSON', grammar: '64 lower-case hex digits, or null for sequence 1', pattern: HEX64 },
  { field: 'companionMarkdownSha256', where: 'JSON', grammar: '64 lower-case hex digits', pattern: HEX64 },
  { field: 'sha256', where: 'JSON evidence record', grammar: '64 lower-case hex digits', pattern: HEX64 },
  { field: 'bothEqualSha256', where: 'JSON items', grammar: '64 lower-case hex digits, or null', pattern: HEX64 },
  { field: 'file', where: 'JSON evidence record', grammar: 'the file name evidence.jsonl', pattern: /^evidence\.jsonl$/ },
  { field: 'lines', where: 'JSON evidence record', grammar: 'a non-negative whole number', pattern: null },
  { field: 'stream', where: 'JSON stream brackets', grammar: 'one of the read-sync stream ids', pattern: /^(?:woocommerce-order-sweep|mintsoft-stock-sync|mintsoft-dispatch-poll|mintsoft-order-status|xero-balance-snapshots|xero-tax-rates)$/ },
  { field: 'id', where: 'JSON items', grammar: 'R1 to R15', pattern: /^R(?:[1-9]|1[0-5])$/ },
  { field: 'item', where: 'evidence lines', grammar: 'R1 to R15', pattern: /^R(?:[1-9]|1[0-5])$/ },
  { field: 'bucket', where: 'evidence lines', grammar: 'one of the seven comparison buckets', pattern: CODE(COMPARISON_BUCKETS) },
  { field: 'applicability', where: 'JSON items', grammar: 'applicable, listed-only or not-applicable', pattern: CODE(PACK_APPLICABILITY) },
  { field: 'outcome', where: 'JSON items', grammar: 'pass, fail, inconclusive or not-applicable', pattern: CODE(PACK_OUTCOMES) },
  { field: 'reasons', where: 'JSON items', grammar: 'a list of reason codes from the closed table', pattern: CODE(PACK_REASON_CODE_LIST) },
  { field: 'source', where: 'JSON items proof', grammar: 'a code from the empty-proof table', pattern: CODE(Object.keys(PACK_EMPTY_PROOF_CODES)) },
  { field: 'sources', where: 'JSON items', grammar: 'a list of codes from the source table', pattern: CODE(Object.keys(PACK_SOURCE_CODES)) },
  { field: 'key', where: 'evidence lines', grammar: 'one or more identity tokens joined by |: a digested form kind#8 hex digits, a cuid, a numeric id, or a SKU or warehouse token that passes the allowed-character pattern AND the credential screen (see Identity tokens)', pattern: null },
  { field: 'ims', where: 'evidence lines', grammar: 'a canonical plain decimal, or null', pattern: /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,11}[1-9])?$/ },
  { field: 'vendor', where: 'evidence lines', grammar: 'a canonical plain decimal, or null', pattern: /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,11}[1-9])?$/ },
  { field: 'delta', where: 'evidence lines', grammar: 'a canonical plain decimal, or null', pattern: /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,11}[1-9])?$/ },
  { field: 'imsCurrency', where: 'evidence lines', grammar: 'a code from the known-currency list, or null', pattern: /^[A-Z]{3}$/ },
  { field: 'vendorCurrency', where: 'evidence lines', grammar: 'a code from the known-currency list, or null', pattern: /^[A-Z]{3}$/ },
  { field: 'imsPresent', where: 'evidence lines', grammar: 'true or false', pattern: null },
  { field: 'vendorPresent', where: 'evidence lines', grammar: 'true or false', pattern: null },
  { field: 'settling', where: 'evidence lines (unsettled only)', grammar: 'an object with first and later', pattern: null },
  { field: 'counts', where: 'JSON items', grammar: 'seven non-negative whole numbers named by bucket', pattern: null },
  { field: 'evidenceLines', where: 'JSON items', grammar: 'a non-negative whole number', pattern: null },
  { field: 'summary', where: 'JSON', grammar: 'four non-negative whole numbers', pattern: null },
  { field: 'exitCode', where: 'JSON, Markdown', grammar: 'one of 0, 1 or 5', pattern: null },
  { field: 'host', where: 'run lock only, never a report', grammar: 'a DNS-style host name: dot-separated labels of letters, digits and hyphens, at most 253 characters', pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*)?$/ },
  { field: 'token', where: 'run lock only', grammar: '32 lower-case hex digits', pattern: /^[0-9a-f]{32}$/ },
  { field: 'pid', where: 'run lock only', grammar: 'a positive whole number', pattern: null },
  { field: 'createdAt', where: 'run lock only', grammar: 'an ISO time in UTC with a trailing Z', pattern: ISO_STAMP },
  { field: 'startTime', where: 'run lock only', grammar: 'digits (field 22 of /proc/<pid>/stat), or null', pattern: /^[0-9]+$/ },
  { field: 'bootId', where: 'run lock only', grammar: 'hex digits and hyphens (the kernel boot id), or null', pattern: /^[0-9a-f-]{1,64}$/ },
]
export function renderPackPublishedFieldTable(): string {
  return ['| Field | Appears in | Grammar |', '|---|---|---|', ...PACK_PUBLISHED_FIELDS.map((f) => `| ${f.field} | ${f.where} | ${f.grammar} |`)].join('\n')
}

// ---------------------------------------------------------------------------------------------
// The as-of basis (lib/reconciliation-pack/basis.ts): why a cycle date has no usable basis.
// ---------------------------------------------------------------------------------------------

/** The accounts the as-of basis needs a stored trial-balance balance for, in this order, and the setting that names each. */
export const PACK_BASIS_ACCOUNTS = [
  { kind: 'inventory', label: 'Inventory', settingKey: 'xero_inventory_account' },
  { kind: 'allocated', label: 'Allocated Inventory', settingKey: 'xero_allocated_inventory_account' },
  { kind: 'transit', label: 'Stock in Transit', settingKey: 'xero_transit_account' },
  { kind: 'cogs', label: 'Cost of Goods Sold', settingKey: 'xero_cogs_account' },
  { kind: 'unearned', label: 'Unearned Revenue', settingKey: 'xero_unearned_revenue_account' },
] as const
export type PackBasisAccountKind = (typeof PACK_BASIS_ACCOUNTS)[number]['kind']

/** Every reason the basis can be unavailable. The first four before `not_for_date` are the inventory GL evaluator's own words. */
export const PACK_BASIS_REASONS = {
  no_account_configured: 'the Xero plugin is not on, or one of the five accounts (Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold, Unearned Revenue) has no configured code',
  no_gl_snapshot: 'no stored trial-balance balance exists, on any date, for a configured account',
  not_for_date: 'stored balances exist for a configured account but none for exactly the cycle date; a balance for an earlier or later date is never substituted',
  gl_snapshot_ambiguous: 'more than one stored balance exists for one configured account on the cycle date',
  gl_snapshot_other_tenant: 'the stored balances for a configured account on the cycle date were fetched under a different Xero organisation than the one now connected, or do not record which one; they are never used. Pull the date again under the connected organisation',
  gl_snapshot_unlabelled: 'a stored balance for the cycle date does not say whether Xero reported the account or the account was absent from the trial balance (it was stored by an older build); pull the date again',
  no_subledger_snapshot: 'no inventory snapshot run row exists for the cycle date',
  unreliable_subledger_snapshot: 'at least one inventory snapshot row for the cycle date is not point-in-time reliable',
  subledger_snapshot_incomplete: 'the number of inventory snapshot rows for the cycle date is not the number its run row recorded',
  stream_not_fresh: 'the Xero balance-snapshot stream was not fresh and unmoved at both liveness reads, or liveness could not be read',
  basis_unreadable: 'the basis could not be read: the cycle date is not a real calendar date, a database error or timeout, or a stored value that is not a finite number',
} as const
export type PackBasisReason = keyof typeof PACK_BASIS_REASONS
export const PACK_BASIS_REASON_LIST = Object.keys(PACK_BASIS_REASONS) as PackBasisReason[]

export function renderPackBasisReasonTable(): string {
  return ['| Basis reason | Meaning |', '|---|---|', ...PACK_BASIS_REASON_LIST.map((r) => `| ${r} | ${PACK_BASIS_REASONS[r]} |`)].join('\n')
}

export const PACK_DOC_BLOCK_OPEN = (id: string) => `<!-- reconciliation-pack:${id} -->`
export const PACK_DOC_BLOCK_CLOSE = (id: string) => `<!-- /reconciliation-pack:${id} -->`
export type PackDocBlockId = 'overview' | 'outcomes' | 'proof' | 'tokens' | 'inputs' | 'reasons' | 'refusals' | 'items' | 'settling' | 'liveness' | 'basis' | 'chain' | 'exit-codes' | 'audit'

export function renderPackOutcomeTable(): string {
  return ['| Outcome | Meaning |', '|---|---|', ...PACK_OUTCOMES.map((o) => `| ${o} | ${PACK_OUTCOME_MEANING[o]} |`)].join('\n')
}
export function renderPackReasonTable(): string {
  return ['| Reason code | Meaning |', '|---|---|', ...PACK_REASON_CODE_LIST.map((c) => `| ${c} | ${PACK_REASON_CODES[c]} |`)].join('\n')
}
export function renderPackChainCodeTable(): string {
  return ['| Refusal code | Meaning |', '|---|---|', ...(Object.keys(PACK_CHAIN_CODES) as PackChainCode[]).map((c) => `| ${c} | ${PACK_CHAIN_CODES[c]} |`)].join('\n')
}
export function renderPackSourceTable(): string {
  return ['| Source code | Meaning |', '|---|---|', ...(Object.keys(PACK_SOURCE_CODES) as PackSourceCode[]).map((c) => `| ${c} | ${PACK_SOURCE_CODES[c]} |`)].join('\n')
}
export function renderPackEmptyProofTable(): string {
  return ['| Empty-population proof | Meaning |', '|---|---|', ...(Object.keys(PACK_EMPTY_PROOF_CODES) as PackEmptyProofCode[]).map((c) => `| ${c} | ${PACK_EMPTY_PROOF_CODES[c]} |`)].join('\n')
}
export function renderPackItemTable(): string {
  const rows = PACK_ITEM_CATALOGUE.map((s) => `| ${s.id} | ${s.claim} | ${s.exactness} | ${s.tolerance.rule}: ${s.tolerance.value} (${s.tolerance.source}) | ${s.cadence} | P0 ${s.phases.P0}, P1 ${s.phases.P1}, P2 ${s.phases.P2} | ${s.streams.length ? s.streams.join(', ') : 'none'} | ${s.sources.join(', ')} | ${s.population} |`)
  return ['| Item | Claim | Exactness | Tolerance | Cadence | Phases | Dependent streams | Sources | Population |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n')
}

/** What each audited failure class is, and the guard that closes it. Tabulated in the docs; each guard has a mutation that fails a test. */
export const PACK_AUDIT_ROWS: ReadonlyArray<{ klass: string; guard: string }> = [
  { klass: 'TOCTOU between check and use', guard: 'every report file is opened once with O_NOFOLLOW and its digest taken on the same bytes; the run lock is verified (inode and token) immediately before the JSON commit; lock reclaim is serialised by a second exclusive file' },
  { klass: 'starvation of bounded oldest-first scans', guard: 'a read that hits its cap is CAP_EXCEEDED and never passes; there is no oldest-first window, and carried unsettled identities are re-checked first' },
  { klass: 'false findings for pre-cutoff items', guard: 'identities outside the RECORDED population go to outOfPopulation, listed and never counted as findings' },
  { klass: 'secrets or data in text', guard: 'text carries closed codes, counts and sanitised identity tokens only; every other field has an anchored allowlist grammar (the system identifier is digits only); a token is a cuid, a numeric id, or a SKU or warehouse code that passes the character pattern and a credential screen (else a kind#digest), and a raw string cannot be typed as one. Tokens are trusted data keys and the screen is defence in depth, with its residual listed in the docs' },
  { klass: 'an aggregate or count standing in for identity', guard: 'comparison is keyed; equal counts with one identity swapped fail (onlyIms plus onlyVendor); counts are derived from the lists and the reader recomputes them' },
  { klass: '"looks empty so skipped"', guard: 'empty on both sides is EMPTY_UNPROVEN unless positive evidence is supplied; a run in which nothing passed exits 5, never 0' },
  { klass: 'ordering inferred from timestamps', guard: 'the chain is ordered by sequence and linked by digest; settling uses equality of distinct last-success stamps and never compares two stamps for order' },
  { klass: 'a pass resting on nothing (empty, unbracketed or unattributed)', guard: 'in the builder AND the reader a pass must carry a proof (at least one identity compared, or a named empty-population proof), exactly its catalogue sources, an equal start and end stamp for every dependent stream, no reason, finding or unsettled identity; every other outcome has its own invariants; the exit code is derived from the items by one function' },
  { klass: 'a value-mode pass resting on entries with no values', guard: 'an entry is judged against its item and bucket in the builder and again for every evidence line: a value-mode pair needs both values, the true delta and the tolerance verdict of the catalogue measure, a presence item carries none; every equal identity is an evidence line and the reader recomputes the counts and the digest from them' },
  { klass: 'a bucket label believed instead of derived (a one-sided identity published as equal)', guard: 'every entry records which sides had the identity; the bucket of a pair entry is derived from those fields in the builder and the reader, in both modes, and a label that disagrees is refused' },
  { klass: 'identities that were never compared counted as compared (excluded, out of population, unsettled)', guard: 'the comparator issues the "compared" proof only for equal in-population, non-excluded identities, and a named empty proof only when nothing was judged; a table test over every bucket combination in both modes runs comparator, report and reader and asserts nothing else can pass' },
  { klass: 'caller-owned data serialised or written before it is validated', guard: 'input is copied field by field into plain objects through a whitelist (no unknown field, accessor, symbol key, Proxy, class instance, hole or oversized list), the report is built from the copies only, and the finished text passes the reader\'s validation before any file is created' },
  { klass: 'fail-open on unreadable state', guard: 'an unreadable, untrusted, oversized, malformed or inconsistent file, directory or chain refuses (trend) or is inconclusive (item); there is no default that passes' },
  { klass: 'liveness unreadable, or a stale or off stream, treated as fine', guard: 'the status report is read at the start and again at the end of the run; a read that fails or is malformed makes EVERY item inconclusive; an item with a dependent stream that is not fresh at both reads, missing, ambiguous, whose stamp differs between the reads, or whose job is unscheduled or disabled, or a scheduler that was not examined, could not be read or has an untrusted block, cannot pass (STALE_BASIS or BASIS_MOVED); the published bracket of such a stream has no end stamp; no item without liveness is assumed healthy' },
  { klass: 'the latest snapshot on or before now standing in for the cycle date', guard: 'the basis reads each ledger balance for EXACTLY the cycle date and never the latest earlier or later one: a missing exact date is not_for_date, never a substitute' },
  { klass: 'another organisation\'s ledger balance read after a rebind (the snapshot table was shared across organisations)', guard: 'each stored trial-balance balance records the organisation it was fetched under; the basis reads the connected organisation in the same transaction and uses only balances whose recorded organisation equals it; a balance with another or no recorded organisation is gl_snapshot_other_tenant and the basis is unavailable' },
  { klass: 'an account missing from the trial balance read as an explicit zero', guard: 'a zero synthesised for a configured account that a non-empty trial balance omitted is stored with an absent-from-tb reference and read back as absent-from-tb; a stored balance with no recognised reference is gl_snapshot_unlabelled and the basis is unavailable' },
  { klass: 'a subledger read in several snapshots, or a snapshot whose row count is not what its run recorded', guard: 'every IMS read of the basis is made in one READ ONLY REPEATABLE READ transaction with a statement timeout, verified before the first read; the snapshot rows must be reliable and be exactly the number the run row recorded' },
  { klass: 'an untrusted-file field reaching text', guard: 'every field read back from a file is validated against a closed set or a strict pattern before use, and the Markdown is rendered from validated values only' },
]
export function renderPackAuditTable(): string {
  return ['| Failure class (found in earlier reviews) | Guard |', '|---|---|', ...PACK_AUDIT_ROWS.map((r) => `| ${r.klass} | ${r.guard} |`)].join('\n')
}

export const PACK_DOC_BLOCKS: Record<PackDocBlockId, string> = {
  overview: [
    `\`${PACK_COMMAND}\` is the reconciliation pack: fifteen items (R1 to R15), each a claim that IMS agrees with a vendor or with its own ledger. It is not a second readiness gate and renders no overall verdict; the gate reads the newest report. This build contains the pack's pure comparators, the report writer and the report reader, the liveness bracket and the as-of basis; the item runners and the command itself arrive in later changes, and until they do every item the gate asks about is "not available". The pack makes no vendor call of any kind in this build.`,
    '',
    'A run publishes `<report-dir>/<run id>/evidence.jsonl`, then `reconciliation-pack.md`, then `reconciliation-pack.json` last, each created exclusively and never through a symlink, fsynced and renamed into place under an exclusive 0700 directory. The JSON is the commit record: it names the Markdown by sha256 (`companionMarkdownSha256`) and the evidence by sha256 and line count, carries a `sequence` and the sha256 of the previous report\'s JSON (`previousReportSha256`), and counts that the reader recomputes from the evidence. Every identity is one line of the evidence, equal ones included: the reader recomputes every count and the digest of the equal identities from those lines, and re-judges each line against the item\'s catalogue row (which sides had the identity, recorded as explicit presence flags; the value shape the item\'s mode demands; the true difference of the two values; the tolerance verdict; and, for a minor-unit item, the currencies). The bucket of every pair entry is DERIVED from those fields in the builder and again in the reader (both sides present is equal or differing, one side is onlyIms or onlyVendor, neither is invalid) and a label that disagrees is refused. Nothing the caller owns is serialised: the input is copied field by field into plain objects (an unknown field, an accessor, a symbol key, a Proxy, a class instance or a hole is refused), and the finished report is read back by the reader\'s own validation before the first byte is written. Problem text is closed reason codes and counts only; identities appear only as sanitised tokens (a cuid, a numeric vendor id, a validated SKU or `sku#` and eight hex digits, a warehouse code).',
  ].join('\n'),
  outcomes: ['Each item ends in exactly one outcome.', '', renderPackOutcomeTable()].join('\n'),
  proof: [
    'An outcome of pass is only accepted, when a report is written and again when it is read back, if the item record proves it. A pass must carry all of: a proof that at least one identity was compared (bothEqual above zero, with nothing on one side only, differing or unsettled), or the name of the evidence that an empty population is the true one; exactly the sources its catalogue row lists; a start and an end stamp, equal to each other, for every stream the item depends on; no reason code. A fail names a difference; an inconclusive item names why it could not be proven and lists no finding; a not-applicable item is the phase\'s doing alone and carries nothing. Any other combination makes the report invalid and a reader refuses it.',
    '',
    renderPackSourceTable(),
    '',
    renderPackEmptyProofTable(),
  ].join('\n'),
  tokens: [
    'Identity tokens (what evidence.jsonl prints for a SKU, a warehouse code or an id) are TRUSTED DATA KEYS: values the owner\'s own systems produced, not free text. Nothing a vendor or a file says in prose ever reaches output. The screen below is defence in depth for the day a credential is pasted into a SKU column; it is a denylist and incomplete by nature.',
    '',
    'A token is printed as it is only if it matches the allowed-character pattern for its kind (a SKU: letters, digits, dot, slash, underscore and hyphen, starting with a letter or digit, at most 64 characters; a warehouse code: upper-case letters, digits, underscore and hyphen, at most 32; a cuid; a numeric vendor id of at most 18 digits) AND passes the credential screen. Otherwise it is printed as its kind, a hash sign and the first 8 hex digits of its sha256 (for example sku#3aaf0386). The screen digests a token that contains, in any case, one of key, secret, token, passw, pwd, bearer, auth, cred, private, cookie, session, signature, jwt, sk_, pk_, ghp_, gho_, ghs_, xox, akia or asia; or a run of 24 or more letters, digits, plus, slash or equals with no separator; or that starts with eyJ or http; or that is longer than 64 characters. The same screen is applied again to every token read back from a file.',
    '',
    'What this does not cover (the residual): a credential that avoids every listed word, has no 24-character unbroken run and is built from allowed characters would still print; an 8-hex-digit digest of a LOW-entropy secret (a short password) could be guessed offline; a legitimate SKU that contains a listed word (MONKEY-WRENCH, AUTHOR-GUIDE) prints as a digest and is harder to read; cuid and numeric-id parts are not screened; and evidence.jsonl lists every identity, so it is as sensitive as the stock list itself and is written 0600 in a 0700 directory. Free-form fields do not exist: every other field that can reach output has the anchored allowlist grammar in this table.',
    '',
    renderPackPublishedFieldTable(),
  ].join('\n'),
  inputs: ['The comparator never reads an unreadable input as equal, and never fills a gap with a default. Each of these shapes is inconclusive with the code shown; none reaches a bucket or a pass. A difference of zero is the only thing that is equal, and minus zero is read as zero. The comparison mode (values or presence) is fixed per item in the catalogue, and a currency outside the known list has no default number of decimals.', '', renderPackInputShapeTable()].join('\n'),
  reasons: ['Every reason a report can give is one of these codes; no other text describes a problem.', '', renderPackReasonTable()].join('\n'),
  refusals: ['A run is refused, and the trend reader refuses a directory, with exactly one of these codes.', '', renderPackChainCodeTable()].join('\n'),
  items: ['The catalogue. Tolerances are chosen defaults (owner decisions D1 and D2); an exact quantity comparison allows 0.0001.', '', renderPackItemTable()].join('\n'),
  settling: `A difference is not a failure the first time it is seen: a vendor can lag. A keyed difference (an identity on one side only, or a value beyond the tolerance) is carried as unsettled with the last-success stamp of the stream it was read under. It becomes a failure only when it is still there after ${PENDING_PERSISTENCE_RUNS} LATER successful runs of that stream, observed as ${PENDING_PERSISTENCE_RUNS} further DISTINCT last-success values. The stamps are compared for equality only, never for order: a repeated stamp is the same run and makes no progress. A difference that disappears is dropped. While anything is unsettled the item is inconclusive, never a pass. The stream stamp is also read at the start and end of an item\'s read; if it differs the read is BASIS_MOVED. The same item's result is also never a pass when the stream is stale or off.`,
  liveness: [
    'Before and after its reads the pack reads the read-sync status report (the same report `npm run read-sync:status` prints) and compares the two reads. Each item names, in the catalogue above, the streams it depends on. An item cannot pass unless every entry of every such stream (one per binding for the Mintsoft stock sync) was `fresh` at BOTH reads, with a last-success stamp, and the stamp is EQUAL at both reads. Stamps are compared for equality only, never for order or age; "fresh" is the status report\'s own judgement against the stream\'s limit.',
    '',
    'An item is also withheld when the scheduler could not be examined, the crontab could not be read, the managed block cannot be trusted, or a job the item\'s streams depend on is unscheduled or switched off. A stream with no entry, two entries for one instance, or an entry that appears in only one read is not fresh. If either read of the status report fails, is not the shape the report defines, or contradicts itself (an entry marked `fresh` that is older than its own limit, dated in the future or without a stamp; a `stale` one that is young; an age that is not the distance from the report\'s clock to the stamp; counts that are not the tally of the entries; a scheduler that was not examined yet names a problem), EVERY item is inconclusive, including items with no dependent stream: liveness that could not be read is never taken as healthy. The item keeps its numbers; its outcome is inconclusive with STALE_BASIS (not fresh, or the scheduler), BASIS_MOVED (fresh, but a stamp or an instance moved between the reads) or SOURCE_UNREADABLE (a read failed). The published stream bracket of a stream that is not clean has no end stamp, so the report writer and reader refuse a pass on it.',
  ].join('\n'),
  basis: [
    'The as-of basis is the stored evidence a ledger item (R6, R10) compares on. It is read for one cycle date D (default: yesterday, UTC) and reads stored snapshots only: it makes no vendor call and writes nothing. It is AVAILABLE only when ALL of the following hold, and otherwise it names the first reason that fails, from the table below.',
    '',
    '- the Xero plugin is on and each of the five accounts has a configured code: Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold and Unearned Revenue;',
    '- for each of the five accounts there is exactly one stored trial-balance balance, fetched under the Xero organisation connected now (a balance with another or no recorded organisation is never used), whose balance date is EXACTLY D, in the base currency. The latest balance on or before D is never used, and neither is a later one: a balance for another date is `not_for_date`;',
    '- every one of those balances says where it came from: a row Xero reported, or `absent-from-tb`, the zero the pull records for a configured account that a non-empty trial balance omitted. An absent-from-tb zero is carried with that label and is never an explicit zero; a balance with neither label (stored by an older build) makes the basis unavailable until the date is pulled again;',
    '- an inventory snapshot run row exists for D, every inventory snapshot row for D is point-in-time reliable, and the rows are exactly as many as the run row recorded. A run row with no rows is a true zero stock position, and is the named empty-population proof;',
    '- the Xero balance-snapshot stream was fresh and unmoved at both liveness reads.',
    '',
    'Every IMS read of the basis is made in ONE read-only REPEATABLE READ transaction with a statement timeout, so the settings, the ledger balances and the snapshots are one consistent view; the transaction\'s mode is read back and a basis is not built if it is not what was asked for. The inventory subledger is compared with Inventory plus Allocated Inventory by the existing pure evaluator, unchanged. The pull that stores the balances now includes Unearned Revenue, taken from the same trial-balance response as the other four (no extra call); Unearned Revenue is a credit-balance liability, so its stored amount (debit minus credit) is normally negative.',
    '',
    renderPackBasisReasonTable(),
  ].join('\n'),
  chain: [
    `Reports are ordered by \`sequence\` (1, 2, 3, ...) and linked by \`previousReportSha256\` (null for sequence 1), never by timestamp. A run takes the run lock (\`${PACK_LOCK_FILE}\` in the report directory, created exclusively with its pid, host and a random token) before it reads the chain and holds it until the report is committed; the lock is checked again immediately before the JSON is put into place. A lock is reclaimed only when its holder is provably dead: on this host the holder's process entry is gone, or its start time or the boot id differs from the ones the lock recorded (the pid was reused or the machine rebooted). A live holder is never displaced, however old its lock, and a lock from another host is never taken; where death cannot be proven (no process table, a lock without an identity, an unreadable lock) the run is refused and an operator decides. Reclaiming goes through a second exclusive file so two reclaimers cannot both win. At the commit the run also claims the sequence number with an exclusive file (\`${PACK_SEQUENCE_CLAIM_PREFIX}<n>\`) and the JSON is linked into place without overwriting, so even a displaced holder cannot place a second commit record for a sequence that is taken.`,
    '',
    `The trend reader verifies every pair (trusted files only, sha256 of the Markdown and the evidence, derived counts, derived outcome and exit code), then the chain: a missing sequence number is a gap and is refused, two reports with the same sequence or the same predecessor are a fork and are refused, and a link whose digest does not match is refused. It reads at most ${MAX_REPORTS_READ} reports and refuses more. NOT defended: deleting the newest report or reports (the shorter chain is still a valid chain), and an account that can write as the report owner or as root.`,
  ].join('\n'),
  'exit-codes': renderPackExitCodeTable(),
  audit: ['The failure classes earlier reviews kept finding, and the guard for each. Every guard has a test that fails when the guard is removed.', '', renderPackAuditTable()].join('\n'),
}

export const PACK_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly PackDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'outcomes', 'proof', 'tokens', 'inputs', 'reasons', 'refusals', 'items', 'settling', 'liveness', 'basis', 'chain', 'exit-codes', 'audit'] },
]

export function renderPackDocBlock(id: PackDocBlockId): string {
  return `${PACK_DOC_BLOCK_OPEN(id)}\n${PACK_DOC_BLOCKS[id]}\n${PACK_DOC_BLOCK_CLOSE(id)}`
}
