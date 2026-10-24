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
  SETTLING_STATE_UNUSABLE: 'the settling state carried from the previous report could not be used (no previous report, another phase, an item that was not compared to the end, a capped listing, or a stream that moved), so every current difference was treated as first seen and none can mature into a failure until a usable report precedes the run; it is never a pass',
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
  GL_LEG_ABSENT: 'a ledger balance the comparison needs is the zero the pull records for an account the trial balance omitted, not a balance Xero reported; it is never compared as a zero',
  CAP_EXCEEDED: 'a read hit its cap, so the population is not proven complete; capped scans never pass',
  NO_POPULATION_RECORD: 'the recorded population the comparison is bounded by is missing or unreadable',
  NO_RUNNER: 'no runner exists on this build for the item',
  VENDOR_READS_OFF: 'the run was not started with --vendor-reads-only, so no vendor was contacted and the item was not read; it is never a pass',
  VENDOR_READ_UNSTABLE: 'a vendor list could not be proven stable: its two full reads differ, its pages disagree about the total, its row count is not the total the vendor reported, a row repeats, or a page is short; no partial list is ever compared',
  UNKNOWN_STATUS: 'a storefront order status the importer admits has no reading (neither a mapping row nor a built-in default), or its mapping rows disagree, so which orders are open cannot be decided',
  AMBIGUOUS_STATUS_MAPPING: 'a stored status-mapping row has a key that only NORMALISES to an admitted storefront status (padding, an odd prefix): the importer\'s own lookup would never match it, so it is neither used nor ignored and which orders are open cannot be decided',
  VENDOR_LIST_UNPROVEN: 'the list of the vendor\'s rates held in IMS is not proven to be the whole list (for Xero: no stored list for the connected organisation, a missing header row, or a row count or digest that does not match the stored rows), so unmapped vendor rates cannot be listed; never a pass',
  VAT_MAPPING_UNVERIFIED: 'a VAT figure depends on a mapping between a Xero tax type and an IMS country and reporting category that is not verified (a reporting category other than the verified one, a tax rate with no country, no category or no Xero tax type, a Xero tax type shared by two IMS rates or absent from the proven Xero list, a tax line no mapping explains, or a shipping account that is not configured, not in the chart or shared with sales or discount, a sales account that is not configured, a taxable Xero line with no account code or on an account that is neither sales, discount nor shipping, a non-zero WooCommerce fee-line tax), so the three systems cannot be compared per key; it is never a pass and nothing is assumed',
  XERO_CONNECTION_UNUSABLE: 'the stored Xero connection cannot be used for a read-only request: no token, a token that is not current (the pack never refreshes a token, because that writes), a connection the tenant guard refuses, an organisation that is not the one whose tax-rate list is proven, or a connection that changed during the run',
  BASE_CURRENCY_NOT_GBP: 'the IMS base currency or the Xero organisation base currency is not GBP, so the GBP tolerance has no stated meaning and nothing is compared',
  VENDOR_AUTH_REFUSED: 'the vendor connection is not in the read-only mode the pack requires (a fixed API key with nothing else configured to log in; a login would replace the key every other integration of the tenant uses), or its address, key or client scope is missing or unusable, so no request was made',
  IDENTITY_CONFLICT: 'the two sides disagree about what one identity IS (the vendor product id recorded for a SKU is not the id the vendor holds for it, a product is a bundle on one side only, or the vendor lists two ids for one SKU), so nothing is matched on a guess; no partial comparison is made',
  BINDING_UNCONFIRMED_NOT_COMPARED: 'a warehouse-system binding whose alignment is not confirmed is not in the comparison population (it is inactive or its stock sync is DISABLED) while another binding is confirmed, so the claim cannot be called retired and nothing was compared for it; never a pass',
  NOT_SELECTED: 'the run was not asked to run the item (--items), so it was not read; it is never a pass',
  PHASE_NOT_APPLICABLE: 'the item does not apply in the phase asked about',
  INTERNAL_ERROR: 'the item runner failed unexpectedly',
  QOBLEX_EXPORT_OFF: 'the run was not started with --qoblex-export, so no Qoblex export was named and nothing was read; it is never a pass (the readiness gate reads it as not available, like VENDOR_READS_OFF)',
  QOBLEX_EXPORT_STALE: 'the Qoblex export is not usable for this run: it is for another cycle date than --as-of, was exported before that day ended, is dated in the future, or is older than the weekly cadence allows',
  SNAPSHOT_UNAVAILABLE: 'the IMS inventory snapshot for the cycle date cannot be relied on: no snapshot run row, rows that are not point-in-time reliable (R5), or a location, product or warehouse the snapshot names that IMS does not hold',
  COLUMN_MAP_NOT_NATIVE: 'the Qoblex export names a column map whose bytes are not exactly the repository\'s native Qoblex map; a column map can rename, replace, fix or skip values, so only the native one is accepted',
  IDENTITY_NOT_CANONICAL: 'a SKU or warehouse code in the Qoblex export is not already in its exact, canonical text (outer whitespace, a non-NFC spelling, a control, zero-width or no-break character, a lower-case warehouse code): the import tool would change it before comparison, and an identity is only ever compared as the system holds it',
  MANIFEST_INCONSISTENT: 'the Qoblex export manifest contradicts itself about a file (one name declared with two digests or spellings, names that differ only in case, a file used both as data and as a column map, or one data file used by two parts with different column maps); the whole manifest is rejected and no part of the export is used',
  EXPORT_INCONSISTENT: 'the Qoblex export disagrees with itself: a SKU its stock part holds is not in its product list, so the product list is incomplete and a comparison built on it would pass by omission',
  LEG_UNAVAILABLE: 'one system of a several-system comparison could not be read or has no reader on this build, so the systems it covers were not compared; a finding among the systems that were read is still reported, and the item never passes',
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
/** The sources that are a vendor's API (a request to a system outside IMS). Named here, where the source codes already are, so no other module spells a connector. */
export const PACK_VENDOR_SOURCES: readonly PackSourceCode[] = ['mintsoft-api', 'woocommerce-api', 'xero-api']
export function isVendorSource(source: PackSourceCode): boolean {
  return PACK_VENDOR_SOURCES.includes(source)
}
export function isPackSourceCode(value: unknown): value is PackSourceCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PACK_SOURCE_CODES, value)
}

/** What can positively prove that an EMPTY population is the true one. A pass with nothing compared must name one. */
export const PACK_EMPTY_PROOF_CODES = {
  'snapshot-run-row-present': 'the as-of snapshot run row exists and records no rows for the population',
  'per-status-total-zero': 'every enumerated status reported a vendor total of zero, in both of two full sweeps',
  'vendor-total-zero': 'the vendor reported a total of zero for the whole population',
  'invariant-report-clean': 'the invariant report ran to the end and lists no finding',
  'qoblex-incoming-report-empty': 'the Qoblex incoming report passed its header check and lists no open purchase order, and IMS holds no open goods purchase order in the same snapshot',
  'alignment-confirmed': 'every vendor-warehouse binding, inactive and disabled ones included, has its alignment confirmed and at least one exists, read in one IMS snapshot twice (before and after the vendor reads), so the claim is retired by construction and nothing was asked of the vendor',
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
/** A reporting period is one calendar month (UTC). The window is the latest this many CLOSED months. */
export const R12_WINDOW_MONTHS = 2
/** A month is CLOSED for a cycle date when the cycle date is at least this many whole days after the month ended (late postings and status changes have settled). */
export const R12_CLOSE_LAG_DAYS = 7
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
  /**
   * Whether a difference is SETTLED over later runs of the item's dependent stream before it fails (the settling block). Only R1 and R9 opt in.
   * An opted-in item carries settling state on every unsettled AND every persisted (failing) entry, and the next run reads it back.
   */
  settles: boolean
  /** How the population the comparison is bounded by is decided (from RECORDED identities, never from a timestamp ordering). */
  population: string
}

const NONE: PackToleranceSpec = { rule: 'none', value: '-', source: 'a count of identities, not a measure' }
const EXACT: PackToleranceSpec = { rule: 'exact', value: EXACT_DECIMAL_TOLERANCE, source: 'stored quantities carry four decimals (plan)' }
const GBP1: PackToleranceSpec = { rule: 'absolute', value: GBP_ONE_TOLERANCE, source: 'owner decision D1' }
const P = (p0: PackApplicability, p1: PackApplicability, p2: PackApplicability): Record<ReadinessPhase, PackApplicability> => ({ P0: p0, P1: p1, P2: p2 })
const VENDOR_P1 = P('not-applicable', 'applicable', 'applicable')

const TITLES = new Map(PACK_ITEMS.map((item) => [item.id, item.title]))
function item(spec: Omit<PackItemSpec, 'title' | 'settles'> & { settles?: boolean }): PackItemSpec {
  const title = TITLES.get(spec.id)
  if (!title) throw new Error(`pack item ${spec.id} is not in the readiness gate's list`)
  return { ...spec, title, settles: spec.settles === true }
}

export const PACK_ITEM_CATALOGUE: readonly PackItemSpec[] = [
  item({ id: 'R1', mode: 'values', measure: { rule: 'exact' }, claim: 'IMS stock_levels equal Mintsoft on-hand per (SKU, bound warehouse)', exactness: 'exact', tolerance: EXACT, cadence: 'daily', phases: VENDOR_P1, streams: ['mintsoft-stock-sync'], sources: ['ims-database', 'mintsoft-api'], settles: true, population: 'the warehouses bound to Mintsoft that are active, sync-enabled and whose alignment is unconfirmed (read in the same snapshot), and in them every stock-tracked IMS product that is linked to Mintsoft (or that Mintsoft lists by SKU) against every non-bundle Mintsoft stock row; KIT products and Mintsoft bundles are set aside' }),
  item({ id: 'R2', mode: 'values', measure: { rule: 'exact' }, claim: 'IMS equals Qoblex StockOnHand per non-3PL location', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'listed-only', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'every active IMS warehouse that has no WMS binding (the manifest must declare exactly these as its non-3PL locations); the IMS side is the inventory snapshot of the cycle date' }),
  item({ id: 'R3', mode: 'values', measure: { rule: 'exact' }, claim: 'StockLevel.quantity equals the sum of CostLayer.remainingQty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R4', mode: 'values', measure: { rule: 'exact' }, claim: 'StockLevel.reservedQty equals the sum of OrderAllocation.qty', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'every stock level the invariant report examined' }),
  item({ id: 'R5', mode: 'values', measure: { rule: 'composite', floor: R5_ABSOLUTE_FLOOR_GBP, fraction: R5_RELATIVE_FRACTION }, claim: 'inventory valuation per warehouse and company equals Qoblex', exactness: 'tolerance', tolerance: { rule: 'composite-max-abs-or-relative', value: `max(GBP ${R5_ABSOLUTE_FLOOR_GBP}, ${R5_RELATIVE_FRACTION} of the larger total)`, source: 'owner decision D2 and unverified formula U14' }, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file'], population: 'every active IMS warehouse that has no WMS binding (declared exactly by the Qoblex export manifest, with the company it groups each under); the IMS side is the inventory snapshot of the cycle date' }),
  item({ id: 'R6', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'the IMS inventory subledger as of the cycle date equals Xero Inventory plus Allocated Inventory', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the accounts configured for inventory and allocated inventory' }),
  item({ id: 'R7', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'open purchase orders equal Qoblex Incoming (set exact, value exact in GBP, GBP 1 across FX)', exactness: 'set-exact-value-tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'every goods purchase order the VERIFIED first load created (recorded provenance) that IMS holds in a committed-incoming status, matched to the Qoblex incoming report by the recorded order reference; orders without first-load provenance are listed, not judged (the export cannot narrow it)' }),
  item({ id: 'R8', mode: 'values', measure: { rule: 'exact' }, claim: 'outstanding quantity of part-received purchase-order lines equals Qoblex Incoming', exactness: 'exact', tolerance: EXACT, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: [], sources: ['ims-database', 'qoblex-file'], population: 'every open line of those first-load orders, identified by order reference and SKU (the export cannot narrow it)' }),
  item({ id: 'R9', mode: 'values', measure: { rule: 'minor-unit' }, claim: 'open sales orders equal WooCommerce by order id (set exact, value within one minor unit of the order currency)', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'order-currency-minor-unit', value: '1 minor unit', source: 'owner decision D1' }, cadence: 'daily', phases: VENDOR_P1, streams: ['woocommerce-order-sweep'], sources: ['ims-database', 'woocommerce-api'], settles: true, population: 'the open order statuses the importer admits, enumerated one by one and walked in two full sweeps; no order is excluded by age' }),
  item({ id: 'R10', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'Xero control accounts (Inventory, Allocated, Transit) agree with IMS, and no IMS-originated posting reached COGS or Unearned Revenue', exactness: 'tolerance', tolerance: GBP1, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-balance-snapshots'], sources: ['ims-ledger', 'xero-trial-balance'], population: 'the configured control accounts; postings since the P0 start' }),
  item({ id: 'R11', mode: 'values', measure: { rule: 'absolute', limit: GBP_ONE_TOLERANCE }, claim: 'Stock in Transit equals the open-purchase-order transit schedule, and the transit account differs from the allocated account', exactness: 'tolerance', tolerance: GBP1, cadence: 'weekly', phases: P('not-applicable', 'not-applicable', 'applicable'), streams: ['xero-balance-snapshots'], sources: ['ims-database', 'xero-trial-balance'], population: 'the whole IMS transit sub-ledger up to the cycle date: open purchase orders, non-open orders still holding transit (named), and the refund-in-transit leg' }),
  item({ id: 'R12', mode: 'values', measure: { rule: 'absolute', limit: VAT_TOLERANCE_GBP }, claim: 'VAT per (country, reporting category, period) agrees across IMS, Xero and WooCommerce', exactness: 'set-exact-value-tolerance', tolerance: { rule: 'absolute', value: VAT_TOLERANCE_GBP, source: 'owner decision D1' }, cadence: 'monthly', phases: VENDOR_P1, streams: ['xero-tax-rates', 'woocommerce-order-sweep'], sources: ['ims-ledger', 'xero-api', 'woocommerce-api'], population: `the latest ${R12_WINDOW_MONTHS} calendar months (UTC) closed for the cycle date (it is the ${R12_CLOSE_LAG_DAYS + 1}th of the following month or later) that began at or after the recorded first load and storefront import, sales VAT excluding shipping` }),
  item({ id: 'R13', mode: 'presence', measure: null, claim: 'every WooCommerce and Xero tax rate is mapped', exactness: 'presence', tolerance: NONE, cadence: 'daily', phases: VENDOR_P1, streams: ['xero-tax-rates'], sources: ['ims-database', 'woocommerce-api', 'xero-api'], population: 'the full tax-rate lists of both systems' }),
  item({ id: 'R14', mode: 'presence', measure: null, claim: 'every SKU is present in Qoblex, WooCommerce, Mintsoft and IMS, except the written exclusions', exactness: 'presence', tolerance: NONE, cadence: 'weekly', phases: VENDOR_P1, streams: [], sources: ['ims-database', 'qoblex-file', 'woocommerce-api', 'mintsoft-api'], population: 'the union of the SKUs of the systems read (Qoblex, WooCommerce top-level products, Mintsoft, IMS), each in every system, minus the unexpired written exclusions (one SKU in one system) and the variations the storefront walk cannot see' }),
  item({ id: 'R15', mode: 'values', measure: { rule: 'exact' }, claim: 'the invariant report shows zero critical findings and every warning is accepted in writing', exactness: 'exact', tolerance: NONE, cadence: 'daily', phases: P('applicable', 'applicable', 'applicable'), streams: [], sources: ['invariant-report'], population: 'the whole invariant report' }),
]

export function getPackItem(id: PackItemId): PackItemSpec {
  const found = PACK_ITEM_CATALOGUE.find((spec) => spec.id === id)
  if (!found) throw new Error(`pack item ${id} is not in the catalogue`)
  return found
}

/** Whether the catalogue lists a vendor API among the item's sources: such an item is read only when the run opted in to vendor reads. */
export function itemNeedsVendor(id: PackItemId): boolean {
  return getPackItem(id).sources.some(isVendorSource)
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
  { code: 2, name: 'refused', meaning: 'the pack refused to run or to publish (bad arguments, an account that may not run it, an unsafe report directory, a held run lock, a broken report chain); nothing was published. Items only read, so a refusal after they ran leaves nothing behind' },
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
// The IMS readers (lib/reconciliation-pack/ims-readers.ts).
// ---------------------------------------------------------------------------------------------

/** The most rows one section of the IMS read returns. More is CAP_EXCEEDED, never a shorter list. */
export const IMS_READER_ROW_CAP = 2_000_000
/** The statement timeout of the IMS read. A statement that runs longer is READ_INCOMPLETE. */
export const IMS_READER_STATEMENT_TIMEOUT_MS = 120_000
/** The largest timeout a caller may ask for; also the idle-in-transaction bound. */
export const IMS_READER_MAX_TIMEOUT_MS = 600_000
/** The statuses a first-load run record can hold (a test pins this list to the runner's own). Only VERIFIED makes a first load a boundary. */
export const FIRST_LOAD_RUN_STATUSES = ['RUNNING', 'STEP_FAILED', 'CONFLICT', 'APPLIED', 'VERIFIED', 'VERIFY_FAILED'] as const
/** The sales-order statuses that make an order OPEN for the reconciliation (a draft is not on the storefront). */
export const IMS_OPEN_ORDER_STATUSES = ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const

/**
 * The built-in reading of a WooCommerce order status when no mapping row says otherwise: a COPY of the connector's own table
 * (lib/connectors/woocommerce/sync/status-mapping.ts WC_BUILT_IN_STATUS_MAP), which imports the application's database client and so
 * cannot be loaded by the pack. A test pins the two equal. The values are SalesOrderStatus names.
 */
export const WOO_BUILT_IN_STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'PENDING_PAYMENT',
  failed: 'PENDING_PAYMENT',
  'on-hold': 'ON_HOLD',
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  refunded: 'PROCESSING',
}
/** The setting that holds the statuses the importer admits (JSON array of strings); absent means the default below, anything else unreadable is a refusal to guess. */
export const WOO_SYNC_STATUSES_SETTING_KEY = 'wc_sync_order_statuses'
/** The customer-withdrawal status settings (copied from sync/withdrawal.ts, which imports the database client); a test pins the keys and defaults equal. */
export const WDRAW_SUBMITTED_STATUS_KEY = 'wc_withdrawal_submitted_status'
export const WDRAW_APPROVED_STATUS_KEY = 'wc_withdrawal_approved_status'
export const WDRAW_DEFAULT_SUBMITTED_STATUS = 'pending-wdraw'
export const WDRAW_DEFAULT_APPROVED_STATUS = 'withdrawn'
/** The status the historical order import asks for besides `completed` (connectors/woocommerce/orders.ts:139, 'completed,delivered'), a manual dated route. */
export const WOO_HISTORICAL_IMPORT_EXTRA_STATUS = 'delivered'
/** The settings the vendor transport reads, and nothing else. */
export const WOO_CREDENTIAL_SETTING_KEYS = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] as const

/** WooCommerce walks. Every number is a bound on what the pack will ask of the live store; none is a default that lets a partial list pass. */
export const WOO_PER_PAGE = 100
/** A walk whose X-WP-Total is above this is CAP_EXCEEDED before page 1 is followed by another request. */
export const WOO_WALK_MAX_ROWS = 20_000
/** All requests of one run, every walk twice. More than this is CAP_EXCEEDED. */
export const WOO_REQUEST_BUDGET = 400
/** The pause between two requests (at most four a second), so a walk never competes with the storefront's own traffic. */
export const WOO_MIN_REQUEST_INTERVAL_MS = 250
/** One request's ceiling. */
export const WOO_REQUEST_TIMEOUT_MS = 60_000
/** The only collections the vendor transport will ask for. */
export const WOO_READ_COLLECTIONS = ['orders', 'products', 'taxes'] as const
export type WooCollection = (typeof WOO_READ_COLLECTIONS)[number]
/** The only query parameters a request may carry. */
export const WOO_READ_PARAMS = ['status', 'page', 'per_page', 'orderby', 'order', '_fields', 'after', 'before'] as const

// ---------------------------------------------------------------------------------------------
// R12 (VAT per country, reporting category and period): the period rule, the Xero reads and their bounds.
// ---------------------------------------------------------------------------------------------

/** The base currency the R12 tolerance (GBP 0.05) is stated in. Any other base currency, in IMS or in Xero, compares nothing. */
export const VAT_BASE_CURRENCY = 'GBP'
/** The storefront statuses whose orders IMS holds as non-cancelled sales (the importer's built-in reading is PROCESSING, COMPLETED, PROCESSING). */
export const R12_WOO_STATUSES = ['processing', 'completed', 'refunded'] as const
/** The storefront is asked for the window widened by this many days on each side (its date filter's zone is unverified); rows are then cut by their GMT creation date. */
export const R12_WOO_DATE_MARGIN_DAYS = 2
/** The Xero sales invoices R12 counts: authorised or paid. Drafts, submitted, voided and deleted invoices carry no VAT liability. */
export const R12_XERO_INVOICE_STATUSES = ['AUTHORISED', 'PAID'] as const
/** The Xero invoices are asked for the window widened by this many days on each side; rows are then cut by their invoice date. */
export const R12_XERO_DATE_MARGIN_DAYS = 1
/** U8 (OSS and EC coding in Xero) is UNVERIFIED: only these reporting categories (lower case) have a verified Xero side. Every other category with VAT in the window is VAT_MAPPING_UNVERIFIED. */
export const R12_VERIFIED_CATEGORIES = ['domestic'] as const
/** The Xero report tax types a verified (domestic) IMS rate must carry in the proven stored Xero list (the generator's own mapping, tax-rate-report-type.ts). */
export const R12_VERIFIED_XERO_REPORT_TAX_TYPES = ['OUTPUT'] as const

/** The Xero reads. GET only, to these two resources, with these parameters. The pack never refreshes a token (that is a write), so the request budget below is the whole of its Xero spend. */
export const XERO_API_BASE_URL = 'https://api.xero.com/api.xro/2.0'
export const XERO_READ_RESOURCES = ['Organisation', 'Invoices'] as const
export type XeroResource = (typeof XERO_READ_RESOURCES)[number]
export const XERO_READ_PARAMS = ['where', 'Statuses', 'page'] as const
/** All Xero requests of one run (the organisation read and both invoice sweeps). Xero allows 950 a day and 55 a minute, shared with the read-sync; more than this is CAP_EXCEEDED, never a shorter list. */
export const XERO_REQUEST_BUDGET = 40
/** The pause between two Xero requests (at most thirty a minute, under the 55 a minute shared limit). */
export const XERO_MIN_REQUEST_INTERVAL_MS = 2000
/** A walk whose reported item count is above this is CAP_EXCEEDED before page 2 is requested. */
export const XERO_WALK_MAX_ROWS = 3000
/** The largest page size Xero may report; a larger one is not believed. */
export const XERO_MAX_PAGE_SIZE = 1000
export const XERO_REQUEST_TIMEOUT_MS = 60_000
/** The stored access token must still have this long to live: the pack never refreshes it. */
export const XERO_TOKEN_MIN_REMAINING_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// The warehouse-system source (R1): GET only, the stored fixed key only, never a login.
// ---------------------------------------------------------------------------------------------

/** The connector id of the warehouse system R1 reads. The only place the pack's generic modules get it from. */
export const PACK_WMS_CONNECTOR_ID = 'mintsoft'
/** The page size of the product list. The vendor answers 400 above 100, so the page size is CLAMPED here and never configured. */
export const WMS_PRODUCT_LIST_LIMIT = 100
/** The most pages of the product list one scan walks; more is CAP_EXCEEDED, never a shorter list. */
export const WMS_PRODUCT_LIST_MAX_PAGES = 200
/** The most requests one run makes to the warehouse system (the stock sweeps, both product scans and the end proofs). Exhausting it is CAP_EXCEEDED. */
export const WMS_REQUEST_BUDGET = 500
/** The pause between two requests of one run: at most about three a second. */
export const WMS_MIN_REQUEST_INTERVAL_MS = 350
export const WMS_REQUEST_TIMEOUT_MS = 60_000
/** The most warehouses one run reads (each is read twice). */
export const WMS_MAX_WAREHOUSES = 20

/** The items whose claim is retired by confirmed alignment (proof `alignment-confirmed`): the only items that may pass without having asked their vendor. */
export const PACK_ALIGNMENT_RETIRABLE_ITEMS: readonly PackItemId[] = ['R1']

/** Why an identity is outside the recorded population. Closed: it is listed under outOfPopulation with one of these and is never a finding. */
export const PACK_POPULATION_REASONS = {
  BEFORE_FIRST_LOAD: 'the identity was created before the recorded, verified first load, so IMS never held it',
  BEFORE_STOREFRONT_IMPORT: 'the storefront order was created before the recorded initial import, which brought in active orders only',
  OLDER_THAN_RETENTION: 'the identity is older than the recorded sales-order retention horizon',
  NOT_REFERENCED_BY_IMS: 'an ACTIVE Xero tax type that no active IMS tax rate, no active component of one and no reverse-charge setting names, so IMS does not use it and it is not compared',
  ALIGNMENT_CONFIRMED: 'stock of a warehouse bound to the warehouse system whose alignment is confirmed (ALIGN_TO_WMS with a confirmation stamp): the sync keeps IMS equal to the warehouse system by construction, so the claim says nothing there',
  BINDING_NOT_ACTIVE: 'stock of a warehouse bound to the warehouse system whose binding is inactive or whose stock sync is DISABLED: nothing keeps it current and nothing reads it',
  KIT_DERIVED_STOCK: 'an IMS KIT product, or a warehouse-system row flagged as a bundle: the stock is derived from components on both sides, so no stored figure is compared',
  NO_WMS_LINK: 'an IMS stock-tracked product that has no warehouse-system product link and whose SKU the warehouse system does not list, so it has no identity there to compare',
  WMS_ZERO_NO_IMS_PRODUCT: 'a warehouse-system stock row of zero for a SKU that no stock-tracked IMS product carries, so there is no IMS figure to differ from',
  NO_STOREFRONT_LINK: 'an open IMS sales order that no WooCommerce order id is recorded for (created in IMS, or from another channel), so it has no storefront identity to compare',
  VARIATION_NOT_WALKED: 'R14: a SKU that is a product variation (VARIANT in IMS or in the Qoblex export); the storefront walk lists top-level products only, so the storefront side of that SKU is not judged',
  NO_SKU_ON_STOREFRONT: 'R14: a storefront product with an empty SKU, which has no SKU identity to compare; it is listed under its storefront id',
  REPORTED_NOT_JUDGED: 'R5: a SKU and warehouse whose own valuation differs between IMS and Qoblex by more than 0.5% of the larger value; reported for the operator, never decisive (the warehouse and company totals decide)',
} as const
export type PackPopulationReason = keyof typeof PACK_POPULATION_REASONS
export function renderPackPopulationTable(): string {
  return ['| Out-of-population reason | Meaning |', '|---|---|', ...(Object.keys(PACK_POPULATION_REASONS) as PackPopulationReason[]).map((c) => `| ${c} | ${PACK_POPULATION_REASONS[c]} |`)].join('\n')
}

// ---------------------------------------------------------------------------------------------
// The Qoblex export (lib/reconciliation-pack/qoblex-source.ts) and the SKU exclusions (sku-exclusions.ts). Items R2, R5, R14.
// ---------------------------------------------------------------------------------------------

/** The manifest the export directory must hold, and the most bytes the source reads of any one file. */
export const QOBLEX_MANIFEST_FILE = 'manifest.json'
export const QOBLEX_MAX_FILE_BYTES = 64 * 1024 * 1024
export const QOBLEX_MANIFEST_VERSION = 1
/** The only currency the Qoblex valuation is compared in. */
export const QOBLEX_BASE_CURRENCY = 'GBP'
/** The most locations a manifest may declare. */
export const QOBLEX_MAX_LOCATIONS = 64
/** A warehouse code or company name as the manifest writes it. */
export const QOBLEX_NAME_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/
/** The prefix the first load put in front of a Qoblex order number to make the IMS purchase-order reference (the first-load manifest's purchaseOrderKeyPrefix): an upper-case token. */
export const QOBLEX_PO_KEY_PREFIX_RE = /^[A-Z0-9][A-Z0-9._-]{0,15}$/
/** A Qoblex purchase-order number as the incoming report writes it: a plain token (no colon, slash, space or control character), so the IMS reference prefix + number is unambiguous. */
export const QOBLEX_PO_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** A plain file name inside the export directory: no path, no leading dot. */
export const QOBLEX_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** R14: the four systems whose SKU lists are compared, and the only systems an exclusion may name. */
export const R14_SYSTEMS = ['qoblex', 'woocommerce', 'mintsoft', 'ims'] as const
export type R14System = (typeof R14_SYSTEMS)[number]
/** The system whose list comes from the 3PL's warehouse system, and the source code each system's leg is reported under. Named here so no other module spells a connector. */
export const R14_WMS_SYSTEM: R14System = 'mintsoft'
export const R14_SYSTEM_SOURCES: Record<R14System, PackSourceCode> = { qoblex: 'qoblex-file', woocommerce: 'woocommerce-api', mintsoft: 'mintsoft-api', ims: 'ims-database' }

/** Owner decision D8: an exclusion is for one SKU in one system, and expires. */
export const SKU_EXCLUSION_SCHEMA_VERSION = 1
export const SKU_EXCLUSION_DEFAULT_FILE = 'ops/reconciliation-sku-exclusions.json'
export const SKU_EXCLUSION_MAX_DAYS = 90
export const SKU_EXCLUSION_MAX_ENTRIES = 20000
export const MAX_SKU_EXCLUSION_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------------------------
// The command: flags and the closed codes it prints.
// ---------------------------------------------------------------------------------------------

export const PACK_CLI_FLAGS: ReadonlyArray<{ flag: string; value: string; meaning: string }> = [
  { flag: '--phase', value: 'P0, P1 or P2', meaning: 'required; there is no default, because an item applies in some phases and not others' },
  { flag: '--as-of', value: 'YYYY-MM-DD', meaning: 'the cycle date D (default: yesterday, UTC); a real calendar date before today (UTC)' },
  { flag: '--items', value: 'R1 to R15, comma-separated, each once', meaning: 'run only these items (default: all); every other item is reported inconclusive with NOT_SELECTED, so a partial run never exits 0 unless every other item the phase applies is not applicable' },
  { flag: '--acceptances', value: 'file', meaning: 'the written warning-acceptance file R15 uses, in the readiness gate\'s format (default ops/readiness-warning-acceptances.json in the checkout; absent means no warning is accepted; a named file that cannot be read is a refusal)' },
  { flag: '--report-dir', value: 'directory', meaning: `where reports are published (default ${DEFAULT_PACK_REPORT_DIR}); created mode 0700 if absent, and it and every ancestor must be modifiable only by root or the running account` },
  { flag: '--basis-only', value: '-', meaning: 'check only whether the as-of basis for --as-of exists, and run no item: it makes the same two liveness reads and the same basis read and settle a run makes, prints `ready` or `not ready` with the first reason from the basis table (and the transit leg\'s reason, which only R10 needs), and exits 0 when ready and 5 when not; ready means the basis is available and the inventory comparison is not withheld' },
  { flag: '--vendor-reads-only', value: '-', meaning: 'allow the vendor items (R1, R9, R12, R13, R14) to read the vendors, GET requests only, to the paths and parameters the pack lists and at the pace it sets (WooCommerce for R9, R12, R13 and R14; Mintsoft for R1 and R14, with its stored fixed API key and never a login; Xero for R12 only, with the stored token, never refreshed); without it NO vendor is contacted, no vendor credential is read, and those items are inconclusive with VENDOR_READS_OFF (the readiness gate reads that as not available, like NO_RUNNER). It never enables a write: the vendor transports refuse any other method' },
  { flag: '--qoblex-export', value: 'directory', meaning: 'the operator-supplied Qoblex export (R2, R5, R7, R8, R14): a directory holding a manifest and the files it names, each read once. Without it the Qoblex items are inconclusive with QOBLEX_EXPORT_OFF and nothing is read. See the Qoblex export contract' },
  { flag: '--sku-exclusions', value: 'file', meaning: 'the written SKU-coverage exclusions R14 uses, one per SKU and system, each expiring within 90 days (default ops/reconciliation-sku-exclusions.json in the checkout; absent means none; a named file that cannot be read is a refusal; a file that is not trusted or not well formed accepts nothing)' },
  { flag: '--help', value: '-', meaning: 'print the usage and the exit codes' },
]
export function renderPackFlagTable(): string {
  return ['| Flag | Value | Meaning |', '|---|---|---|', ...PACK_CLI_FLAGS.map((f) => `| ${f.flag} | ${f.value} | ${f.meaning} |`)].join('\n')
}

/** What the command prints when it stops without a report. The text on the terminal is the code and nothing else. */
export const PACK_CLI_CODES = {
  BAD_ARGUMENTS: 'an argument is unknown, repeated, missing its value, or not in the allowed form',
  CREDENTIAL_ARGUMENT: 'an argument value looks like it carries a credential; secrets are never given on a command line',
  ACCOUNT_NOT_ALLOWED: 'the command was started by an account that is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not in the environment (the command does not read .env files)',
  ACCEPTANCE_FILE_UNREADABLE: 'the acceptance file named with --acceptances could not be read',
  EXCLUSION_FILE_UNREADABLE: 'the exclusion file named with --sku-exclusions could not be read',
  DATABASE_UNREADABLE: 'the database could not be read, so the report could not be attributed to a cluster; nothing was published',
} as const
export type PackCliCode = keyof typeof PACK_CLI_CODES
export function renderPackCliCodeTable(): string {
  return ['| Code | Meaning |', '|---|---|', ...(Object.keys(PACK_CLI_CODES) as PackCliCode[]).map((c) => `| ${c} | ${PACK_CLI_CODES[c]} |`)].join('\n')
}

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
  { field: 'count', where: 'evidence settling', grammar: 'a whole number equal to the length of later', pattern: null },
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
  { field: 'settling', where: 'evidence lines (unsettled entries, and the failing entries of an item that settles)', grammar: 'an object with sequence, first, later and count', pattern: null },
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

/** The setting that records the first day the transit sub-ledger covers (a YYYY-MM-DD text). The transit leg of the basis needs it. */
export const TRANSIT_COVERAGE_SETTING_KEY = 'transit_ledger_coverage_start_date'

/** Why the Stock in Transit leg of R10 cannot be built. The leg is separate: the inventory basis (R6) does not depend on it. */
export const PACK_TRANSIT_LEG_REASONS = {
  transit_ledger_not_covering: 'the recorded first day the transit sub-ledger covers is missing, is not a date, or is later than the day before the cycle date, so the sub-ledger does not cover the window',
  transit_balance_unusable: 'the stored transit balance for the day before the cycle date is missing, ambiguous, from another organisation, unlabelled, in another currency or not a finite number, or the transit account shares its code with another of the five accounts, or the sub-ledger sum is not a finite number',
  transit_absent_from_tb: 'the transit balance at the start or the end of the window is the zero the pull records for an account the trial balance omitted; an account Xero did not report is never read as a reported zero',
} as const
export type PackTransitLegReason = keyof typeof PACK_TRANSIT_LEG_REASONS
export function renderPackTransitLegTable(): string {
  return ['| Transit leg reason | Meaning |', '|---|---|', ...(Object.keys(PACK_TRANSIT_LEG_REASONS) as PackTransitLegReason[]).map((r) => `| ${r} | ${PACK_TRANSIT_LEG_REASONS[r]} |`)].join('\n')
}

/** Every reason the basis can be unavailable. The first four before `not_for_date` are the inventory GL evaluator's own words. */
export const PACK_BASIS_REASONS = {
  no_account_configured: 'the Xero plugin is not on, or one of the five accounts (Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold, Unearned Revenue) has no configured code',
  inventory_accounts_shared: 'Inventory or Allocated Inventory is configured with an account code another of the five accounts also uses, so the inventory comparison would not be over the inventory ledger alone',
  no_gl_snapshot: 'no stored trial-balance balance exists, on any date, for a configured account',
  not_for_date: 'stored balances exist for a configured account but none for exactly the cycle date; a balance for an earlier or later date is never substituted',
  gl_snapshot_ambiguous: 'more than one stored balance exists for one configured account on the cycle date',
  gl_snapshot_other_tenant: 'the stored balances for a configured account on the cycle date were fetched under a different Xero organisation than the one now connected, or do not record which one; they are never used. Pull the date again under the connected organisation',
  gl_snapshot_unlabelled: 'a stored balance for the cycle date does not say whether Xero reported the account or the account was absent from the trial balance (it was stored by an older build); pull the date again',
  no_subledger_snapshot: 'no inventory snapshot run row exists for the cycle date',
  unreliable_subledger_snapshot: 'at least one inventory snapshot row for the cycle date is not point-in-time reliable',
  subledger_snapshot_incomplete: 'the number of inventory snapshot rows for the cycle date is not the number its run row recorded',
  basis_moved: 'the stored balances or the subledger for the cycle date changed between the read inside the liveness bracket and the read after it (a scheduled pull or an on-demand refresh wrote them during the run)',
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
export type PackDocBlockId = 'overview' | 'usage' | 'cli-codes' | 'readers' | 'population' | 'outcomes' | 'proof' | 'tokens' | 'inputs' | 'reasons' | 'refusals' | 'items' | 'settling' | 'liveness' | 'basis' | 'ledger' | 'vendor' | 'qoblex' | 'gate' | 'chain' | 'exit-codes' | 'audit'

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
  { klass: 'false findings for pre-cutoff items', guard: 'identities outside the RECORDED population go to outOfPopulation with a closed reason, listed and never counted as findings; an identity whose boundary has no record, or no creation instant, is unknown and makes the item inconclusive (never in, never out); the first-load record counts only when VERIFIED' },
  { klass: 'a write, or a mixed-instant read, on the IMS side', guard: 'every IMS section is read in one REPEATABLE READ, READ ONLY transaction whose mode is read back and whose snapshot must be equal at the start and the end; only SELECTs and three fixed SET LOCALs can be sent, one statement per text, and it is always rolled back. A no-write proof diffs every table\'s rows and statistics across a real run' },
  { klass: 'a bounded or oldest-first IMS read standing in for the population', guard: 'every section is read in full; over the row cap is CAP_EXCEEDED and a statement timeout is READ_INCOMPLETE; a row that cannot be read exactly makes its whole section unreadable instead of being dropped; stored snapshot rows must match the run row\'s count' },
  { klass: 'a name, flag or location taken as proof (who runs it, what it reads)', guard: 'the account is checked by uid against root and the checkout\'s owner, not by name; the environment is replaced by a whitelist before the database client loads; a credential-shaped argument is refused; the report directory and the acceptance file are trusted only after the ancestor and owner checks; a warning is accepted only by an exact id in a file that passed them' },
  { klass: 'an outcome staying OK after a recorded failure', guard: 'a runner that throws, returns something the report refuses, or reads a stream that was stale or moved is INTERNAL_ERROR, STALE_BASIS or BASIS_MOVED, never a pass; an invariant finding that the pack\'s own comparison would call equal is inconclusive, never a pass; the exit code is derived from the published items by one function and a publication failure is exit 3, not the item verdict' },
  { klass: 'secrets or data in text', guard: 'text carries closed codes, counts and sanitised identity tokens only; every other field has an anchored allowlist grammar (the system identifier is digits only); a token is a cuid, a numeric id, or a SKU or warehouse code that passes the character pattern and a credential screen (else a kind#digest), and a raw string cannot be typed as one. Tokens are trusted data keys and the screen is defence in depth, with its residual listed in the docs' },
  { klass: 'an aggregate or count standing in for identity', guard: 'comparison is keyed; equal counts with one identity swapped fail (onlyIms plus onlyVendor); counts are derived from the lists and the reader recomputes them' },
  { klass: '"looks empty so skipped"', guard: 'empty on both sides is EMPTY_UNPROVEN unless positive evidence is supplied; a run in which nothing passed exits 5, never 0' },
  { klass: 'a vendor lag reported as a failure, or a failure that never matures', guard: 'R1 and R9 settle: a difference fails only after two LATER distinct last-success stamps of its stream, counted from the pack\'s own trusted reports (same installation and phase, compared to the end, not capped, stable bracket); a repeated stamp makes no progress, a stamp is never ordered, a changed value or kind restarts the count, and carried state that cannot be used leaves every difference first seen with SETTLING_STATE_UNUSABLE (inconclusive, never a pass, never settled)' },
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
  { klass: 'an account missing from the trial balance read as an explicit zero', guard: 'a zero synthesised for a configured account that a non-empty trial balance omitted is stored with an absent-from-tb reference and read back as absent-from-tb, and when the Inventory or Allocated Inventory balance is one, the inventory comparison is withheld (no result at all, never `balanced` on an inferred zero); a stored balance with no recognised reference is gl_snapshot_unlabelled and the basis is unavailable' },
  { klass: 'a subledger read in several snapshots, or a snapshot whose row count is not what its run recorded', guard: 'every IMS read of the basis is made in one READ ONLY REPEATABLE READ transaction with a statement timeout, verified before the first read; the snapshot rows must be reliable and be exactly the number the run row recorded' },
  { klass: 'an untrusted-file field reaching text', guard: 'every field read back from a file is validated against a closed set or a strict pattern before use, and the Markdown is rendered from validated values only' },
  { klass: 'the liveness reader or the as-of basis taking the application\'s database client, so the invariant run loses its one snapshot (or reads on a spent transaction)', guard: 'the status report is read by a child process and the basis through a client of its own, one per transaction and always disconnected; the date helpers and the transit coverage rule live in modules that import no database client; a test loads the command and every pack module in a fresh process and fails if the application\'s client exists afterwards' },
  { klass: 'a ledger item passing on a basis that was not settled, or on an account Xero did not report', guard: 'R6, R10 and R11 run only after the end liveness read, on the basis settleAsOfBasis returned (a read that moved, or a stream that was not fresh and unmoved, is the item\'s inconclusive result); a balance that is the zero the pull synthesised withholds its leg (GL_LEG_ABSENT) even where it would balance, the evaluator and the pack\'s comparison must agree on every leg, and every basis field is validated before use' },
  { klass: 'an IMS-originated write to Xero missed because of its status, type, source or instant', guard: 'the postings leg takes every sync-log row of the Xero connector that is SYNCED, PROCESSING or carries a document id, of ANY type and whatever the settlement basis; the instant is the latest of the sync time, the processing start and the creation time (so a host clock behind the database never moves a row created after the boundary out of it); the population boundary is the recorded VERIFIED first-load start (at that instant is inside); a missing boundary or unreadable instant is inconclusive, never in or out' },
  { klass: 'a vendor read that writes (a token refreshed or a counter stored on the way to a GET)', guard: 'R12 does not use the connector\'s Xero client: its transport reads the stored access token in a read-only transaction and never refreshes it (an expiring token is XERO_CONNECTION_UNUSABLE), has no method parameter, and its hop gate refuses everything but a GET to the organisation or the invoice list with the fixed parameters; the no-write test runs the whole command against loopback doubles and finds only SELECTs and GETs' },
  { klass: 'an unverified mapping assumed (how Xero codes OSS, EC sales and reverse charge; a shared or missing tax type)', guard: 'R12 places a figure only by a rate whose category is on the verified list, whose Xero tax type is its own, in the proven stored Xero list with the verified report tax type; any non-zero VAT elsewhere, in any system, is VAT_MAPPING_UNVERIFIED for the whole item before a pass is possible' },
  { klass: 'a Xero list that is partial because its page size was assumed, or its count was taken on trust', guard: 'R12 sends no page size, requires Xero\'s own pagination object, checks every page against the size it reports, the count and the unique invoices read against the item count, enforces the request budget (CAP_EXCEEDED, never a shorter list) and reads the whole walk twice' },
  { klass: 'lines omitted from a vendor invoice or order so that their tax is missing from a figure', guard: 'R12 reconciles each Xero invoice (TotalTax, SubTotal, Total and the line amounts per LineAmountTypes, exactly) and each store order (total_tax against its tax lines and shipping tax), so omitted lines must offset in tax and in amounts to stay hidden; the residual (omitted lines netting to zero in both) is a stated trust boundary: the API gives no independent line count' },
  { klass: 'a period that is not complete, or a fresh report about an old cycle date', guard: 'R12 reads only months that ended at least the stated lag before the cycle date, drops months before the recorded first load and storefront import, and its cycle-dated source makes the gate require a current cycle date' },
  { klass: 'a vendor called without the operator asking, or called with anything but a read', guard: 'without --vendor-reads-only the vendor items are inconclusive VENDOR_READS_OFF before any port or credential is touched and the whole run makes no request; each vendor transport has no method parameter and gives the connector fetch seam a gate that refuses any request that is not a GET to one of three collections on the store\'s own origin (WooCommerce), or to exactly the Mintsoft stock list of one warehouse or one page of its product list on its own origin, or to the Xero organisation or invoice list on api.xero.com with the fixed parameters (R12), with the listed parameters, and refuses redirects; the gate reads the flag-off report as not available only when VENDOR_READS_OFF is the single reason' },
  { klass: 'an admitted order status left out of a comparison because one route or setting was read and another was not', guard: 'the walked statuses are the union of every route that admits by status, from the connector\'s own shared rule (the selection, the withdrawal pair from their settings, completed, delivered; an empty selection admits nothing on the sweeps), each read by the importer\'s own mapping lookup; a setting that cannot be read or interpreted is inconclusive, never defaulted' },
  { klass: 'an order excluded from a comparison by an instant that does not prove the importer would not admit it', guard: 'R9 sets aside no order by age: the importer admits by current status whatever the creation date (the rules are cited by file and line in the vendor items section), retention archives only terminal orders, and comparing a storefront timestamp with an IMS one is cross-system clock ordering the pack never does; every store order in an admitted open status is judged, so one IMS lacks fails the item' },
  { klass: 'a partial vendor list standing in for the whole (a page lost, a total ignored, a store that repeats a page or changes under the walk, an order that moves between statuses between two status walks)', guard: 'orders are read as two full sweeps of every status and their combined populations must be identical (an order in one sweep only is unstable; limit: an order that moves between open statuses twice within one run could be missed by both); a walk is used only if every response is a 200 JSON array with both pagination headers as plain whole numbers, every page agrees on the total and page count, the lengths are exactly the page size and the remainder, ids ascend strictly and never repeat, the rows read equal the total, and a second full read equals the first; any other state is a closed reason and no list at all' },
  { klass: 'a login (a key rotation) at a shared fulfilment tenant made by a read', guard: 'the Mintsoft reader has no code path that can reach /api/Auth: before any request it reads the stored configuration in a read-only transaction and refuses (VENDOR_AUTH_REFUSED, no request) unless the auth mode is exactly the fixed-key mode with a key present; it never refreshes on a 401, and its hop gate refuses every method but GET and every path but the two reads the connector\'s allow-list lists' },
  { klass: 'a stock list or product list believed complete because it was one response or ended on a short page', guard: 'the stock lists are read in two full sweeps and their combined populations must be identical; the product census is read in two proven scans (pages exactly the clamped limit, a short last page proven to be the end by the empty page after it, no repeated id or SKU, equal as sets) and every product the stock lists show must be in it; a missing, extra or changed row is unstable or incomplete and there is no list at all' },
  { klass: 'a derived or foreign stock figure compared as a stored one (bundles, kits, another client\'s rows, another warehouse\'s rows)', guard: 'KIT products and bundle rows are set aside on both sides and a kind mismatch is IDENTITY_CONFLICT; every row must name the warehouse asked about and the configured client; the on-hand figure is read by exact name and the available figure is never compared' },
  { klass: 'the gate believing a pack report it should not (untrusted, another installation, another phase, stale, or contradicted by its own reading of the invariant report)', guard: 'the gate reads the newest report by sequence through the chain reader (trust, digests on the same bytes, derived values), requires this installation\'s system identifier, the phase asked about and an age inside the item\'s cadence, maps inconclusive to unreadable, and requires R3, R4 and R15 to agree with its own derivation; every other state is unreadable' },
  { klass: 'a repeated JSON member read as its last value (two expiresAt on one acceptance or exclusion, two threePl on one location)', guard: 'every operator-written JSON file a decision rests on (the warning-acceptance file, as read by the pack and by the readiness gate, the SKU exclusion file and the Qoblex manifest) is parsed by lib/ops/strict-json.ts, which refuses a member named twice in any object at any depth, compared by decoded name under Unicode NFC; the file then accepts nothing (acceptances, exclusions) or is MANIFEST_INCONSISTENT. The pack\'s own hash-chained reports, its lock file and database settings are not operator files and keep JSON.parse' },
  { klass: 'a Qoblex export file taken on trust (an untrusted, swapped, truncated, partly copied or edited file; a symlink; a manifest that guesses)', guard: 'the export directory and every ancestor must be modifiable only by root or the running account, each file is opened without following a symlink, is a regular file owned by root or the running account and not writable by group or others, is read ONCE with its sha256 taken on the same bytes and must equal the digest the manifest declares; the manifest is closed (an unknown, missing or repeated key, name or location, or a version other than 1, is SOURCE_UNREADABLE)' },
  { klass: 'a partial or guessed Qoblex list (a malformed row, header or location; a repeated SKU; an unknown location read as a known one)', guard: 'the export is parsed by the first-load ingest through ONLY the repository\'s native column map (any other map, which could rename, replace, fix or skip a value, is COLUMN_MAP_NOT_NATIVE) and a rejected row and a SKU or warehouse code cell the ingest would trim or normalise (IDENTITY_NOT_CANONICAL), a malformed header, an empty file, a location the manifest does not declare, a SKU that is not valid, a quantity that is not a plain decimal or a repeated (SKU, location) not told apart by distinct lot references makes that part unreadable with no row at all; R14 also needs the stock part readable and every stocked SKU in the product list, else EXPORT_INCONSISTENT' },
  { klass: 'a stale, other-day or undated Qoblex export passing as current', guard: 'the manifest declares asOf and exportedAt; the export must be for the run\'s own cycle date, exported after that day ended, not in the future and within the weekly cadence, else QOBLEX_EXPORT_STALE (the declaration is the operator\'s, U10, and is only checked for consistency)' },
  { klass: 'the Qoblex items read without being asked, or an absent input read as a failure', guard: 'without --qoblex-export R2, R5, R7, R8 and R14 are inconclusive QOBLEX_EXPORT_OFF before any file is touched, the report builder accepts that reason only as the single reason of an item that reads nothing, and the readiness gate reads it as not available, like VENDOR_READS_OFF' },
  { klass: 'a location taken for another (a swapped warehouse, an unmapped location, a declared non-3PL warehouse that is a 3PL\'s)', guard: 'R2 and R5 establish the population from IMS (every active warehouse with no WMS binding) and require the manifest\'s non-3PL codes to equal it exactly, else NO_POPULATION_RECORD; stock in an inactive warehouse is never skipped; the identity is (SKU, warehouse code), so a swap of two warehouses\' quantities is two differences' },
  { klass: 'a valuation passing on a wrong basis (another day, an unreliable snapshot row, another currency, a missing cost)', guard: 'R5 uses the inventory snapshot of the cycle date only; no run row or a row that is not point-in-time reliable is SNAPSHOT_UNAVAILABLE; a currency other than GBP, a foreign exchange rate on a GBP row or a cost missing on stock is inconclusive; the tolerance is the catalogue\'s max(GBP 1, 0.05% of the larger total), inclusive, and a total decides, never the per-SKU list' },
  { klass: 'a SKU missing from one system hidden by a total, a union or an exclusion that is too wide, expired or untrusted', guard: 'R14 compares (SKU, system) pairs against the expectation that every SKU of the union is in every system read; an exclusion covers one SKU in one system only, must be accepted and not expired (at most 90 days), and comes from a trusted, closed-format file, otherwise the WHOLE file accepts nothing; a leg that was not read is LEG_UNAVAILABLE and the item never passes' },
  { klass: 'an IMS purchase order narrowed out of the open-order comparison (by the file, the manifest, the declared prefix, a status or a missing line)', guard: 'R7 and R8 take the IMS set from IMS: every goods purchase order the VERIFIED first load created (recorded provenance, complete against the run record, never the prefix or the export) in a committed-incoming status (the one shared definition), read whole; an order without provenance is listed out of the population; the file can only add identities (onlyVendor), an order it omits is onlyIms, and a reference the declared prefix does not explain is an IMS-only identity keyed by its own id, never dropped; a missing line, a repeated (order, SKU) on either side and received above ordered are findings or closed reasons, never summed or skipped' },
  { klass: 'a purchase order matched to the wrong Qoblex order, or by guessed formatting (case, padding, digits)', guard: 'the identity is the recorded one: the IMS reference is exactly the manifest\'s declared prefix followed by the Qoblex order number, and the order number is a plain token already in its canonical text (IDENTITY_NOT_CANONICAL otherwise); no other relation is tried, and equal figures under a swapped order or SKU are two findings' },
  { klass: 'an open-order value passing on a wider tolerance than the catalogue states, or across a currency disagreement', guard: 'R7 judges an order in GBP on both sides exactly (a second identity per such order that only an exact match to the stored precision can satisfy), any other order within GBP 1 inclusive, and an order whose currency differs between the two sides is CURRENCY_UNKNOWN; the export side converts only with the central fx_rates row at the IMS order\'s creation (none, non-positive or a disagreeing tie is CURRENCY_UNKNOWN), the pack carries no rate or currency table, and the native map\'s bytes are checked by digest' },
  { klass: 'a transit schedule that is short because the sub-ledger does not cover an order, or an account that is not the transit account\'s own', guard: 'R11 requires the recorded coverage watermark (a real date on or before the cycle date) and every open order created after it, else NO_POPULATION_RECORD; a source type it does not know or an order IMS does not hold makes the schedule unreadable; transit on the Allocated Inventory code leaves no basis, transit on any other control account\'s code is SOURCE_UNREADABLE, and a synthesised zero is GL_LEG_ABSENT; the compared schedule is the whole sub-ledger to the cycle date (open orders, non-open orders still holding transit, the refund leg), and a non-open order with a residue is also listed by identity, not judged' },
  { klass: 'an order-level discount present on one side only (IMS carries one, the Qoblex report cannot)', guard: 'an in-scope order with a non-zero order discount makes R7 inconclusive (VALUE_SHAPE_MISMATCH); a native order\'s discount is out of scope; R8 compares quantities and is unaffected' },
  { klass: 'an order dropped from the comparison because its first-load provenance is gone (a pruned activity-log row)', guard: 'the provenance must be of the VERIFIED run and the number of distinct orders it attributes must equal the orders the run record emitted (no unit failed, every attributed order still exists), else NO_POPULATION_RECORD; orders without provenance are listed, never silently dropped' },
  { klass: 'an item read at a phase it does not apply in, or a purchase-order item reading before the phase and the export are known', guard: 'R7, R8 and R11 consult the catalogue first: at P0 and P1 they are not applicable and neither the export, the database nor the basis is read; R7 and R8 without --qoblex-export are QOBLEX_EXPORT_OFF before any IMS statement' },
]
export function renderPackAuditTable(): string {
  return ['| Failure class (found in earlier reviews) | Guard |', '|---|---|', ...PACK_AUDIT_ROWS.map((r) => `| ${r.klass} | ${r.guard} |`)].join('\n')
}

export const PACK_DOC_BLOCKS: Record<PackDocBlockId, string> = {
  overview: [
    `\`${PACK_COMMAND}\` is the reconciliation pack: fifteen items (R1 to R15), each a claim that IMS agrees with a vendor or with its own ledger. It is not a second readiness gate and renders no overall verdict; the gate reads the newest report. This build runs R3, R4 and R15 end to end from the invariant report, R6, R10 and R11 from the as-of basis (the ledger items, below), R7 and R8 against the Qoblex export (below), R1 against Mintsoft, R9 and R13 against WooCommerce and R12 against WooCommerce and Xero (the vendor items, below), and reports every other item the phase applies as inconclusive with NO_RUNNER and nothing listed until its runner arrives. The liveness bracket and the as-of basis described below are wired into the command, and the readiness gate reads the newest report (see the gate section). The pack contacts NO vendor unless the run is started with \`--vendor-reads-only\`; with it, it makes GET requests to WooCommerce and Mintsoft and, for R12 only, to Xero, and the vendor items it serves are R1, R9, R12 and R13.`,
    '',
    'A run publishes `<report-dir>/<run id>/evidence.jsonl`, then `reconciliation-pack.md`, then `reconciliation-pack.json` last, each created exclusively and never through a symlink, fsynced and renamed into place under an exclusive 0700 directory. The JSON is the commit record: it names the Markdown by sha256 (`companionMarkdownSha256`) and the evidence by sha256 and line count, carries a `sequence` and the sha256 of the previous report\'s JSON (`previousReportSha256`), and counts that the reader recomputes from the evidence. Every identity is one line of the evidence, equal ones included: the reader recomputes every count and the digest of the equal identities from those lines, and re-judges each line against the item\'s catalogue row (which sides had the identity, recorded as explicit presence flags; the value shape the item\'s mode demands; the true difference of the two values; the tolerance verdict; and, for a minor-unit item, the currencies). The bucket of every pair entry is DERIVED from those fields in the builder and again in the reader (both sides present is equal or differing, one side is onlyIms or onlyVendor, neither is invalid) and a label that disagrees is refused. Nothing the caller owns is serialised: the input is copied field by field into plain objects (an unknown field, an accessor, a symbol key, a Proxy, a class instance or a hole is refused), and the finished report is read back by the reader\'s own validation before the first byte is written. Problem text is closed reason codes and counts only; identities appear only as sanitised tokens (a cuid, a numeric vendor id, a validated SKU or `sku#` and eight hex digits, a warehouse code).',
  ].join('\n'),
  usage: [
    `\`${PACK_COMMAND} -- --phase <P0|P1|P2> [--as-of <YYYY-MM-DD>] [--items <R3,R4,...>] [--acceptances <file>] [--report-dir <dir>] [--basis-only] [--vendor-reads-only]\``,
    '',
    renderPackFlagTable(),
    '',
    'The command is started as root or as the account that owns the checkout; any other account is refused. `DATABASE_URL` must be in the environment: the command does not read `.env` files, replaces its whole environment with a short whitelist (PATH, HOME, LANG, LC_ALL, TZ and DATABASE_URL) before the application\'s database client is loaded, and refuses an argument that looks like it carries a credential. It makes no call to Xero or Qoblex, and none to WooCommerce or Mintsoft unless `--vendor-reads-only` is given (then only the GET requests described in the vendor items section); it writes nothing to the database and writes only its report. With `--vendor-reads-only` the environment whitelist also keeps `SETTINGS_ENCRYPTION_KEY` and `ENCRYPTION_KEY`, which decrypt the stored storefront and Mintsoft credentials; without it the command never reads a vendor credential and does not keep the key. The invariant report behind R3, R4 and R15 runs in the same process with no-op activity-log and notification writers, in ONE transaction opened `REPEATABLE READ` and set `READ ONLY`, with the application\'s database client bound to that transaction, so its three reports and every page of them read one database state and any write is refused by the server. The run records its proof (the isolation level, the read-only flag and `pg_current_snapshot()`, read at its start and its end and required to agree, and that the application\'s client was the transaction), and R3, R4 and R15 are inconclusive without it.',
    '',
    'The read-sync status report behind the liveness bracket is read by a CHILD PROCESS (`npm run --silent read-sync:status -- --json`, the command the readiness gate runs, with the same short environment whitelist) at the start of the run and again at its end, and the as-of basis is read through a database client of its own, one per transaction. Neither uses the application\'s client: the invariant run binds that client to its one snapshot and needs to be the first to load it, so a test loads the command and every pack module in a fresh process and fails if the client exists afterwards. The child\'s exit code is not the verdict (it is non-zero whenever a stream is stale, and the report says so in its own fields): only a report that parses and checks out against itself is a read, and a child that timed out, was killed or printed anything else is a failed read, so every item is inconclusive.',
    '',
    'R3 and R4 name each stock level the invariant report flags (the product and warehouse ids) with the two quantities that disagree; with no flagged level they pass on the named proof that the report ran to the end and lists nothing. R15 names each critical finding and each warning by a digest of the gate\'s warning id (`finding-` and 20 hex digits; the id itself carries product, order and sync-log ids and is never printed), with 1 for the finding and, as the number the claim allows, 0 for a critical finding or a warning with no current written acceptance, and 1 for a warning the acceptance file covers. Findings that share one id (the id carries no severity) are one entry, and it takes the strictest number any of them allows, so an accepted warning never hides a critical finding with the same id. A report that did not run to the end (a run that was not completed or listed errors, a missing domain, a truncated list, an inventory cursor that is not null or any cursor on the accounting or sales report, a finding that says its scan stopped at a row cap, any count of a report or of the run\'s own summary (total, info, warning or critical, per domain and overall) that differs from the findings listed, a critical-findings list, an `ok` flag or a preflight `failure` value that disagrees with them, a severity the module does not know, a subject id that is present but not a non-empty string, a critical-findings list that is not exactly the reports\' critical findings identity by identity, a stock-claim code under the accounting or sales report, a run without the one-snapshot proof) is inconclusive, never a pass, and so is a flagged level that the pack\'s own comparison would call equal. The stock-movement branch of the report is read over all history here, not over the 90-day window the scheduled check uses, so R15 is not a windowed claim. R3, R4 and R15 all validate the whole run (all three domains and the run summary) before reading a finding.',
  ].join('\n'),
  'cli-codes': ['When the command stops without a report it prints one of these codes and nothing else about the cause.', '', renderPackCliCodeTable()].join('\n'),
  readers: 'The IMS side of every comparison is read by lib/reconciliation-pack/ims-readers.ts in ONE transaction opened `REPEATABLE READ, READ ONLY` with a statement timeout. The transaction proves what it asked for: `transaction_read_only` and `transaction_isolation` are read back, the snapshot is read at the start and at the end and must be equal (else BASIS_MOVED), the only statements sent are SELECTs and three fixed SET LOCALs, and it is always rolled back. Sections: the cluster identity, the population boundaries, stock levels (stock-tracked product types; the others are returned in a separate list, excluded and never compared), products, open sales orders (PENDING_PAYMENT, ON_HOLD, PROCESSING, ALLOCATED, PICKING, PACKING) with their storefront links and external dates, the importer\'s admitted storefront order statuses and the storefront connector\'s status mapping rows, tax rates and mappings, the stored copy of Xero\'s tax-rate list for the connected organisation with its header (count and digest, which prove it is one complete read), connector-confirmed Xero sync rows (SYNCED, a document id, no operator assertion), the stored inventory and balance snapshots of the cycle date (rows without a run row, or a different number of rows than the run row counts, are READ_INCOMPLETE), the warehouse bindings with their stock-sync mode and whether alignment is confirmed, and the Xero postings of R10 (the first-load record, and every sync-log row of the Xero connector that could be a write: SYNCED, PROCESSING, or carrying a document id, of any type, with its own status and instant). Every section is read in full: a section over its row cap is CAP_EXCEEDED, a statement timeout is READ_INCOMPLETE, and a row that cannot be read exactly (no id, a value that is not a plain decimal, an unknown enum, a duplicate identity) makes its whole section unreadable; nothing is dropped, defaulted or shortened.',
  population: [
    'The population an item compares is bounded by RECORDED identities, never by a guess: the first-load run record (only a VERIFIED run counts), the storefront initial-import completion setting (only the text `true` counts) and the sales-order retention setting (absent means keep everything). An identity created before a recorded boundary is listed as out of population with one of these reasons, and is never a finding; an identity whose boundary has no record, or that has no creation instant, is unknown and makes its item inconclusive. An instant equal to a boundary is inside. A recorded instant bounds a population here and nowhere else: two runs are never ordered by a timestamp.',
    '',
    renderPackPopulationTable(),
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
    'A token is printed as it is only if it matches the allowed-character pattern for its kind (a SKU: letters, digits, dot, slash, underscore and hyphen, starting with a letter or digit, at most 64 characters; a warehouse code: upper-case letters, digits, underscore and hyphen, at most 32; a purchase-order number or reference, which follows the SKU pattern; a cuid; a numeric vendor id of at most 18 digits) AND passes the credential screen. Otherwise it is printed as its kind, a hash sign and the first 8 hex digits of its sha256 (for example sku#3aaf0386). The screen digests a token that contains, in any case, one of key, secret, token, passw, pwd, bearer, auth, cred, private, cookie, session, signature, jwt, sk_, pk_, ghp_, gho_, ghs_, xox, akia or asia; or a run of 24 or more letters, digits, plus, slash or equals with no separator; or that starts with eyJ or http; or that is longer than 64 characters. The same screen is applied again to every token read back from a file.',
    '',
    'What this does not cover (the residual): a credential that avoids every listed word, has no 24-character unbroken run and is built from allowed characters would still print; an 8-hex-digit digest of a LOW-entropy secret (a short password) could be guessed offline; a legitimate SKU that contains a listed word (MONKEY-WRENCH, AUTHOR-GUIDE) prints as a digest and is harder to read; cuid and numeric-id parts are not screened; and evidence.jsonl lists every identity, so it is as sensitive as the stock list itself and is written 0600 in a 0700 directory. Free-form fields do not exist: every other field that can reach output has the anchored allowlist grammar in this table.',
    '',
    renderPackPublishedFieldTable(),
  ].join('\n'),
  inputs: ['The comparator never reads an unreadable input as equal, and never fills a gap with a default. Each of these shapes is inconclusive with the code shown; none reaches a bucket or a pass. A difference of zero is the only thing that is equal, and minus zero is read as zero. The comparison mode (values or presence) is fixed per item in the catalogue, and a currency outside the known list has no default number of decimals.', '', renderPackInputShapeTable()].join('\n'),
  reasons: ['Every reason a report can give is one of these codes; no other text describes a problem.', '', renderPackReasonTable()].join('\n'),
  refusals: ['A run is refused, and the trend reader refuses a directory, with exactly one of these codes.', '', renderPackChainCodeTable()].join('\n'),
  items: ['The catalogue. Tolerances are chosen defaults (owner decisions D1 and D2); an exact quantity comparison allows 0.0001.', '', renderPackItemTable()].join('\n'),
  settling: `A difference is not a failure the first time it is seen: a vendor can lag, and an order created moments before the read is on one side only. Only an item whose catalogue row says it settles does this (today R9, whose dependent stream is woocommerce-order-sweep, and R1, whose dependent stream is mintsoft-stock-sync, because stock moves between the IMS read and the Mintsoft read exactly as an order is created between two reads); every other item still fails on the run that sees a difference. A keyed difference (an identity on one side only, or a value beyond the tolerance) is carried as unsettled with the last-success stamp of the stream it was read under. It becomes a failure only when it is still there after ${PENDING_PERSISTENCE_RUNS} LATER successful runs of that stream, observed as ${PENDING_PERSISTENCE_RUNS} further DISTINCT last-success values. The stamps are compared for equality only, never for order: a repeated stamp is the same run and makes no progress, and a stamp that merely looks older than the one before still counts as a distinct run. A difference that disappears is dropped (it is no longer listed, and if it returns it starts again). While anything is unsettled the item is inconclusive (UNSETTLED_PENDING), never a pass. The stream stamp is also read at the start and end of an item\'s read; if it differs the read is BASIS_MOVED and that run counts for nothing. The same item's result is also never a pass when the stream is stale or off. IDENTITY: a difference is the identity token plus its kind (on the IMS side only, on the vendor side only, or a value that differs) plus the values and currencies it was seen with; a value that changes between runs is a NEW difference, first seen now, not a continuation. CARRIED STATE comes only from the newest report of the trusted chain (the same trust rules the readiness gate uses): each unsettled entry, and each failing entry of an item that settles, records the report sequence it was first seen in, the stamp it was first seen under, the later distinct stamps counted so far and their count. It is used only if that report is for the same installation (system identifier) and phase, its item was compared to the end (a pass, a fail, or unsettled-pending), its listing was not capped, its stream bracket was stable, and the entries add up to the item\'s own counts. Otherwise there is NO carried state: every current difference is first seen, the item carries SETTLING_STATE_UNUSABLE beside UNSETTLED_PENDING, and it cannot mature into a failure until a usable report precedes the run; it is never a pass and never taken as settled. The state is not looked for further back than the newest report, so a run that did not compare the item (not selected, vendor reads off, a stale or moved stream) starts the count again; that delays a failure and never brings one forward. An unreadable, untrusted or forked chain refuses the run before anything is compared. Carried identities are judged first and listed first within each bucket, so a cap on the listing cuts an identity first seen now before one already settling. The readiness gate reads UNSETTLED_PENDING (and SETTLING_STATE_UNUSABLE) as unreadable, never as a pass.`,  liveness: [
    'Before and after its reads the pack reads the read-sync status report (the same report `npm run read-sync:status` prints) and compares the two reads. Each item names, in the catalogue above, the streams it depends on. An item cannot pass unless every entry of every such stream (one per binding for the Mintsoft stock sync) was `fresh` at BOTH reads, with a last-success stamp, and the stamp is EQUAL at both reads. Stamps are compared for equality only, never for order or age; "fresh" is the status report\'s own judgement against the stream\'s limit.',
    '',
    'An item is also withheld when the scheduler could not be examined, the crontab could not be read or the managed block cannot be trusted, at either read (this applies to EVERY item, including those with no dependent stream, such as R2 to R4), or when a job the item\'s streams depend on is unscheduled or switched off. A stream with no entry, two entries for one instance, or an entry that appears in only one read is not fresh. If either read of the status report fails, is not the shape the report defines, or contradicts itself (an entry marked `fresh` that is older than its own limit, dated in the future or without a stamp; a `stale` one that is young; an age that is not the distance from the report\'s clock to the stamp; counts that are not the tally of the entries; a scheduler that was not examined yet names a problem), EVERY item is inconclusive, including items with no dependent stream: liveness that could not be read is never taken as healthy. The command makes the two reads by running the status command as a child process (see usage). The item keeps its numbers; its outcome is inconclusive with STALE_BASIS (not fresh, or the scheduler), BASIS_MOVED (fresh, but a stamp or an instance moved between the reads) or SOURCE_UNREADABLE (a read failed). The published stream bracket of a stream that is not clean has no end stamp, so the report writer and reader refuse a pass on it.',
  ].join('\n'),
  basis: [
    'The as-of basis is the stored evidence a ledger item (R6, R10, R11) compares on. It is read for one cycle date D (default: yesterday, UTC) and reads stored snapshots only: it makes no vendor call and writes nothing. It is AVAILABLE only when ALL of the following hold, and otherwise it names the first reason that fails, from the table below.',
    '',
    '- the Xero plugin is on and each of the five accounts has a configured code: Inventory, Allocated Inventory, Stock in Transit, Cost of Goods Sold and Unearned Revenue;',
    '- for each of the five accounts there is exactly one stored trial-balance balance, fetched under the Xero organisation connected now (a balance with another or no recorded organisation is never used), whose balance date is EXACTLY D, in the base currency. The latest balance on or before D is never used, and neither is a later one: a balance for another date is `not_for_date`;',
    '- every one of those balances says where it came from: a row Xero reported, or `absent-from-tb`, the zero the pull records for a configured account that a non-empty trial balance omitted. An absent-from-tb zero is carried with that label and is never an explicit zero; a balance with neither label (stored by an older build) makes the basis unavailable until the date is pulled again;',
    '- an inventory snapshot run row exists for D, every inventory snapshot row for D is point-in-time reliable, and the rows are exactly as many as the run row recorded. A run row with no rows is a true zero stock position, and is the named empty-population proof;',
    '- the Xero balance-snapshot stream was fresh and unmoved at both liveness reads.',
    '',
    'Every IMS read of the basis is made in ONE read-only REPEATABLE READ transaction with a statement timeout, so the settings, the ledger balances and the snapshots are one consistent view; the transaction\'s mode is read back and a basis is not built if it is not what was asked for. The inventory subledger is compared with Inventory plus Allocated Inventory by the existing pure evaluator, unchanged. The pull that stores the balances now includes Unearned Revenue, taken from the same trial-balance response as the other four (no extra call); Unearned Revenue is a credit-balance liability, so its stored amount (debit minus credit) is normally negative.',
    '',
    'The Stock in Transit leg (R10 only) is separate and never makes the basis unavailable. Transit is a clearing account whose sub-ledger has no opening balance, so only a MOVEMENT is comparable (the existing transit evaluator says why): the movement of the stored transit balance between the day before D and D, against the transit sub-ledger movement with a journal date after the day before D and up to D. The balance for the day before D must meet every rule of the five above (exactly one stored row, for exactly that day, the connected organisation, the base currency, a finite number, a provenance label), the sub-ledger must be recorded as covering that day (the `transit_ledger_coverage_start_date` setting, a plain date on or before the day before D), and a balance that is the zero the pull records for an account the trial balance omitted is never a reported zero at either end of the window. The leg\'s rows are part of what the settle step compares, so a change to any of them while the run was reading is `basis_moved`.',
    '',
    renderPackBasisReasonTable(),
    '',
    renderPackTransitLegTable(),
  ].join('\n'),
  ledger: [
    'R6, R10 and R11 compare IMS with the Xero ledger for one cycle date D, from the SETTLED as-of basis alone: they read no live balance, make no vendor call and run only after the liveness bracket is closed. A basis that is not available is the item\'s inconclusive result with the basis\'s own reason (STALE_BASIS, BASIS_MOVED or SOURCE_UNREADABLE); a basis for another date is never used; and a base currency other than GBP is CURRENCY_UNKNOWN, because the tolerances are stated in GBP. A difference needs no settling: both sides are stored for D.',
    '',
    '**R6.** The IMS inventory sub-ledger as of D against Xero Inventory plus Allocated Inventory, within GBP 1 inclusive (owner decision D1), as one identity, `ledger-inventory-allocated`. The existing evaluator (`evaluateAccountGlReconciliation`) is used unchanged and the pack\'s own comparison must agree with its verdict; if the two disagree the item is inconclusive and nothing passes. At P1 the strict figure is recorded and the P1 pass rule is R5 (owner decision D2); strict at P2. If either Xero balance is the zero the pull records for an account the trial balance omitted, the comparison is withheld, not made against a zero: GL_LEG_ABSENT.',
    '',
    '**R10.** Phase P1 only (IMS posts to Xero by design at P2, so the claim below cannot be made there; at P2 the item reports NO_RUNNER, and at P0 it is not applicable). (a) the same inventory comparison as R6, and the Stock in Transit movement of the cycle day against the transit sub-ledger movement (the transit leg of the basis), each within GBP 1 inclusive, as the identities `ledger-inventory-allocated` and `ledger-transit-movement`; (b) ZERO IMS-originated writes to Xero since the first load began (owner decision D5, measured on the IMS side: COGS and Unearned Revenue have no other test at P1). Each sync-log row of the Xero connector that could be a write (SYNCED, PROCESSING, or carrying a document id; any type; an operator-asserted row and a failed row with a document id included) is an identity on the IMS side only, named by its id; one is a finding, so the item FAILS and lists each. The population is bounded by the RECORDED first-load run (only a VERIFIED run counts, and the instant is when the load STARTED); a row\'s instant is the latest of its sync time, processing start and creation time: a row older than that is listed as out of the population and is never a finding; a row at exactly that instant is inside; a row whose instant cannot be read, or a first load that is not recorded and verified, is NO_POPULATION_RECORD (never a pass, even when nothing was sent). The postings are read at run time, not as of D: a write made after D is still a write since the first load. The postings are read in full or CAP_EXCEEDED.',
    '',
    '**R11.** Phase P2 only (at P0 and P1 it is not applicable and nothing is read). The stored Stock in Transit balance of Xero for the cycle date against the OPEN-PURCHASE-ORDER TRANSIT SCHEDULE of IMS, within GBP 1 inclusive (owner decision D1), as the identity `ledger-transit-balance`; the existing evaluator must agree with the pack\'s own comparison, and because it rounds to the penny a gap in the sub-penny sliver just above GBP 1.00 is inconclusive (SOURCE_UNREADABLE), never a pass. **The schedule** is IMS\'s WHOLE transit sub-ledger up to the cycle date (`transit_subledger_movements`, one signed base-currency row for every posting to the Stock in Transit account; owner ruling 2026-10-24: the balance holds all of it, so the comparison must): the sum of every row, which is the value in transit of each purchase order (open or not) plus the refund-in-transit leg. The source types are the nine the posting code records (PURCHASE_BILL, PURCHASE_BILL_UPDATE, SUPPLIER_CREDIT_NOTE, STOCK_RECEIPT, LANDED_COST_RECLASS, LANDED_COST_CONSUMED_OFFSET, PURCHASE_ORDER_CANCEL, SUPPLIER_RETURN, CUSTOMER_RETURN_IN_TRANSIT: `lib/domain/accounting/transit-subledger-movement.ts` and its callers); one it does not know is unreadable. A row belongs to an order by its recorded source: the order id for a bill, bill update, receipt, cancellation and landed-cost leg, the order of the return for a supplier return, and the order of the credit note for a supplier credit note; the refund-in-transit leg belongs to no order. **Completeness:** the sub-ledger records postings only after its recorded coverage watermark (`transit_ledger_coverage_start_date`) and has no opening balance, so the schedule is proven complete only if the watermark is recorded, a real date on or before D, and EVERY open order was created after it; otherwise NO_POPULATION_RECORD, never a short schedule. A row of a source type the pack does not know, or one naming an order IMS does not hold, makes the schedule unreadable. **The named residue list:** the purchase orders that are NOT open (not in a committed-incoming status) but still hold a non-zero transit balance are LISTED by identity with that residue under outOfPopulation (reported, never judged, so the list does not change the outcome by itself); their value is IN the total, as is the refund-in-transit leg (which is not listed). **The accounts:** the transit account must be its own. Transit configured on the Allocated Inventory code leaves no basis at all (inventory_accounts_shared), and transit on the COGS or Unearned Revenue code is SOURCE_UNREADABLE; nothing is compared. A transit balance that is the zero the pull synthesised for an account the trial balance omitted is GL_LEG_ABSENT, never a zero compared with an empty schedule.',
    '',
    'Any leg that cannot be read withholds the whole of R10, naming every cause once: GL_LEG_ABSENT (an account the trial balance omitted, at either end of the transit window), NO_POPULATION_RECORD (the sub-ledger coverage is not recorded, or the first load is not), SOURCE_UNREADABLE (any other basis or read problem). The report builder judges the result again, and a result it refuses is INTERNAL_ERROR.',
  ].join('\n'),
  vendor: [
    'R1, R9, R12 and R13 are the items that read a vendor (R1 Mintsoft; R9 and R13 WooCommerce; R12 WooCommerce and Xero). They are read only when the run is started with `--vendor-reads-only`; without it each is inconclusive with VENDOR_READS_OFF as its only reason, NO vendor credential is read, NO request is made and nothing is listed. The readiness gate reads that single reason as not available (the state the slot had before the pack could read vendors), so a run without the flag is never a pass and never a block that was not already there. The flag never enables a write: the transport has no method parameter, and the connector fetch seam is given a gate that refuses, before anything is sent, every request that is not a GET to `/wp-json/wc/v3/orders`, `/products` or `/taxes` on the store\'s own origin with only the parameters status, page, per_page, orderby, order, _fields, after and before, and refuses a redirect without requesting its target. The Mintsoft transport is given the same kind of gate: it refuses, before anything is sent, every request that is not a GET to exactly `/api/Product/StockLevels?WarehouseId=<n>` or `/api/Product/List?PageNo=<n>&Limit=<n up to 100>` on the connection\'s own origin and that the connector\'s read allow-list (MINTSOFT_READ_ALLOWLIST) does not list as a read, and refuses a redirect without requesting its target (Mintsoft mutates through GET). The Mintsoft key is the stored FIXED API key and nothing else: before any request the pack reads `mintsoft_auth_mode`, which must be exactly `api_key` (absent means the default, `credentials`, which logs in), the key `mintsoft_static_api_key`, `mintsoft_client_id` (a positive whole number; every row read must carry it) and the one Mintsoft connection\'s address, in a read-only transaction; anything else is VENDOR_AUTH_REFUSED or SOURCE_UNREADABLE and NO request is made. `POST /api/Auth` mints a new tenant key and would knock the order sweep and the label service offline; the pack has no code path that can reach it, and a 401 is reported, never refreshed. The environment fallbacks of the application (MINTSOFT_AUTH_MODE, MINTSOFT_STATIC_API_KEY) are not read, because the pack\'s environment is a short whitelist: an installation configured through the environment alone is refused, never guessed. R12\'s Xero transport is the same kind of thing: a gate that refuses everything but a GET to `https://api.xero.com/api.xro/2.0/Organisation` (no parameter) or `/Invoices` (exactly the parameters where, Statuses and page, the `where` of one fixed shape), and a refused redirect. The storefront credentials are three settings rows read on the first request in a read-only transaction; nothing a response says, no URL and no message reaches output, and identities are the sanitised tokens of the tokens section.',
    '',
    '**How a walk proves a list.** Orders are walked one status at a time (never one request for all: a multi-status request is unverified on the live store, U4), as a DOUBLE SWEEP: sweep A walks every admitted open status in order, and sweep B walks them all again, starting only after A finished. Products and tax rates are walked in full, each twice. A list is used only if every response is HTTP 200 with a JSON array and carries X-WP-Total and X-WP-TotalPages as plain whole numbers; the total is within the cap of the walk (CAP_EXCEEDED otherwise) and the page count is exactly the total over the page size, rounded up; every page reports the same total and page count; each page but the last is full and the last holds the remainder; rows arrive in strictly ascending id order, none twice; the rows read are as many as the total reported; every field is validated (an order in another status than the one asked for, a currency outside the known list, a total that is not a plain decimal is SOURCE_UNREADABLE); and the whole walk (for orders, the whole sweep) is then read a second time and must equal the first row for row. For orders the comparison is of the COMBINED population of the two sweeps: every order id with its status, currency, total and date, and every status total, must be identical, and an order in one sweep only is VENDOR_READ_UNSTABLE. A per-status double read would miss an order that moves from a later open status to an earlier one between two status walks. The empty proof needs a total of zero for every status in BOTH sweeps. NOT PROVEN: an order that moves between open statuses twice within one run (out and back) could be missed by both sweeps. A missing or malformed header, a non-200 answer, a malformed body, a transport error and an exhausted request budget are SOURCE_UNREADABLE or CAP_EXCEEDED; a repeated row, a short page, a changed total or a second read that differs is VENDOR_READ_UNSTABLE. In every such case there is no list at all, never a partial one. Requests are sequential, at most four a second, and at most 400 in a run. NOT PROVEN (U4, open): that the store\'s per-status totals equal what wp-admin shows; a store that does not honour the headers is unreadable. Variations of variable products are a separate collection and are not walked.',
    '',
    '**How the Mintsoft reads prove a list.** The stock list of a warehouse (`GET /api/Product/StockLevels?WarehouseId=<n>`) ignores paging and carries no total, so one request per warehouse is the whole list and its completeness is claimed by AGREEMENT: every in-population warehouse is read once (sweep A) and then every warehouse is read again (sweep B, starting only after A finished), and the COMBINED populations of the two sweeps (warehouse, SKU, Mintsoft product id, on-hand figure and bundle flag of every row) must be identical, else VENDOR_READ_UNSTABLE and no list. Each response is read by the connector\'s strict stock reader (exact field names; the on-hand figure is `TotalStockLevel`, owner decision U1, and `Level` is the available figure and is never compared; a body that is not an array, a row with no SKU or no on-hand figure, a figure that is not a non-negative whole number, an available figure above on-hand, or a SKU twice in one response makes the whole response unreadable) and every row must also name the warehouse asked about, the configured Mintsoft client and a boolean bundle flag, with a positive whole product id that no other row repeats. One SKU under two product ids, one id under two SKUs, or one id flagged a bundle in one warehouse and plain in another, across the warehouses is IDENTITY_CONFLICT. The PRODUCT CENSUS (`GET /api/Product/List`) pages from 1 at a limit that is CLAMPED to 100 and never configured (Mintsoft answers 400 at 101), gives no total and no ordering, and is proven by: every page before the last holding exactly the limit and none more; the last page SHORT (an empty one included) and the page AFTER it requested and required to be empty (a short page is a claim, and a truncation that repeats looks exactly like an end until the next page is asked for); no id and no SKU twice in a scan; the scan read a second time, after the stock sweeps, and equal as a set of (id, SKU) pairs (no ordering is assumed); and finally CONTAINMENT, independent of how Mintsoft pages: every product any stock list shows must be in the census under the same SKU (absent is READ_INCOMPLETE, another SKU is IDENTITY_CONFLICT). The census is how a SKU Mintsoft does not have is told from one its stock list omitted. NOT PROVEN, stated: that the pages are a window over one stable permutation of the whole set and not a keyset walk that skips the same row every time; containment covers every product that has a stock row, so only a product with no stock row anywhere that the paging also skips could be missed. The live product-list row shape was read on 2026-10-23 (ID, SKU, ClientId, Bundle, DisCont and others): the pack reads one of ID, Id or id, SKU, a boolean Bundle (required) and ClientId when present; a row it cannot read makes the census, and so the item, unreadable, never a smaller list. The bundle flag is part of a product\'s identity: it must be the same in every warehouse\'s stock list and in the census, else IDENTITY_CONFLICT. DisCont (discontinued) is read by nothing: a discontinued product is still compared (509 of the 2386 live rows are DisCont, and they still have stock rows), which is stated here rather than decided. Requests are sequential, at most about three a second, and at most 500 in a run; the budget being exhausted is CAP_EXCEEDED.',
    '',
    '**R1.** Mintsoft stock against IMS, per (warehouse, SKU), EXACT (the catalogue\'s 0.0001; an IMS quantity that is not a whole number cannot equal Mintsoft\'s whole number and makes the item BAD_VALUE rather than being absorbed by the tolerance). IMS side: `stock_levels.quantity`, which is ON HAND (reservations are `reservedQty`, apart), read with the product links, the products and the warehouse bindings in ONE REPEATABLE READ snapshot; a product with no stock row in a warehouse holds 0 there, as the sync reads it. Mintsoft side: `TotalStockLevel`. POPULATION (assertion F5, made in the same snapshot as the stock): a binding of Mintsoft is in the population only when it is active, its stock sync is not DISABLED and its alignment is UNCONFIRMED (NOTIFICATION_ONLY always, ALIGN_TO_WMS while it has no confirmation stamp); an inactive or DISABLED binding (BINDING_NOT_ACTIVE) and a confirmed alignment (ALIGNMENT_CONFIRMED, where the sync keeps IMS equal by construction) are out, their IMS stock listed under the out-of-population bucket and never compared; a warehouse with no Mintsoft binding is not part of the claim and is not listed; a binding whose stored mode or flags cannot be read exactly makes the whole item SOURCE_UNREADABLE; the bindings are read again in a second snapshot after the Mintsoft reads and must be unchanged (BASIS_MOVED), so a warehouse confirmed or re-pointed while Mintsoft was being read is not judged. PRODUCTS are matched by SKU, the identity the stock sync itself uses. An IMS product of type SIMPLE, VARIANT or BOM is compared; it is in the population when it is LINKED to Mintsoft (a product link row) or, unlinked, when the census lists its SKU (so a missing link cannot hide stock Mintsoft holds); an unlinked product the census does not list is out (NO_WMS_LINK), listed with its IMS figure and never compared. A KIT is out (KIT_DERIVED_STOCK) and so is a Mintsoft row flagged as a bundle: the stock is derived from components on both sides; a KIT that Mintsoft lists as a plain product, or a plain IMS product it lists as a bundle, is IDENTITY_CONFLICT for the whole item. NON_INVENTORY and VARIABLE products are not stock-tracked and take no part. A linked product\'s recorded Mintsoft product id must be the id the stock row and the census hold for that SKU, else IDENTITY_CONFLICT (a swap is never read as two quantities). A Mintsoft row with no comparable IMS counterpart is onlyVendor when its on-hand figure is positive and out (WMS_ZERO_NO_IMS_PRODUCT) when it is zero. A product IMS links that Mintsoft does not list at all (no stock row, not in the census) is onlyIms; a product the census lists but whose warehouse stock list has no row for it cannot be told from a zero and is READ_INCOMPLETE for the whole item, never a zero. R1 SETTLES (owner decision D7): stock moves between the IMS snapshot and the Mintsoft read exactly as an order is created between two reads, so a difference first seen is UNSETTLED (inconclusive UNSETTLED_PENDING) and fails only when it is still there after two LATER successful runs of mintsoft-stock-sync. Nothing is compared as empty without proof: the proof `alignment-confirmed` (every binding of Mintsoft, inactive and DISABLED ones included, is a confirmed alignment and at least one exists: the claim is retired by construction, Mintsoft is not asked, and the pass names only the IMS source) or `vendor-total-zero` (every stock list and the census empty in both reads); no Mintsoft binding at all, or only inactive or disabled ones, is NO_POPULATION_RECORD, and a confirmed binding beside an unconfirmed one that is inactive or disabled (so not compared) is BINDING_UNCONFIRMED_NOT_COMPARED. Mintsoft being configured to log in (anything but the fixed-key mode) is VENDOR_AUTH_REFUSED with no request made.',
    '',
    '**R9.** Open sales orders against WooCommerce, by WooCommerce order id. IMS side: every sales order in PENDING_PAYMENT, ON_HOLD, PROCESSING, ALLOCATED, PICKING or PACKING that has a recorded WooCommerce order id; an open order without one is listed as out of the population (NO_STOREFRONT_LINK) and never compared. Vendor side: the statuses the importer admits, by every route that admits by status (the `wc_sync_order_statuses` selection; absent means its default, processing; a value that is not a list of non-empty strings is unreadable, not defaulted; plus, whenever the selection is not empty, the two customer-withdrawal statuses from the `wc_withdrawal_submitted_status` and `wc_withdrawal_approved_status` settings (a default when absent or empty, unreadable when not a status), `completed` (the reconcile sweeps) and `delivered` (the manual historical import); an empty selection admits nothing on the sweeps, the webhook or the initial import), each walked if its effective reading is an open IMS status, the withdrawal-submitted status always (an IMS hold must find its storefront order), read through the status mapping rows and then the connector\'s built-in table (pending and failed are PENDING_PAYMENT, on-hold is ON_HOLD, processing and refunded are PROCESSING). The mapping rule is the importer\'s own (the connector\'s status lookup): a row matches a status only if its key equals the status or `wc-` and the status, ignoring case and with no trimming, and the row equal to the status itself wins. A SELECTED status with no reading at all, or any admitted status whose matching rows disagree, is UNKNOWN_STATUS (a route-added status with no reading is closed, as the importer closes it); a store order in a withdrawal-submitted status that IMS lacks is reported even though the importer skips an unlinked withdrawal on purpose; a stored row whose key only normalises to an admitted status (padded, or an odd prefix), which the importer would never match, is AMBIGUOUS_STATUS_MAPPING; either makes the whole item inconclusive and no request is made. The set must be exact; the value is the order total in the order\'s own currency, and it must agree within one minor unit of that currency (owner decision D1: 0.01 for GBP, 1 for JPY); a different currency is a difference. Every identity is judged and NO order is set aside by its age. The importer admits an order by its CURRENT status alone, whatever its age: the initial import asks the store for the selected statuses with no date bound (initial-import.ts:270-276), the ongoing sweep asks for the selected statuses modified after a cursor (order-import.ts:3160-3166), and a webhook admits on the current status (order-status-filter.ts:166). So an order created before the initial import that entered an open status later is one IMS should hold, and one it lacks is a finding. Retention archives only terminal orders (data-retention.ts:689-706), so it never removes an open order. The pack does not compare a storefront timestamp with an IMS one to exclude an order (cross-system clock ordering); R9 reads no population boundary and cannot be NO_POPULATION_RECORD. The only identities set aside are open IMS orders with no storefront order id, listed. Nothing is compared as empty without proof: both sides empty passes only on the named proof per-status-total-zero (every enumerated status reported a total of zero in both sweeps, and at least one status was enumerated). R9 SETTLES (owner decision D7, the settling section): a difference is first UNSETTLED (the item is inconclusive, UNSETTLED_PENDING) and fails only when it is still there after two later successful runs of the order sweep stream, so a storefront order created moments before the read does not fail the item; the next report carries the state.',
    '',
    '**R13.** Tax-rate mappings, by presence. WooCommerce leg: every tax rate the store has (the full list, walked twice) must have an IMS mapping of the storefront connector, and every such mapping must name a rate the store still has; a rate with no mapping, or a mapping with no rate, is a finding. Xero leg: only the types IMS uses. Every Xero tax type that IMS names (the accounting tax type of an active IMS tax rate, of an active component of an active rate, and the two reverse-charge tax-type settings) must resolve to an ACTIVE type in the stored Xero list; a named type that is missing from the list, or present but not ACTIVE (deleted, archived or pending), is a finding that lists the type code. An ACTIVE Xero type that nothing in IMS names is not a finding: it is listed as out of the population with the reason NOT_REFERENCED_BY_IMS. The Xero list is IMS\'s stored copy of it (Xero is the tax-rate master): the xero-tax-rate-drift sweep reads every Xero tax rate and replaces, in one transaction, the connected organisation\'s list, its header row (read time, row count, digest of the rows) and the read-sync last-success stamp, and refuses a response that is empty, partial or malformed, keeping the previous list. The pack reads that list in the same REPEATABLE READ snapshot as the IMS rates, for the organisation connected NOW, and makes no request to Xero. The list is proven only if the header row exists for that organisation, its count equals the rows read, every row carries the header\'s read time, every row re-validates and the digest recomputed from the rows equals the header\'s; otherwise the Xero leg is VENDOR_LIST_UNPROVEN. A WooCommerce leg with a finding is still a fail (DIFFERENCES, with VENDOR_LIST_UNPROVEN beside it when the Xero leg is unproven), and a clean WooCommerce leg with an unproven Xero leg is inconclusive, never a pass; with both legs proven, the item names the Xero source as well and can pass. A stale xero-tax-rates stream is STALE_BASIS before anything is read.',
    '',
    `**R12.** VAT per (country, reporting category, period) across IMS, Xero and WooCommerce; set exact, each value within GBP ${VAT_TOLERANCE_GBP} inclusive (owner decision D1); it does not settle (owner decision D7 applies to R9 only). **Period:** one calendar month, UTC. The window is the latest ${R12_WINDOW_MONTHS} CLOSED months for the cycle date: a month is closed once the cycle date is the ${R12_CLOSE_LAG_DAYS + 1}th of the following month or later (a lag after the month ended, so late postings and status changes have settled), so an unclosed month is never read. A month that began before the recorded VERIFIED first load, before the recorded storefront import or beyond the sales retention horizon is outside the population; an unrecorded boundary is NO_POPULATION_RECORD, and no month left is EMPTY_UNPROVEN. The cycle date is part of the evidence: the item\'s source ims-ledger is cycle-dated, so the gate requires the report\'s cycle date to be current (see the gate section). **Key:** (period, country, reporting category) from the IMS tax rate (its country code and its reporting category, lower case): IMS sums the line tax of its sales by rate; a WooCommerce tax line is placed by the IMS mapping of its rate id; a Xero invoice line by the Xero tax type that exactly one IMS rate carries. **Figures:** sales VAT in GBP with SHIPPING VAT LEFT OUT of every system (IMS holds it at order level with no rate, so the other two are cut to match): IMS is the base tax of the lines of orders by invoice instant, not cancelled, not archived (the IMS VAT report\'s own population); Xero is the line tax of AUTHORISED and PAID sales invoices by invoice date, lines on the configured shipping account left out, a foreign invoice multiplied by Xero\'s own CurrencyRate (Xero defines it as base currency per one unit of the document currency, as the connector\'s fx helper does, so EUR 50 at 0.8 is GBP 40); WooCommerce is the line tax of orders in processing, completed and refunded by GMT creation date, a non-GBP order divided by the fxRateToBase IMS recorded on the linked order (IMS stores 1 base = X foreign; the storefront records none; an order with no such rate is CURRENCY_UNKNOWN). A mapping is judged on every CONSTITUENT non-zero line (an IMS sales line, a Xero invoice line, a WooCommerce tax line) before anything is summed, so lines that cancel on an unverified rate still make the item VAT_MAPPING_UNVERIFIED (lines on the Xero shipping account are cut first, on purpose: shipping VAT is out of scope everywhere). SHIPPING VAT must be reliably cut out: the configured Xero shipping account must exist, be exactly one active account of the stored chart and differ from the sales and discount accounts, otherwise VAT_MAPPING_UNVERIFIED before any request (a shared account cannot tell shipping from goods). IMS never makes shipping a sales line (it is order level) and the storefront\'s shipping tax is never read. FEE lines are in IMS (a fee line becomes a sales line) but not proven to be in the storefront\'s tax_total, so a WooCommerce order with a non-zero fee-line tax in the window makes the item VAT_MAPPING_UNVERIFIED. A taxable Xero line counts only with a proven classification: IMS posts every goods and fee line to the sales account and the order discount to the discount account, shipping to the shipping account (cut); a taxable line with no account code, or on any other account, is VAT_MAPPING_UNVERIFIED whatever it nets to, and is never counted (a zero-tax line is harmless). Each verified key is then summed and rounded to the penny, half up; a key that nets to zero is not a key of that system, the same rule on all three sides, so a key on one side only with a non-zero value is a finding. The comparison is three legs (ims-xero, ims-woo, xero-woo) on the one comparator, each leg an identity of its own. A base currency other than GBP, in IMS or in the Xero organisation, is BASE_CURRENCY_NOT_GBP and nothing is compared. **U8 is unverified:** how Xero codes OSS, EC sales and reverse-charge sales is not known, so only the domestic category has a Xero side the pack believes, and only for a rate whose Xero tax type is its own (no other IMS rate carries it), is in the proven stored Xero list and has the verified report tax type OUTPUT there. Any non-zero VAT, in any of the three systems, on a rate that fails that (every OSS, EC sales and reverse-charge key, any key with no category, a shipping account that is not configured, not in the chart or shared with sales or discount, a non-zero WooCommerce fee-line tax, and a domestic rate with no country, no Xero tax type, a shared one, or one the proven list does not hold as OUTPUT) is VAT_MAPPING_UNVERIFIED for the whole item and nothing is compared; the IMS side is checked before any request is made. **How the Xero read proves a list:** the pack never refreshes a token (that writes the database and rotates the refresh token at Xero): the stored access token is used only while it has at least ${XERO_TOKEN_MIN_REMAINING_MS / 60_000} minutes to live, otherwise XERO_CONNECTION_UNUSABLE until the read-sync has renewed it; the connection is judged by the connector\'s own tenant guard with the same inputs, must be the organisation of the proven tax-rate list, and is read at the start and end of the Xero walk and must be unchanged. The organisation is read for its base currency. The invoices are asked for with Xero\'s own pagination and no page size is assumed (U7): the response must carry the pagination object (page, page size, page count, item count), the item count must be within ${XERO_WALK_MAX_ROWS} (CAP_EXCEEDED otherwise), the page count must be the item count over the page size rounded up, each page must report the page asked for and the same size, count and total as the first, every page but the last must be full and the last the remainder, no invoice may repeat, the invoices read must be as many as the item count, every invoice must ADD UP (TotalTax, SubTotal and Total present as plain numbers, LineAmountTypes one of Exclusive, Inclusive or NoTax - TaxAmount is the tax inside the line in all three - the sum of the TaxAmount of ALL its returned lines, before any cut, equal to TotalTax exactly, Total equal to SubTotal plus TotalTax, a NoTax invoice carrying no tax, and the LINE AMOUNTS adding up too, exactly as Xero stores them (2dp): Exclusive means SubTotal is the sum of LineAmount, Inclusive means Total is the sum of LineAmount, NoTax means SubTotal and Total are the sum; LineAmount against quantity times unit amount less discount is NOT checked, because Xero\'s rounding of those is not pinned to the penny by its documentation; an invoice with tax and no lines, or a truncated line list, is SOURCE_UNREADABLE and no figure at all), every invoice must be a sales invoice in an accepted status dated inside the window asked for (widened by a margin of whole days each side and then cut by invoice date), and the whole walk is then read a second time and must be equal invoice for invoice (VENDOR_READ_UNSTABLE otherwise). The WooCommerce read is the proven double sweep, and every order must reconcile (its total_tax equals the sum of every tax line\'s tax_total and shipping_tax_total exactly; otherwise SOURCE_UNREADABLE and no figure) (every status twice, widened by a margin of whole days each side and cut by GMT creation date). Xero is read with at most ${XERO_REQUEST_BUDGET} requests in a run, at most one every ${XERO_MIN_REQUEST_INTERVAL_MS / 1000} seconds (Xero allows 950 a day and 55 a minute, shared with the read-sync); a walk that would need more is CAP_EXCEEDED and no figure at all. TRUST BOUNDARY: R12 trusts that Xero\'s API returns an invoice\'s own line items; omitted lines are caught when the tax or the amounts stop adding up to the invoice totals, but a response that omits lines whose tax and amounts both net to zero is undetectable from one invoice response (the API gives no independent line count). NOT PROVEN: Xero\'s item count has no second source; the where and Statuses filters are unverified on the live service (rows outside them are refused, but invoices wrongly left out of a consistent count cannot be seen); the Xero side is every sales invoice of the organisation, not only those IMS posted; credit notes and refunds are not compared; the period of an order is each system\'s own date (invoice instant, invoice date, creation date), so an order near a month end can differ across systems; the storefront statuses counted are a choice (processing, completed, refunded); the daily Xero allowance is not read from the read-sync, only this run\'s spend is capped.`,
  ].join('\n'),
  qoblex: [
    'R2, R5, R7, R8 and R14 stand on an export of the incumbent system, Qoblex, which the pack never calls: the owner supplies it as files (owner decision D9). The run names the export directory with `--qoblex-export`; without it each of the five is inconclusive with QOBLEX_EXPORT_OFF as its only reason, no file is touched, and the readiness gate reads that as not available (like VENDOR_READS_OFF). R14 also needs `--vendor-reads-only`, and without it reports VENDOR_READS_OFF first.',
    '',
    `**The export directory.** It holds \`${QOBLEX_MANIFEST_FILE}\` and the files the manifest names (plain file names in the same directory). The directory and every ancestor must be modifiable only by root or the running account; each file must be a regular file (a symlink is never followed) owned by root or the running account and not writable by group or others. Every file is read ONCE and its sha256 is taken on the bytes that are parsed; the manifest declares each file's sha256 and a file that hashes to anything else (a copy in progress, an edited file) is unreadable. The digests are not published (the report format has no field for them).`,
    '',
    'The manifest is a closed JSON object in which no member is named twice at any depth (a repeated member is MANIFEST_INCONSISTENT, since JSON.parse would silently keep the last): `formatVersion` (1), `exportedAt` (an ISO time in UTC), `asOf` (the cycle date the export shows), `baseCurrency` (`GBP` only), `locations` (a list of `{code, company, threePl}`: the IMS warehouse code, the company it is grouped under, and whether it is a 3PL\'s; codes and companies are upper-case tokens), `stock` and `products`, each `{file, sha256, columnMap?: {file, sha256}}`, and `purchaseOrders` (R7 and R8 only): `{file, sha256, columnMap: {file, sha256}, keyPrefix}`, the Incoming (open purchase order) report with its REQUIRED column map and the prefix the first load put in front of a Qoblex order number to make the IMS reference (the first-load manifest\'s `purchaseOrderKeyPrefix`: an upper-case token of at most 16 characters). The incoming report is its own file (naming the stock or products file again is MANIFEST_INCONSISTENT), is the first-load `purchase-order-lines` dataset parsed by the same ingest, and accepts ONLY the repository\'s native incoming-stock map (`QOBLEX_NATIVE_PO_COLUMN_MAP`, pinned byte for byte to the first-load tool\'s tested map like the stock map; anything else, or none, is COLUMN_MAP_NOT_NATIVE or an unreadable manifest). THE REPORT HAS NO CURRENCY OR RATE and the pinned map carries no supplier, currency or rate table (it is the first-load tool\'s tested map with those tables removed; the currency column is the constant XXX and is never read): the currency of an order is the one IMS recorded on the matched purchase order, and its rate is the central `fx_rates` row (see R7 below). An empty report (header only) is legal and is the only part that may be empty. `stock` is the first-load `stock-lots` dataset and `products` its `products` dataset, parsed by the first-load ingest with the column map (the native Qoblex layouts, `docs/first-load-input-spec.md`); a column map is operator input and can rename, replace, fix or skip any value, so the ONLY map accepted is the repository\'s own native Qoblex map (`lib/reconciliation-pack/qoblex-native-map.ts`, pinned byte for byte to the first-load tool\'s tested map, which lists every transform in it): a manifest\'s column map whose bytes are anything else is COLUMN_MAP_NOT_NATIVE, and with no column map the file must be in the canonical layout, which has no transform. The native map\'s fixed location labels map to the codes MIL1, CAMBRIDGE, RESTOCK, QUARANTINE-CAMBRIDGE and RXT2; its currency is a constant GBP (a declaration, not read from the file). Any unknown or missing key, a repeated location (rejected whole), or a manifest that contradicts itself about a file (MANIFEST_INCONSISTENT, rejecting the whole manifest: every reference to a file, compared case-insensitively, must spell it alike and declare one sha256, a file is never both data and column map, and a data file shared by both parts needs the same column map), a repeated file, a malformed header or row, a location the manifest does not declare, a SKU that is not valid, a quantity that is not a plain decimal (a negative one is data and is compared as it is), a repeated (SKU, location) not told apart by distinct lot references, an empty file, or a part the manifest does not list makes that part SOURCE_UNREADABLE (or NO_POPULATION_RECORD for a location or declaration problem); every SKU (and, in the canonical layout, warehouse code) cell must be already canonical text, else IDENTITY_NOT_CANONICAL: the file is re-read raw because the ingest trims and normalises, and a padded or non-NFC SKU would otherwise match a system holding the plain one (the other legs compare SKUs exactly as read: the IMS and storefront reads and the warehouse-system list do no trimming, only a refusal of control characters); a padded quantity is accepted, since once trimmed it must be a plain decimal; every data row of every file is accounted for (the native map skips nothing, so only blank lines, which carry no cell, are not counted): no partial list is ever compared.',
    '',
    'The export must be for the run: `asOf` equal to `--as-of`, `exportedAt` after that day ended, not in the future, and not older than the weekly cadence allows (PACK_CADENCE_MAX_AGE_MS); otherwise QOBLEX_EXPORT_STALE. UNVERIFIED (U10): nothing in a Qoblex file proves when it was exported, so `exportedAt` and `asOf` are the operator\'s declaration, checked for consistency with the run and not for truth.',
    '',
    '**R2.** IMS stock against the export\'s quantity per (SKU, warehouse code) for the declared NON-3PL locations, EXACT (0.0001). The IMS side is the inventory snapshot of the cycle date, not the live stock levels. The population is established from IMS, not from the manifest: the eligible set is every ACTIVE IMS warehouse with no WMS binding of any connector, of every warehouse type (the native map reports standard, quarantine and restock locations), and the manifest\'s non-3PL codes must EQUAL it exactly, else NO_POPULATION_RECORD (an eligible warehouse the manifest leaves out would hide its stock; an unknown, inactive or bound code is not compared). A snapshot row in a warehouse outside the set is out only because it is bound (a 3PL\'s); an inactive warehouse holding stock or value on the cycle date makes R2 and R5 inconclusive (NO_POPULATION_RECORD). A zero position and no position are the same: zero rows leave both sides. A missing snapshot run row, or a snapshot naming a product or warehouse IMS does not hold, is SNAPSHOT_UNAVAILABLE. Phase P1 lists the result only (owner decision D3: until operators mirror Qoblex-only non-3PL movements into IMS, IMS has no feed for them); the pack compares it exactly regardless.',
    '',
    '**R5.** Valuation in GBP per non-3PL warehouse and per company (the manifest\'s grouping; IMS has no company concept, so both sides use the declaration). IMS = the sum of the snapshot\'s `valueBase`; Qoblex = the sum of quantity x unit cost over the stock file (each product rounded half-up to six decimals). Pass rule: the two totals differ by at most max(GBP 1, 0.05% of the larger total), inclusive, for every warehouse and every company (owner decision D2: the P1 pass rule for the inventory value). Every (SKU, warehouse) whose own valuation differs by more than 0.5% of the larger is also listed under outOfPopulation (REPORTED_NOT_JUDGED) and never decides the outcome. A currency other than GBP, a foreign exchange rate on a GBP row, a cost missing on a row with stock, or a snapshot row that is not point-in-time reliable is inconclusive. UNVERIFIED (U14): Qoblex\'s own valuation formula is not known; quantity x unit cost of the stock export is the stated reading.',
    '',
    '**R7 and R8** (phase P2 only; at P0 and P1 they are not applicable and NOTHING is read, no file and no database). **The identity is a recorded one:** the first load put the Qoblex order number into IMS as the purchase-order REFERENCE behind a prefix, so the IMS reference IS the manifest\'s `keyPrefix` followed by the Qoblex number (a plain token: letters, digits, dot, underscore, hyphen). An IMS order is matched to a Qoblex one only when its reference is exactly that; no other formatting is ever tried (no case folding, trimming or digit extraction). An IMS order whose reference the prefix does not explain is an IMS-only identity, keyed by its own id, and a finding. **The population is IMS\'s, not the file\'s, and is what the first load CREATED (recorded provenance):** an order is in scope only if IMS recorded the VERIFIED first load creating it: the activity-log row that `createPurchaseOrder` writes for it with the system actor and the run\'s `runId` (the run record\'s `run_id`), read in the same snapshot; it is never inferred from the reference\'s prefix and never from the export. The provenance must be of a VERIFIED run, and COMPLETE AGAINST ORDERS: the number of DISTINCT orders it attributes must equal the number of orders the run record\'s purchase-orders step emitted (a unit of that step is one order; `emitted` covers every attempt of a resumed run, where `created` alone counts only the last attempt; every unit is present when the run is VERIFIED, and none failed), and every attributed order must still exist (the activity log has a retention sweep, so a pruned row would otherwise make a first-load order look native, and a deleted order would otherwise vanish): otherwise NO_POPULATION_RECORD. Lines are not counted, so editing a line after the load changes nothing (there is no need to loosen the guard at P2). The in-scope IMS set is every such goods purchase order in a committed-incoming status (PO_SENT, SHIPPED, PARTIALLY_RECEIVED: the one definition the product page\'s Incoming figure uses; a draft or quote is not incoming supply), read whole; the Qoblex set is every order of the report with a quantity still outstanding. An incoming order WITHOUT first-load provenance (one IMS made itself) is listed out of the population and never judged or matched, whatever its reference looks like. The manifest, the prefix and the file cannot take an in-scope order out of the comparison: an order the export omits is onlyIms, an export order with no in-scope IMS match is onlyVendor, one the prefix fails to explain is both. **Freight purchase orders are excluded** (the read is of goods orders). **Order-level discount:** an IMS order carries one (`PurchaseOrder.discountAmount`, applied on top of line discounts), and neither the Incoming report nor the pinned native map expresses any discount (its Discount (%) column is not read), so an in-scope order with a non-zero order-level discount makes R7 inconclusive with VALUE_SHAPE_MISMATCH (the closed code for a value one side carries and the other cannot): it could otherwise pass with the discount on one side only. R8 compares quantities and is unaffected. **R7** compares each order, set EXACT and value in GBP: the OUTSTANDING value, IMS = the sum over its lines of (qty - qtyReceived) x the stored `unitCostBase` (the rate was fixed when the order was created: IMS\'s foreign exchange source), Qoblex = the sum over its lines of (ordered - received) x (price / rate), the unit rounded half-up to six decimals. THE EXCHANGE RATE HAS ONE SOURCE, the central `fx_rates` table (fed by the currency refresh; 1 GBP = rate units of the currency, so GBP = foreign / rate): the LATEST row from GBP to the order\'s currency with `fetchedAt` on or before the instant the IMS order was CREATED, read in the same snapshot. That instant is used because it is when IMS booked its own figures; the rate stored on the order is not used because the first-load importer accepts a supplied rate within 2% of the table\'s, so it is not provably a table row. The order\'s currency is the one IMS recorded on the purchase order (the report has none, so the foreign price is read as being in that currency: a stated limit). No row on or before that instant, a rate that is not a positive plain decimal, or two rows at the latest instant that disagree is CURRENCY_UNKNOWN, never a pass. An order in GBP needs no rate. An order that no IMS order explains has no recorded currency: it is already onlyVendor and carries its unconverted price sum. The catalogue\'s rule: an order in GBP must agree EXACTLY, so any nonzero difference at the stored precision (one millionth of a pound) is a finding; it is carried as a second identity `<order>|value-exact-gbp` whose two values are 0 and twice the difference in millionths of a pound, so the catalogue\'s GBP 1 limit is exceeded by any nonzero difference. Any other order is within GBP 1 inclusive. An IMS incoming order with nothing outstanding is a finding (Qoblex lists no such order). **R8** compares each open LINE, identified by (Qoblex order number, SKU) (the report has no line number, so a repeated pair on either side is DUPLICATE_KEY and is never summed): the outstanding quantity (ordered - received) EXACT (0.0001). Every open line is compared, which includes every part-received line; a line with nothing outstanding is no line on either side. Every ORDER on either side also has an order-level identity `<order>|order-lines-outstanding` (the number of its open lines, possibly 0), so an IMS incoming order whose lines are all received and which the export omits is onlyIms and R8 cannot pass. Received above ordered is BAD_VALUE. For both, nothing outstanding on either side passes only on the named proof `qoblex-incoming-report-empty`; every malformed, missing, duplicate or unstable input is inconclusive with a closed reason, and nothing is converted or guessed. UNVERIFIED: whether a Qoblex purchase order\'s PO number is what the first load used as its order key for every order (the first-load tool takes the report\'s Purchase Order column).',
    '',
    `**R14.** Every SKU of the union of the systems read must be in every one of them: Qoblex (the export's products), WooCommerce (the full proven double walk of top-level products), Mintsoft and IMS (every product). The comparison is over (SKU, system) pairs against the expectation, so equal counts with a SKU swapped are two findings, and the evidence key is \`SKU|system\`. A SKU is compared exactly as each system holds it. The export must agree with itself: R14 needs its stock part readable (the only cross-check on the product list; nothing in the export proves the list complete) and every SKU the stock part holds, in any location and at any quantity, must be in the product list, else EXPORT_INCONSISTENT (R2 and R5 do not read the product list, so they are not affected). The Mintsoft leg is the SKU list of the product census R1 reads (the double scan with its page limit clamped, the short last page proven by the empty page after it, no repeated id or SKU, and containment against the stock lists), through the same GET-only reader with the stored fixed key behind \`--vendor-reads-only\`, and it is read at most once per run: R14 is handed the result R1 got, so it adds no Mintsoft request to R1\'s (with no bound warehouse in the comparison no stock is read, and the census alone is read once, without the containment check). A Mintsoft bundle is kept in the list like every kit on the other legs: its SKU counts as present and its absence is a finding unless excluded. When the source cannot be read (an auth mode it refuses, an unstable list, a cap), that leg is LEG_UNAVAILABLE with the source\'s own reason: the other legs are still compared and a finding among them still fails the item, but it never passes. Set aside and listed, never a finding: a product variation (the storefront walk lists top-level products only, so a variation missing from the storefront is NOT detected: stated limit) and a storefront product with an empty SKU.`,
    '',
    `**Exclusions (owner decision D8).** \`--sku-exclusions <file>\` (default \`${SKU_EXCLUSION_DEFAULT_FILE}\`; absent means none; a named file that cannot be read is a refusal) is a JSON object \`{schemaVersion: 1, exclusions: [{sku, system, acceptedBy, acceptedAt, reason, expiresAt}]}\`, \`system\` one of ${R14_SYSTEMS.join(', ')}. One entry excludes ONE SKU in ONE system and nothing else; it is in force from \`acceptedAt\` until \`expiresAt\`, which must be after it and at most ${SKU_EXCLUSION_MAX_DAYS} days after it, with a reason of at least 15 characters. The file is read under the acceptance file\'s trust rule, and a member named twice at any depth (two expiresAt, say) rejects the whole file; an untrusted file, invalid JSON, an unknown field, another version, a repeated (SKU, system) pair or more than ${SKU_EXCLUSION_MAX_ENTRIES} entries rejects the WHOLE file and it accepts nothing; an incomplete entry accepts nothing and the others stand. An excluded pair is listed in the excluded bucket and not judged.`,
  ].join('\n'),
  gate: [
    'The readiness gate does not re-run any comparison. It reads the NEWEST pack report (the highest `sequence`, never the latest time, through the same chain reader as the trend: so a gap, a fork, a broken link or any pair that does not verify refuses the whole location) and turns each item\'s outcome into the gate\'s result for the slot: pass is pass, fail is fail, inconclusive is unreadable (which always blocks, whatever the phase), and not-applicable is not available. Two readings are made on the catalogue\'s word rather than the report\'s: an item the catalogue does not apply in the phase asked about is not available whatever report there is, and an item the report lists as inconclusive for NO_RUNNER alone (the build that made the report has no runner for it yet) is not available, the state the slot had before the pack fed the gate; it blocks only where not-available blocks (P2). The same reading is made for an item the report lists as inconclusive for VENDOR_READS_OFF alone (the run was not started with `--vendor-reads-only`, so no vendor was contacted and nothing was claimed): not available, so merging the vendor items changes no live verdict until a run opts in. NOT_SELECTED is different and stays unreadable: it is an operator\'s partial run, not the absence of a capability. Every other inconclusive item is unreadable, an item still settling (UNSETTLED_PENDING, with or without SETTLING_STATE_UNUSABLE) included: a difference that has not yet persisted is not a pass, and it is not a block that was already there either, so it blocks as unreadable until it settles or fails.',
    '',
    'The report counts only if ALL hold, and otherwise every item it would have covered is unreadable (never a pass, never skipped): the report directory and every ancestor, every run directory and every file are real (never symlinks), owned by root or the account running the gate, and not writable by group or others (the rehearsal reports\' rules; the Markdown, the evidence and the JSON are each read once and the digests are taken on those bytes); its cluster system identifier equals the database the gate runs against; it was made for the phase the gate is asked about; and it finished no later than now and no longer ago than the item\'s cadence allows (daily ' + PACK_CADENCE_MAX_AGE_MS.daily / 3_600_000 + ' hours, weekly ' + PACK_CADENCE_MAX_AGE_MS.weekly / 3_600_000 + ' hours, monthly ' + PACK_CADENCE_MAX_AGE_MS.monthly / 3_600_000 + ' hours, from the catalogue; the limit itself is inside). For an item that reads the stored trial balance or the ledger as of the cycle date (R6, R10, R11, R12), the cycle date must also be current: a real calendar date whose day had ended when the run finished, and whose end is no longer ago than the same cadence limit, since a fresh report about an old date says nothing about today. The directory is `--pack-report-dir` of the gate (default the pack\'s own default directory).',
    '',
    'R3, R4 and R15 are also derived by the gate itself from its own run of the invariant report. The two readings must AGREE: two passes are a pass, two fails are a fail (the gate\'s own result), and every other pair - one passes and the other does not, either is unreadable, or the pack has no usable report - is unreadable. A disagreement is never a pass, and neither reading can overrule the other\'s failure. NOT DEFENDED: an account that can write as the report owner or as root, and deleting the newest reports (the shorter chain still verifies), exactly as for the trend.',
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
  { file: 'docs/installation.md', blocks: ['overview', 'usage', 'cli-codes', 'readers', 'population', 'outcomes', 'proof', 'tokens', 'inputs', 'reasons', 'refusals', 'items', 'settling', 'liveness', 'basis', 'ledger', 'vendor', 'qoblex', 'gate', 'chain', 'exit-codes', 'audit'] },
]

export function renderPackDocBlock(id: PackDocBlockId): string {
  return `${PACK_DOC_BLOCK_OPEN(id)}\n${PACK_DOC_BLOCKS[id]}\n${PACK_DOC_BLOCK_CLOSE(id)}`
}
