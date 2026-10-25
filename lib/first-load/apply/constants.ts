/**
 * FIRST-LOAD APPLY RUNNER: every constant and every operator-facing sentence in one place.
 *
 * PURE: no database, no network, no clock, no filesystem. `docs/first-load-apply.md` carries marked blocks that must equal
 * what is exported here, and `tests/first-load/apply-docs.test.ts` fails when the two disagree.
 *
 * WHAT THIS SLICE IS. The runner's FILE side and its orchestration: it loads and verifies a prepared run, computes natural
 * keys and fingerprints, splits each step into the rows still to load, and drives the steps through ports (observe the
 * database, run an importer, keep a journal). The ports are implemented by the database slice; nothing here talks to one.
 */
import type { ImporterTarget } from '../spec'

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The steps the runner can apply, in the only order it applies them. Transfers are refused outright (see TRANSFERS_REFUSAL). */
export const APPLY_STEP_IDS = ['suppliers', 'products', 'opening-stock', 'purchase-orders'] as const
export type ApplyStepId = (typeof APPLY_STEP_IDS)[number]

/** A step's importer file kind. Each step id is its own target name. */
export const STEP_TARGET: Readonly<Record<ApplyStepId, ImporterTarget>> = {
  suppliers: 'suppliers',
  products: 'products',
  'opening-stock': 'opening-stock',
  'purchase-orders': 'purchase-orders',
}

/** What must also be selected for a step to be loadable (a row refers to something an earlier step creates). */
export const STEP_PREREQUISITES: Readonly<Record<ApplyStepId, readonly ApplyStepId[]>> = {
  suppliers: [],
  products: [],
  'opening-stock': ['products'],
  'purchase-orders': ['suppliers', 'products'],
}

export const PREPARED_REPORT_NAME = 'validation-report.json'
export const PREPARED_REPORT_MARKDOWN_NAME = 'validation-report.md'

/** The only base currency the first load supports (the one-way door in the plan). */
export const SUPPORTED_BASE_CURRENCY = 'GBP'

/** A rehearsal report older than this does not authorise an apply. */
export const REHEARSAL_MAX_AGE_HOURS = 24

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// ---------------------------------------------------------------------------
// Exit codes: ONE table. The document repeats it; the command and its --help read it from here.
// ---------------------------------------------------------------------------

export const APPLY_EXIT_CODES = {
  OK: 0,
  VERIFY_FAILED: 1,
  USAGE: 2,
  PRECONDITION_REFUSED: 3,
  STEP_FAILED: 4,
  CONFLICT: 5,
  INTERNAL: 6,
  REHEARSAL_TEARDOWN_INCOMPLETE: 7,
  APPLIED_UNVERIFIED: 8,
} as const
export type ApplyExitName = keyof typeof APPLY_EXIT_CODES

export const APPLY_EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: ApplyExitName; meaning: string }> = [
  { code: APPLY_EXIT_CODES.OK, name: 'OK', meaning: 'The rehearsal or apply finished and every verification passed.' },
  {
    code: APPLY_EXIT_CODES.VERIFY_FAILED,
    name: 'VERIFY_FAILED',
    meaning: 'Applied, but the post-run verification found a difference. The report names it. Rows ARE written; the restore procedure is printed.',
  },
  {
    code: APPLY_EXIT_CODES.USAGE,
    name: 'USAGE',
    meaning:
      'Bad arguments, an apply manifest that cannot be used, or a prepared run that cannot be used (a digest, SHA-256, header, limit, key or cross-file check failed, an input is unbound or unverified, or a transfers file is present). This command wrote nothing.',
  },
  {
    code: APPLY_EXIT_CODES.PRECONDITION_REFUSED,
    name: 'PRECONDITION_REFUSED',
    meaning: 'A rail or an apply-time check refused before the first write (including: no matching rehearsal, a run that already exists, or another runner holding the run). This command wrote nothing; an earlier run of the same load may have.',
  },
  {
    code: APPLY_EXIT_CODES.STEP_FAILED,
    name: 'STEP_FAILED',
    meaning:
      'A step failed after writes began. The database is partially loaded and the run is resumable with --resume (same digest) or restorable from the recorded restore point. Rows ARE written.',
  },
  {
    code: APPLY_EXIT_CODES.CONFLICT,
    name: 'CONFLICT',
    meaning: 'The database holds a key with different data than the file (or a row nobody in this run created). Nothing further was written; rows from earlier steps ARE written.',
  },
  {
    code: APPLY_EXIT_CODES.INTERNAL,
    name: 'INTERNAL',
    meaning: 'A self-check failed (the row accounting did not reconcile, or a report write failed). This is a defect in the runner. The database state is NOT assumed to be unchanged.',
  },
  {
    code: APPLY_EXIT_CODES.REHEARSAL_TEARDOWN_INCOMPLETE,
    name: 'REHEARSAL_TEARDOWN_INCOMPLETE',
    meaning: 'Rehearsal only: the throwaway database could not be removed completely. The real target was not written.',
  },
  {
    code: APPLY_EXIT_CODES.APPLIED_UNVERIFIED,
    name: 'APPLIED_UNVERIFIED',
    meaning: 'Every step loaded and the row accounting reconciles, but NO post-run verification was run (the runner was built without a verification port; the command always supplies one). This is NOT a success: do not treat it as OK. Rows ARE written. A later --resume of the same load runs the verification.',
  },
]

/** Exits for which the runner can PROVE that nothing was written: no write happens before the precondition phase ends. */
export const NOTHING_WRITTEN_EXITS: ReadonlySet<ApplyExitName> = new Set<ApplyExitName>(['USAGE', 'PRECONDITION_REFUSED'])
/** Exits after which rows ARE (or may be) written and the restore procedure must be printed. */
export const ROWS_WRITTEN_EXITS: ReadonlySet<ApplyExitName> = new Set<ApplyExitName>(['VERIFY_FAILED', 'STEP_FAILED', 'CONFLICT', 'INTERNAL', 'APPLIED_UNVERIFIED'])

export const NOTHING_WRITTEN_TEXT = 'This command wrote nothing to the database.'
export const ROWS_WRITTEN_TEXT = 'Rows may already be written to the database by this run.'
export const RESTORE_PROCEDURE_TEXT =
  'To undo this run, stop the application, restore the recorded restore point (a PostgreSQL custom-format dump) into an empty database, run the migrations and start again. '
  + 'The runner never restores by itself, and it never deletes rows.'

/** The sentence printed after a non-zero exit. Only the exits in NOTHING_WRITTEN_EXITS may say "nothing was written". */
export function exitOperatorText(name: ApplyExitName): string {
  if (name === 'OK') return ''
  if (NOTHING_WRITTEN_EXITS.has(name)) return NOTHING_WRITTEN_TEXT
  if (ROWS_WRITTEN_EXITS.has(name)) return `${ROWS_WRITTEN_TEXT} ${RESTORE_PROCEDURE_TEXT}`
  return 'The real target database was not written by this rehearsal; remove the leftover throwaway database by hand.'
}

export const TRANSFERS_REFUSAL =
  'the prepared run contains a transfers file; the runner cannot load transfers (they are Server Actions with their own permission checks and stock-sync effects). Remove the transfers from the run or load them by hand.'

// ---------------------------------------------------------------------------
// Row outcomes and conflict codes
// ---------------------------------------------------------------------------

export const UNIT_STATES = ['absent', 'present-matching', 'present-conflicting'] as const
export type UnitState = (typeof UNIT_STATES)[number]

export const ROW_OUTCOMES = ['created', 'updated', 'skipped-existing', 'failed', 'conflict', 'planned', 'would-skip-existing'] as const
export type RowOutcome = (typeof ROW_OUTCOMES)[number]

/** Why a key is in conflict. A closed list: the report and the docs name each one. */
export const CONFLICT_CODES = [
  'FIELDS_DIFFER',
  'RECIPE_DIFFERS',
  'CASE_COLLISION',
  'FOREIGN_HISTORY',
  'FOREIGN_ROW',
  'DUPLICATE_IN_DATABASE',
] as const
export type ConflictCode = (typeof CONFLICT_CODES)[number]

export const CONFLICT_CODE_MEANING: Readonly<Record<ConflictCode, string>> = {
  FIELDS_DIFFER: 'The key exists in the database with different field values than the file.',
  RECIPE_DIFFERS: 'The product exists and matches, but its recipe (components) is missing or different.',
  CASE_COLLISION: 'A different key exists that is equal under the importers\' case-insensitive matching.',
  FOREIGN_HISTORY: 'Opening stock: the product and warehouse already have stock, a cost layer or a movement that is not this run\'s opening layer.',
  FOREIGN_ROW: 'The database holds a row of this step that this run did not emit.',
  DUPLICATE_IN_DATABASE: 'The database holds the key more than once, so no single row can be compared.',
}

// ---------------------------------------------------------------------------
// Journal and report
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ['RUNNING', 'STEP_FAILED', 'CONFLICT', 'APPLIED', 'VERIFIED', 'VERIFY_FAILED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
/** A resume is accepted only from these. */
export const RESUMABLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['RUNNING', 'STEP_FAILED', 'VERIFY_FAILED'])

export const STEP_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CONFLICT'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

export const APPLY_REPORT_FORMAT_VERSION = 2

/**
 * WHAT A REPORT ROW MAY CARRY (docs/first-load-apply.md, "What a report contains"). A report is a private operator artefact. Per unit it holds the
 * unit key (a catalogue identifier the operator needs to act on a failure: supplier name, SKU, SKU|WAREHOUSE pair, purchase-order reference) and closed
 * words; never another cell of a prepared file, an importer's text, an exception message or a credential. tests/first-load/apply-orchestrate.test.ts
 * pins these field lists.
 */
export const REPORT_ROW_FIELDS = ['key', 'outcome', 'reason'] as const
export const REPORT_CONFLICT_FIELDS = ['key', 'code', 'detail'] as const
export const REPORT_IMPORTER_MESSAGE_FIELDS = ['code', 'row'] as const
/** Every report the command publishes is `<prefix><mode>-<run id>-<UTC stamp>.json` with its `.md` companion; the rehearsal record is `first-load-rehearsal-record-...json`. */
export const APPLY_REPORT_STEM_PREFIX = 'first-load-apply-'
export const REHEARSAL_RECORD_STEM_PREFIX = 'first-load-rehearsal-record-'
export const RESIDUAL_FILE_PREFIX = 'residual-'

/** The rehearsal record `--apply` insists on (written by the rehearsal mode). */
export const REHEARSAL_RECORD_FORMAT_VERSION = 1

export const APPLY_MODES = ['plan', 'apply'] as const
export type ApplyMode = (typeof APPLY_MODES)[number]

/** The warehouse profile keys and the types a warehouse can have (prisma enum WarehouseType; a test keeps them equal). */
export const WAREHOUSE_TYPES = ['STANDARD', 'QUARANTINE', 'RESTOCK'] as const
export const WAREHOUSE_PROFILE_KEYS = ['type', 'availableForSale', 'syncToStore'] as const

/** The apply manifest keys, a closed list. */
export const APPLY_MANIFEST_KEYS = [
  'formatVersion', 'runId', 'preparedDir', 'baseCurrency', 'steps', 'expectWarehouses', 'acceptZeroCost', 'forbidSkus', 'restorePointDir', 'wooSnapshot',
] as const
export const APPLY_WOO_SNAPSHOT_KEYS = ['snapshot', 'provenance', 'variantParents', 'origin', 'visibilityChecked'] as const

// ---------------------------------------------------------------------------
// Which apply-time checks the runner core covers (every id of APPLY_TIME_CHECKS has exactly one entry)
// ---------------------------------------------------------------------------

export const CHECK_COVERAGE_STATUSES = ['file-side', 'partial', 'database', 'not-applicable'] as const
export type CheckCoverageStatus = (typeof CHECK_COVERAGE_STATUSES)[number]

/**
 * `file-side`: proved from the prepared files alone by the core. `partial`: the file part is proved here and the part that needs IMS is
 * the database slice's. `database`: only the database slice can prove it. `not-applicable`: the runner refuses the whole area.
 */
export const APPLY_CHECK_COVERAGE: Readonly<Record<string, { status: CheckCoverageStatus; core: string; database: string }>> = {
  'warehouse-exists': { status: 'partial', core: 'The warehouse codes the files use must equal the codes declared in the apply manifest (expectWarehouses). That each exists in IMS with that profile is read from the database.', database: 'Rail warehouses: each declared warehouse exists, is active, is unique under upper-casing and has exactly the declared type, availableForSale and syncToStore. Checked before the run, at the start of every step and before its first write.' },
  'base-currency': { status: 'partial', core: 'The apply manifest, the prepared report and the supported base currency (GBP) must agree. The organisation row is read from the database.', database: "Rail base currency: the organisation's base currency (GBP when there is no row, as the importers read it) equals the manifest's." },
  'opening-stock-empty': { status: 'partial', core: 'Stock history on a product and warehouse that is not this run\'s opening layer is a conflict (FOREIGN_HISTORY) and stops the run. Reading that history is the database slice\'s.', database: 'observe reads every stock level, cost layer and movement per product and warehouse. A pair that is not exactly one opening layer, its one opening movement and a matching stock level is FOREIGN_HISTORY.' },
  'po-supplier-exists': { status: 'partial', core: 'Every purchase-order supplier must be a supplier of the suppliers file, which the same run loads first.', database: 'Nothing more is needed: the supplier is loaded by the same run, and an order whose stored supplier differs from the file is FIELDS_DIFFER.' },
  'supplier-tax-rate': { status: 'database', core: 'Needs the IMS tax rates. The prepared suppliers file must state a purchaseTaxType from the closed Xero list and a currency on every row.', database: 'Rail tax rates: every distinct purchaseTaxType of the suppliers file resolves to exactly one active IMS tax rate usable for purchases (usedFor PURCHASE or BOTH) with that accountingTaxType; several refuse. A type with NONE is first IMPORTED from Xero (below); it refuses only when that import is refused. Every supplier default rate is within the manifest\'s maxPurchaseTaxRate (SUPPLIER_TAX_RATE_ABOVE_MAX; no declared maximum: SUPPLIER_TAX_MAX_UNDECLARED). Every EXISTING supplier default rate must equal the trusted stored Xero row of its type (rate column and effective rate; SUPPLIER_TAX_RATE_DISAGREES_WITH_XERO names the type and both percentages, fixed by the Settings import with replace-differing), and an unusable stored list refuses (SUPPLIER_TAX_XERO_UNTRUSTED). The supplier importer repeats the lookup per row and sets the supplier default tax rate, and the read-back compares the stored rate\'s accounting tax type with the file.' },
  'po-fx-rate': { status: 'partial', core: "Every non-base order's fxRateToBase must be a positive number (the prepare step looked it up in fx_rates at the order's created day; the apply manifest states no rate and a `fxRates` key is refused as an unknown key). That IMS's fx_rates holds that rate, and that it is within the importer's 2% of today's, is read from the database. Every order's currency must also be its supplier's currency in the suppliers file (PO_CURRENCY_DIFFERS_FROM_SUPPLIER; prepare cannot produce a difference, so it means an edited file).", database: "Rail FX rates: each distinct rate of the purchase-orders file is a rate fx_rates holds for its currency, today's stored rate exists, and the file's rate is within the importer's 2% of it. A supplier already stored must have the currency its orders state (PO_CURRENCY_DIFFERS_FROM_SUPPLIER). The runner never writes a rate." },
  'po-tax-rate': { status: 'database', core: 'Needs the IMS tax rates.', database: 'Rail tax rates: every line tax resolves to an active purchase rate (by name, trimmed and case-insensitive, else by value within 0.00005), and every order-level tax name exists with exactly that spelling, because createPurchaseOrder looks it up case-exactly.' },
  'lookup-keys-unique-in-ims': { status: 'partial', core: 'Inside the files, no two suppliers, products, stock pairs or orders may differ only in letter case. A look-alike already in the database is a conflict (CASE_COLLISION).', database: "observe keys every row by the importer's own key and its upper-case form. A different key with the same upper-case form is CASE_COLLISION, and a repeated key is DUPLICATE_IN_DATABASE." },
  'po-reference-free': { status: 'partial', core: 'An order whose reference already exists with the same content is skipped as existing; with different content it is a conflict. Reading the references is the database slice\'s.', database: 'observe reads every order by reference. The same reference with the same content is skipped, and with different content (including any status other than DRAFT) is FIELDS_DIFFER.' },
  'po-product-lifecycle': { status: 'database', core: 'Needs the lifecycle of products that are only in IMS.', database: "Covered by construction: the runner loads into an empty database, the products an order uses are the files' own, and a product nobody in this run emitted is FOREIGN_ROW. The importer itself refuses a product that is not active or draft, and the order then shows as not loaded." },
  'transfer-reference-free': { status: 'not-applicable', core: 'The runner refuses a prepared run that contains transfers.', database: 'Not applicable.' },
  'transfer-source-stock': { status: 'not-applicable', core: 'The runner refuses a prepared run that contains transfers.', database: 'Not applicable.' },
  'barcode-free': { status: 'database', core: 'Needs the barcodes already in IMS.', database: 'The empty-target rail refuses a database that already holds products, and a product nobody in this run emitted is FOREIGN_ROW. The importer also refuses a barcode already in use.' },
  'product-parent-exists': { status: 'file-side', core: 'Every VARIANT\'s parent must be a VARIABLE product of the same products files (the first load is into an empty database), and a parent from WooCommerce must come from a verified snapshot.', database: 'The stored parent SKU of a variant is part of the product fingerprint.' },
}

/**
 * The application_name every connection of the runner carries (the database pool, the lock pool, the run-record writes: all one process). The command sets PGAPPNAME to this
 * BEFORE it opens any connection, and the quiesce rail refuses to run if its own session does not report it, so the runner's sessions are told apart from everybody else's.
 */
export const RUNNER_APPLICATION_NAME = 'ims-first-load-apply'

// ---------------------------------------------------------------------------
// The rails, by id, and which apply-time check each one proves (the report's preconditions[])
// ---------------------------------------------------------------------------

/**
 * Every rail the runner evaluates before a load may write, in the order they are evaluated. The report lists each one (`preconditions[]`) and the readiness gate requires them all.
 * The last four are the PRE-LOAD rails (the first load runs with the application STOPPED, and nothing that could write outside the database may be armed):
 *   outbound-grants  no outbound write grant is present in the installation environment, readable or not;
 *   producer-hold    the producer-hold variables are consistent, no live-from instant is set, and the state is reported;
 *   connectors       no connector is enabled with a credential that could write;
 *   crons            no scheduled job that could write is installed in the crontab of the account running the load.
 */
export const RAIL_IDS = [
  'quiesce', 'data-classes', 'base-currency', 'forbidden-skus', 'currency-lock', 'warehouses', 'fx-rates', 'tax-rates', 'outbound-grants', 'producer-hold', 'connectors', 'crons',
] as const
export type RailId = (typeof RAIL_IDS)[number]

/** The rails that need every prepared run (the others depend on the steps selected). */
export const PRELOAD_RAIL_IDS: readonly RailId[] = ['outbound-grants', 'producer-hold', 'connectors', 'crons']

/**
 * Which rails prove each apply-time check (spec.ts APPLY_TIME_CHECKS). An empty list means the prepared files alone prove it (the run could not have been loaded otherwise);
 * `null` means the runner refuses the whole area. A test keeps this table equal to the check list and to APPLY_CHECK_COVERAGE.
 */
export const APPLY_CHECK_RAILS: Readonly<Record<string, readonly RailId[] | null>> = {
  'warehouse-exists': ['warehouses'],
  'base-currency': ['base-currency', 'currency-lock'],
  'opening-stock-empty': ['data-classes'],
  'po-supplier-exists': [],
  'po-fx-rate': ['fx-rates'],
  'supplier-tax-rate': ['tax-rates'],
  'po-tax-rate': ['tax-rates'],
  'lookup-keys-unique-in-ims': ['data-classes'],
  'po-reference-free': ['data-classes'],
  'po-product-lifecycle': ['data-classes'],
  'transfer-reference-free': null,
  'transfer-source-stock': null,
  'barcode-free': ['data-classes'],
  'product-parent-exists': [],
}

/** The ids of `preconditions[]` in an apply report, in order: every rail, then every apply-time check. The readiness gate requires exactly these. */
export const PRECONDITION_IDS: readonly string[] = [...RAIL_IDS.map((id) => `rail:${id}`), ...Object.keys(APPLY_CHECK_RAILS).sort().map((id) => `check:${id}`)]
