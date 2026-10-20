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
  item({ id: 'R1', mode: 'values', claim: 'IMS stock_levels equal Mintsoft on-hand per (SKU, bound warehouse)', exactness: 'exact', tolerance: EXACT, cadence: 'daily', phases: VENDOR_P1, streams: ['mintsoft-stock-sync'], sources: ['ims-database', 'mintsoft-api'], population: 'the SKUs and warehouses IMS has bound to Mintsoft, while Mintsoft alignment is unconfirmed' }),
  item({ id: 'R2', mode: 'values', claim: 'IMS equals Qoblex StockOnHand per non-3PL location', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'listed-only', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the non-3PL locations named in the Qoblex export manifest' }),
  item({ id: 'R3', mode: 'values', claim: 'StockLevel.quantity equals the sum of CostLayer.remainingQty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R4', mode: 'values', claim: 'StockLevel.reservedQty equals the sum of OrderAllocation.qty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R5', mode: 'values', claim: 'inventory valuation per warehouse and company equals Qoblex', exactness: 'tolerance', tolerance: { rule: 'composite-max-abs-or-relative', value: `max(GBP ${R5_ABSOLUTE_FLOOR_GBP}, ${R5_RELATIVE_FRACTION} of the larger total)`, source: 'owner decision D2 and unverified formula U14' }, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the warehouses and companies named in the Qoblex export manifest' }),
  item({ id: 'R6', mode: 'values', claim: 'the IMS inventory subledger as of the cycle date equals Xero Inventory plus Allocated Inventory', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the accounts configured for inventory and allocated inventory' }),
  item({ id: 'R7', mode: 'values', claim: 'open purchase orders equal Qoblex Incoming (set exact, value exact in GBP, GBP 1 across FX)', exactness: 'set-exact-value-tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the open purchase orders in the Qoblex export manifest' }),
  item({ id: 'R8', mode: 'values', claim: 'outstanding quantity of part-received purchase-order lines equals Qoblex Incoming', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'the open purchase-order lines in the Qoblex export manifest' }),
  item({ id: 'R9', mode: 'values', claim: 'open sales orders equal WooCommerce by order id (set exact, value within one minor unit of the order currency)', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'order-currency-minor-unit', value: '1 minor unit', source: 'owner decision D1' }, cadence: 'daily', phases: VENDOR_P1, streams: ['woocommerce-order-sweep'], sources: ['ims-database', 'woocommerce-api'], population: 'the order statuses enumerated one by one, walked twice' }),
  item({ id: 'R10', mode: 'values', claim: 'Xero control accounts (Inventory, Allocated, Transit) agree with IMS, and no IMS-originated posting reached COGS or Unearned Revenue', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the configured control accounts; postings since the P0 start' }),
  item({ id: 'R11', mode: 'values', claim: 'Stock in Transit equals the open-purchase-order transit schedule, and the transit account differs from the allocated account', exactness: 'tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: ['xero-balance-snapshots'], sources: ['ims-database', 'xero-trial-balance'], population: 'the open purchase orders with goods in transit' }),
  item({ id: 'R12', mode: 'values', claim: 'VAT per (country, reporting category, period) agrees across IMS, Xero and WooCommerce', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'absolute', value: VAT_TOLERANCE_GBP, source: 'owner decision D1' }, cadence: 'monthly', phases: VENDOR_P1, streams: ['xero-tax-rates', 'woocommerce-order-sweep'], sources: ['ims-ledger', 'xero-api', 'woocommerce-api'], population: 'the closed reporting periods inside the budgeted window' }),
  item({ id: 'R13', mode: 'presence', claim: 'every WooCommerce and Xero tax rate is mapped', exactness: 'presence', tolerance: NONE, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-tax-rates'], sources: ['woocommerce-api', 'xero-api'], population: 'the full tax-rate lists of both systems' }),
  item({ id: 'R14', mode: 'presence', claim: 'every SKU is present in Qoblex, WooCommerce, Mintsoft and IMS, except the written exclusions', exactness: 'presence', tolerance: NONE, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file', 'woocommerce-api', 'mintsoft-api'], population: 'the union of the four systems minus unexpired written exclusions' }),
  item({ id: 'R15', mode: 'values', claim: 'the invariant report shows zero critical findings and every warning is accepted in writing', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'the whole invariant report' }),
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
export const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024
export const MAX_EVIDENCE_LINES_PER_ITEM = 20000
export const SYSTEM_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

// ---------------------------------------------------------------------------------------------
// The docs. Marked blocks in docs/installation.md equal these bodies byte for byte.
// ---------------------------------------------------------------------------------------------

export const PACK_DOC_BLOCK_OPEN = (id: string) => `<!-- reconciliation-pack:${id} -->`
export const PACK_DOC_BLOCK_CLOSE = (id: string) => `<!-- /reconciliation-pack:${id} -->`
export type PackDocBlockId = 'overview' | 'outcomes' | 'proof' | 'inputs' | 'reasons' | 'refusals' | 'items' | 'settling' | 'chain' | 'exit-codes' | 'audit'

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
  { klass: 'secrets or data in text', guard: 'text carries closed codes, counts and sanitised identity tokens only; a token is a cuid, a numeric id, a validated SKU (else a sku# digest) or a warehouse code, and a raw string cannot be typed as one' },
  { klass: 'an aggregate or count standing in for identity', guard: 'comparison is keyed; equal counts with one identity swapped fail (onlyIms plus onlyVendor); counts are derived from the lists and the reader recomputes them' },
  { klass: '"looks empty so skipped"', guard: 'empty on both sides is EMPTY_UNPROVEN unless positive evidence is supplied; a run in which nothing passed exits 5, never 0' },
  { klass: 'ordering inferred from timestamps', guard: 'the chain is ordered by sequence and linked by digest; settling uses equality of distinct last-success stamps and never compares two stamps for order' },
  { klass: 'a pass resting on nothing (empty, unbracketed or unattributed)', guard: 'in the builder AND the reader a pass must carry a proof (at least one identity compared, or a named empty-population proof), exactly its catalogue sources, an equal start and end stamp for every dependent stream, no reason, finding or unsettled identity; every other outcome has its own invariants; the exit code is derived from the items by one function' },
  { klass: 'fail-open on unreadable state', guard: 'an unreadable, untrusted, oversized, malformed or inconsistent file, directory or chain refuses (trend) or is inconclusive (item); there is no default that passes' },
  { klass: 'an untrusted-file field reaching text', guard: 'every field read back from a file is validated against a closed set or a strict pattern before use, and the Markdown is rendered from validated values only' },
]
export function renderPackAuditTable(): string {
  return ['| Failure class (found in earlier reviews) | Guard |', '|---|---|', ...PACK_AUDIT_ROWS.map((r) => `| ${r.klass} | ${r.guard} |`)].join('\n')
}

export const PACK_DOC_BLOCKS: Record<PackDocBlockId, string> = {
  overview: [
    `\`${PACK_COMMAND}\` is the reconciliation pack: fifteen items (R1 to R15), each a claim that IMS agrees with a vendor or with its own ledger. It is not a second readiness gate and renders no overall verdict; the gate reads the newest report. This build contains the pack's pure comparators, the report writer and the report reader; the item runners and the command itself arrive in later changes, and until they do every item the gate asks about is "not available". The pack makes no vendor call of any kind in this build.`,
    '',
    'A run publishes `<report-dir>/<run id>/evidence.jsonl`, then `reconciliation-pack.md`, then `reconciliation-pack.json` last, each created exclusively and never through a symlink, fsynced and renamed into place under an exclusive 0700 directory. The JSON is the commit record: it names the Markdown by sha256 (`companionMarkdownSha256`) and the evidence by sha256 and line count, carries a `sequence` and the sha256 of the previous report\'s JSON (`previousReportSha256`), and counts that the reader recomputes from the evidence. Problem text is closed reason codes and counts only; identities appear only as sanitised tokens (a cuid, a numeric vendor id, a validated SKU or `sku#` and eight hex digits, a warehouse code).',
  ].join('\n'),
  outcomes: ['Each item ends in exactly one outcome.', '', renderPackOutcomeTable()].join('\n'),
  proof: [
    'An outcome of pass is only accepted, when a report is written and again when it is read back, if the item record proves it. A pass must carry all of: a proof that at least one identity was compared (bothEqual above zero, with nothing on one side only, differing or unsettled), or the name of the evidence that an empty population is the true one; exactly the sources its catalogue row lists; a start and an end stamp, equal to each other, for every stream the item depends on; no reason code. A fail names a difference; an inconclusive item names why it could not be proven and lists no finding; a not-applicable item is the phase\'s doing alone and carries nothing. Any other combination makes the report invalid and a reader refuses it.',
    '',
    renderPackSourceTable(),
    '',
    renderPackEmptyProofTable(),
  ].join('\n'),
  inputs: ['The comparator never reads an unreadable input as equal, and never fills a gap with a default. Each of these shapes is inconclusive with the code shown; none reaches a bucket or a pass. A difference of zero is the only thing that is equal, and minus zero is read as zero. The comparison mode (values or presence) is fixed per item in the catalogue, and a currency outside the known list has no default number of decimals.', '', renderPackInputShapeTable()].join('\n'),
  reasons: ['Every reason a report can give is one of these codes; no other text describes a problem.', '', renderPackReasonTable()].join('\n'),
  refusals: ['A run is refused, and the trend reader refuses a directory, with exactly one of these codes.', '', renderPackChainCodeTable()].join('\n'),
  items: ['The catalogue. Tolerances are chosen defaults (owner decisions D1 and D2); an exact quantity comparison allows 0.0001.', '', renderPackItemTable()].join('\n'),
  settling: `A difference is not a failure the first time it is seen: a vendor can lag. A keyed difference (an identity on one side only, or a value beyond the tolerance) is carried as unsettled with the last-success stamp of the stream it was read under. It becomes a failure only when it is still there after ${PENDING_PERSISTENCE_RUNS} LATER successful runs of that stream, observed as ${PENDING_PERSISTENCE_RUNS} further DISTINCT last-success values. The stamps are compared for equality only, never for order: a repeated stamp is the same run and makes no progress. A difference that disappears is dropped. While anything is unsettled the item is inconclusive, never a pass. The stream stamp is also read at the start and end of an item\'s read; if it differs the read is BASIS_MOVED. The same item's result is also never a pass when the stream is stale or off.`,
  chain: [
    `Reports are ordered by \`sequence\` (1, 2, 3, ...) and linked by \`previousReportSha256\` (null for sequence 1), never by timestamp. A run takes the run lock (\`${PACK_LOCK_FILE}\` in the report directory, created exclusively with its pid, host and a random token) before it reads the chain and holds it until the report is committed; the lock is checked again immediately before the JSON is put into place. A lock is reclaimed only when its holder is provably dead: on this host the holder's process entry is gone, or its start time or the boot id differs from the ones the lock recorded (the pid was reused or the machine rebooted). A live holder is never displaced, however old its lock, and a lock from another host is never taken; where death cannot be proven (no process table, a lock without an identity, an unreadable lock) the run is refused and an operator decides. Reclaiming goes through a second exclusive file so two reclaimers cannot both win. At the commit the run also claims the sequence number with an exclusive file (\`${PACK_SEQUENCE_CLAIM_PREFIX}<n>\`) and the JSON is linked into place without overwriting, so even a displaced holder cannot place a second commit record for a sequence that is taken.`,
    '',
    `The trend reader verifies every pair (trusted files only, sha256 of the Markdown and the evidence, derived counts, derived outcome and exit code), then the chain: a missing sequence number is a gap and is refused, two reports with the same sequence or the same predecessor are a fork and are refused, and a link whose digest does not match is refused. It reads at most ${MAX_REPORTS_READ} reports and refuses more. NOT defended: deleting the newest report or reports (the shorter chain is still a valid chain), and an account that can write as the report owner or as root.`,
  ].join('\n'),
  'exit-codes': renderPackExitCodeTable(),
  audit: ['The failure classes earlier reviews kept finding, and the guard for each. Every guard has a test that fails when the guard is removed.', '', renderPackAuditTable()].join('\n'),
}

export const PACK_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly PackDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'outcomes', 'proof', 'inputs', 'reasons', 'refusals', 'items', 'settling', 'chain', 'exit-codes', 'audit'] },
]

export function renderPackDocBlock(id: PackDocBlockId): string {
  return `${PACK_DOC_BLOCK_OPEN(id)}\n${PACK_DOC_BLOCKS[id]}\n${PACK_DOC_BLOCK_CLOSE(id)}`
}
