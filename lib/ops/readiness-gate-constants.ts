/**
 * THE ONE PLACE THE READINESS GATE'S WORDS, NAMES AND NUMBERS LIVE.
 *
 * `npm run readiness:gate` answers one question: may this installation go on to the next phase of the
 * switchover? Everything an operator reads about it (the verdict names, the exit-code table, the
 * per-phase expectations, the paragraph that docs/installation.md carries) is defined here and
 * nowhere else. The code imports these values; the docs carry marked blocks whose body must equal the
 * text below byte for byte, and tests/ops/readiness-gate-docs.test.ts checks EVERY marked block
 * against this module (a universal check: a stale block beside a correct one fails).
 *
 * No imports, on purpose: the gate, its CLI, its tests and the docs check all read this file and none
 * of them should need a database to read a sentence.
 */

export const READINESS_GATE_COMMAND = 'npm run readiness:gate'

/** The phases of the switchover the gate is asked about (the P0/P1/P2 plan). */
export const READINESS_PHASES = ['P0', 'P1', 'P2'] as const
export type ReadinessPhase = (typeof READINESS_PHASES)[number]

export const READINESS_PHASE_MEANING: Record<ReadinessPhase, string> = {
  P0: 'the first load: IMS has been loaded and nothing outside IMS may be written',
  P1: 'the parallel run: IMS reads and reconciles, every write to WooCommerce, Mintsoft and Xero stays held',
  P2: 'the switch of writers: exactly the declared writers may write, and the reconciliation pack must be available',
}

/** The three verdicts. Nothing else is ever printed as a verdict. */
export const READINESS_VERDICTS = ['GO', 'GO-WITH-ACCEPTED-WARNINGS', 'NO-GO'] as const
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number]

/**
 * THE EXIT CODES, DOCUMENTED ONCE. docs/installation.md carries the table rendered from this array, and
 * a test compares every row. The two GO verdicts differ on purpose: automation that treats only 0 as
 * success cannot mistake a verdict that rests on written warning acceptances for a clean one.
 */
export type ReadinessGateExitCode = { code: number; name: string; meaning: string }
export const READINESS_GATE_EXIT_CODES: readonly ReadinessGateExitCode[] = [
  { code: 0, name: 'go', meaning: 'GO: every check for the phase passed and there are no warnings; the report was published' },
  { code: 10, name: 'go-with-accepted-warnings', meaning: 'GO-WITH-ACCEPTED-WARNINGS: every check passed and every warning is covered by a current written acceptance; the report was published. Deliberately not 0, so a script that wants a clean GO cannot mistake this for one' },
  { code: 1, name: 'no-go', meaning: 'NO-GO: at least one check failed, was unreadable, was missing, was not available where it is required, or raised a warning with no current written acceptance. The report names each' },
  { code: 2, name: 'refused', meaning: 'the gate refused to run (bad or missing arguments, no DATABASE_URL, an unsafe report directory); no check was run and nothing was written' },
  { code: 3, name: 'report-not-published', meaning: 'a GO verdict was reached but the report could not be durably published; the verdict is printed but is not a GO, because a verdict nobody can read back is not evidence' },
  { code: 4, name: 'failed', meaning: 'the gate itself failed unexpectedly before it could reach a verdict; treat as NO-GO' },
]

export function readinessGateExitCode(name: string): number {
  const found = READINESS_GATE_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`readiness gate exit code ${name} is not in the table`)
  return found.code
}

export function renderReadinessGateExitCodeTable(): string {
  const rows = [...READINESS_GATE_EXIT_CODES]
    .sort((left, right) => left.code - right.code)
    .map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Limits the verdict depends on. Each is a chosen default, stated as one.
// ---------------------------------------------------------------------------------------------

/** How old the newest first-install rehearsal may be. A chosen default; there is deliberately no option to relax it. */
export const REHEARSAL_MAX_AGE_DAYS = 14
/** A rehearsal that claims to have finished further than this in the future is not believed. */
export const REHEARSAL_CLOCK_SKEW_MS = 5 * 60 * 1000
/** The longest a written acceptance may run. A warning accepted for a year is a warning nobody reads again. */
export const ACCEPTANCE_MAX_DAYS = 90
export const ACCEPTANCE_CLOCK_SKEW_MS = 5 * 60 * 1000
export const ACCEPTANCE_REASON_MIN_LENGTH = 15
export const ACCEPTANCE_SCHEMA_VERSION = 1
export const ACCEPTANCES_DEFAULT_FILE = 'ops/readiness-warning-acceptances.json'

/** The package.json script the read-sync liveness check runs once it exists (see READ_SYNC_CONTRACT). */
export const READ_SYNC_STATUS_SCRIPT = 'read-sync:status'
export const READ_SYNC_SCHEMA_VERSION = 1
export const READ_SYNC_CONTRACT_VERSION = 'read-sync status schemaVersion 1, matched against the WP8 producer at commit e6eb79b2 (PR 744, not yet merged: UNPROVEN until it merges, and the reading changes with it if its JSON changes)'
/** The streams that must all be reported, each fresh. Mirrors that status API's stream list. */
export const REQUIRED_READ_SYNC_STREAMS = [
  'woocommerce-order-sweep',
  'mintsoft-stock-sync',
  'mintsoft-dispatch-poll',
  'mintsoft-order-status',
  'xero-balance-snapshots',
  'xero-tax-rates',
] as const
export const READ_SYNC_CONTRACT = `${READ_SYNC_CONTRACT_VERSION}: \`npm run --silent read-sync:status\` exits 0 and prints one JSON object with \`schemaVersion\` 1, \`generatedAt\`, \`counts\` that equal the tally of its entries, and an \`entries\` list (one per stream, or per binding for the stock sync) carrying \`stream\`, \`state\` (must be fresh), \`lastSuccessAt\` (a valid ISO time, not in the future), \`futureTimestamp\`, \`ageMs\` (consistent with the two times) and \`maxAgeMs\`, covering all of ${REQUIRED_READ_SYNC_STREAMS.join(', ')}, and a \`scheduler\` object with \`examined\` true, \`unreadable\` and \`blockProblem\` exactly null, and \`unscheduled\` and \`disabled\` empty lists. Every field named here must be present with its type; a missing or malformed one makes the output unreadable, not fresh`

/** What the build identity covers, said in every GO and in the docs. */
export const BUILD_SCOPE_TEXT = 'The rehearsal is tied to this build by source commit and source tree only; it is NOT tied to the build artefact (.next/BUILD_ID) and NOT to the .env configuration.'

/** Why a rehearsal report location was not read. */
export const REHEARSAL_TRUST_TEXT = (reason: string) => `the rehearsal report location is not trusted (${reason}); a report that another account could have written proves nothing, so it was not read`

/**
 * What the gate runs in place of validate:db. Each is read-only (migrate status and migrate diff only read the
 * schema and the migration table, and the drift check wraps migrate diff); none of them regenerates the client.
 */
export const SCHEMA_STATE_SCRIPTS = ['db:migrate:status', 'db:schema:diff', 'db:schema:drift'] as const
/**
 * The CHECK constraints the stock tables must carry, each by NAME, TABLE and DEFINITION. PostgreSQL constraint names are only
 * unique per table, so a name alone proves nothing: the gate checks that THIS constraint is on THIS table in the application's
 * schema, validated, with this definition (the SQL of the migration that created it, compared after normalisation). The first
 * six are the ones scripts/check-stock-quantity-constraints.mjs makes fire; the seventh is the reserved-not-above-quantity rule
 * of 20260424180000_stock_integrity_checks.
 */
export type ExpectedCheckConstraint = { name: string; table: string; definition: string }
export const REQUIRED_CHECK_CONSTRAINTS: readonly ExpectedCheckConstraint[] = [
  { name: 'stock_levels_quantity_nonnegative', table: 'stock_levels', definition: 'CHECK ("quantity" >= 0)' },
  { name: 'stock_levels_reserved_nonnegative', table: 'stock_levels', definition: 'CHECK ("reservedQty" >= 0)' },
  { name: 'stock_levels_reserved_qty_lte_quantity', table: 'stock_levels', definition: 'CHECK ("reservedQty" <= "quantity")' },
  { name: 'cost_layers_received_nonnegative', table: 'cost_layers', definition: 'CHECK ("receivedQty" >= 0)' },
  { name: 'cost_layers_remaining_qty_non_negative', table: 'cost_layers', definition: 'CHECK ("remainingQty" >= 0)' },
  { name: 'cost_layers_remaining_qty_lte_received_qty', table: 'cost_layers', definition: 'CHECK ("remainingQty" <= "receivedQty")' },
  { name: 'stock_movements_qty_nonnegative', table: 'stock_movements', definition: 'CHECK ("qty" >= 0)' },
] as const

/** One definition, comparable across the migration's SQL and pg_get_constraintdef's rendering of it. */
export function normaliseConstraintDefinition(definition: string): string {
  return definition.toLowerCase().replace(/::numeric/g, '').replace(/[\s()"]/g, '')
}

export const DEFAULT_REPORT_DIR = '/var/tmp/ims-readiness-gate-reports'
export const DEFAULT_REHEARSAL_DIR = '/var/tmp/ims-rehearsal-reports'


// ---------------------------------------------------------------------------------------------
// The check catalogue: what is asked, and what each phase requires of it.
// ---------------------------------------------------------------------------------------------

export const REQUIREMENTS = ['required', 'optional-until-present', 'listed-only'] as const
/**
 * required                A missing, unreadable, unavailable or failed result is a NO-GO.
 * optional-until-present  Absent (no signal on this tree) is listed as NOT YET AVAILABLE and does not block;
 *                         the moment the signal exists it is required like any other check.
 * listed-only             Reported, but its result does not decide the verdict in this phase.
 */
export type Requirement = (typeof REQUIREMENTS)[number]

export type FixedCheckId =
  | 'invariant-preflight'
  | 'schema-state'
  | 'outbound-status'
  | 'first-install-rehearsal'
  | 'reconciliation-completeness'
  | 'read-sync-liveness'

export const PACK_ITEM_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'] as const
export type PackItemId = (typeof PACK_ITEM_IDS)[number]
export type PackCheckId = `pack-${PackItemId}`
export type CheckId = FixedCheckId | PackCheckId

export type CheckDefinition = {
  id: CheckId
  title: string
  requirement: Record<ReadinessPhase, Requirement>
  /** What a pass means in each phase, in operator words. */
  expectation: Record<ReadinessPhase, string>
}

const ALL_PHASES = <T,>(value: T): Record<ReadinessPhase, T> => ({ P0: value, P1: value, P2: value })

/** The reconciliation pack items (o3d-zjsb5.19). `source` says what is on this tree to build each from. */
export const PACK_ITEMS: ReadonlyArray<{ id: PackItemId; title: string; derivedFrom: 'invariant-report' | null; source: string }> = [
  { id: 'R1', title: 'Stock on hand, IMS against Mintsoft, per SKU per warehouse', derivedFrom: null, source: 'needs a Mintsoft stock extract; /api/export/stock-levels is the IMS side' },
  { id: 'R2', title: 'Stock on hand, IMS against Qoblex, per SKU per warehouse', derivedFrom: null, source: 'needs the owner\'s Qoblex stock extract; /api/export/stock-position is the IMS side' },
  { id: 'R3', title: 'StockLevel.quantity against the sum of CostLayer.remainingQty', derivedFrom: 'invariant-report', source: 'the invariant report code stock_cost_layer_quantity_mismatch' },
  { id: 'R4', title: 'StockLevel.reservedQty against the sum of OrderAllocation.qty', derivedFrom: 'invariant-report', source: 'the invariant report code stock_reserved_source_mismatch' },
  { id: 'R5', title: 'Inventory valuation, IMS against Qoblex', derivedFrom: null, source: 'needs the Qoblex valuation extract; /api/export/inventory-costing is the IMS side' },
  { id: 'R6', title: 'Inventory subledger against Xero Inventory plus Allocated Inventory', derivedFrom: null, source: 'lib/domain/accounting/inventory-gl-reconciliation.ts and account-gl-reconciliation.ts evaluate it; nothing yet feeds them the Xero trial balance' },
  { id: 'R7', title: 'Open purchase-order commitment', derivedFrom: null, source: 'needs the Qoblex open-PO extract; /api/export/purchase-orders is the IMS side' },
  { id: 'R8', title: 'Part-received purchase-order outstanding quantity, per line', derivedFrom: null, source: 'needs the Qoblex open-PO extract; /api/export/purchase-orders is the IMS side' },
  { id: 'R9', title: 'Open sales orders, IMS against WooCommerce', derivedFrom: null, source: 'needs a WooCommerce open-order read; /api/export/sales is the IMS side' },
  { id: 'R10', title: 'Xero control accounts (Inventory, Allocated, Transit, COGS, Unearned Revenue)', derivedFrom: null, source: 'lib/domain/accounting/account-gl-reconciliation.ts and cogs-gl-reconciliation.ts evaluate it; nothing yet feeds them the Xero trial balance' },
  { id: 'R11', title: 'Stock in Transit against the open-PO goods-in-transit schedule', derivedFrom: null, source: 'lib/domain/accounting/transit-gl-reconciliation.ts evaluates it; nothing yet runs it for the gate' },
  { id: 'R12', title: 'VAT by country and reporting category, IMS against Xero and WooCommerce', derivedFrom: null, source: 'needs Xero VAT and WooCommerce tax reports' },
  { id: 'R13', title: 'Tax-rate mapping coverage', derivedFrom: null, source: 'no runner on this tree' },
  { id: 'R14', title: 'SKU coverage across Qoblex, WooCommerce, Mintsoft and IMS', derivedFrom: null, source: 'needs the four extracts; /api/export/products is the IMS side' },
  { id: 'R15', title: 'The invariant report: zero critical findings, every warning accepted', derivedFrom: 'invariant-report', source: 'the invariant-preflight check of this gate' },
]

export const CHECK_CATALOGUE: readonly CheckDefinition[] = [
  {
    id: 'invariant-preflight',
    title: 'Invariant report complete, with zero critical findings',
    requirement: ALL_PHASES('required'),
    expectation: ALL_PHASES('All three invariant reports completed, none was truncated, and no finding is critical. Each warning finding is listed and must be accepted in writing.'),
  },
  {
    id: 'schema-state',
    title: 'Database schema is applied, has not drifted, and the CHECK constraints are installed (read-only)',
    requirement: ALL_PHASES('required'),
    expectation: ALL_PHASES('prisma migrate status says the schema is up to date, the schema diff and the drift check find no difference, and the seven stock CHECK constraints exist on their own tables, validated, with the definitions the migrations gave them. These only read; npm run validate:db (which makes the constraints fire with a rolled-back probe and regenerates the client) is not run by the gate.'),
  },
  {
    id: 'outbound-status',
    title: 'Outbound writes are in the state this phase expects',
    requirement: ALL_PHASES('required'),
    expectation: {
      P0: 'Every connector is held (no write grant), and the activity log could be read.',
      P1: 'Every connector is held (no write grant), and the activity log could be read.',
      P2: 'Exactly the connectors named by --expect-granted are granted and every other connector is held; no grant variable is unreadable.',
    },
  },
  {
    id: 'first-install-rehearsal',
    title: 'Latest first-install rehearsal is present, GREEN and fresh',
    requirement: ALL_PHASES('required'),
    expectation: ALL_PHASES(`The newest report in the rehearsal directory has an intact digest pair, was made for the same commit and source tree as the checkout the gate runs from (both must have no uncommitted changes; an older report format that records no build is refused), is GREEN with every step required and passed (outbound status included), a clean teardown, and finished within ${REHEARSAL_MAX_AGE_DAYS} days.`),
  },
  {
    id: 'reconciliation-completeness',
    title: 'Accounting reconciliation is proven complete',
    requirement: ALL_PHASES('required'),
    expectation: ALL_PHASES('A reconciliation run exists, no recorded truncation is left uncovered by a later complete run over the same period, no run record is unreadable, and the newest run recorded its completeness. A stale or unrecorded newest run is a warning.'),
  },
  {
    id: 'read-sync-liveness',
    title: 'Read-sync streams are fresh',
    requirement: ALL_PHASES('optional-until-present'),
    expectation: ALL_PHASES(`Optional until the tree has a ${READ_SYNC_STATUS_SCRIPT} script; once it does, every stream it reports must be fresh. Contract: ${READ_SYNC_CONTRACT}.`),
  },
  ...PACK_ITEMS.map((item): CheckDefinition => ({
    id: `pack-${item.id}`,
    title: `${item.id}: ${item.title}`,
    requirement: { P0: 'listed-only', P1: 'listed-only', P2: 'required' },
    expectation: {
      P0: 'Listed. Not available items are not checked and do not block.',
      P1: 'Listed. Not available items are not checked and do not block.',
      P2: 'Must be available and pass. An item that is NOT YET AVAILABLE makes the verdict NO-GO.',
    },
  })),
]

export function checkDefinition(id: string): CheckDefinition | undefined {
  return CHECK_CATALOGUE.find((definition) => definition.id === id)
}

function renderChecksTable(): string {
  const word: Record<Requirement, string> = { required: 'required', 'optional-until-present': 'optional until present', 'listed-only': 'listed only' }
  const rows = CHECK_CATALOGUE.map((definition) => `| ${definition.title.replace(/\|/g, '\\|')} | ${READINESS_PHASES.map((phase) => word[definition.requirement[phase]]).join(' | ')} |`)
  return ['| Check | P0 | P1 | P2 |', '|---|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const READINESS_GATE_DOC_BLOCK_OPEN = (id: string) => `<!-- readiness-gate:${id} -->`
export const READINESS_GATE_DOC_BLOCK_CLOSE = (id: string) => `<!-- /readiness-gate:${id} -->`

export type ReadinessGateDocBlockId = 'overview' | 'usage' | 'phases' | 'acceptances' | 'exit-codes' | 'endpoint'

const PHASE_ROWS = READINESS_PHASES.map((phase) => `| ${phase} | ${READINESS_PHASE_MEANING[phase]} |`)

export const READINESS_GATE_DOC_BLOCKS: Record<ReadinessGateDocBlockId, string> = {
  overview: [
    `\`${READINESS_GATE_COMMAND}\` collects the checks that decide whether an installation may go on to the next phase of the switchover and reduces them to one verdict: GO, GO-WITH-ACCEPTED-WARNINGS or NO-GO. It performs no database write and no write to the checkout, makes no call to WooCommerce, Mintsoft or Xero, and writes only its own report. Its schema check runs \`prisma migrate status\`, the schema diff and the drift check, which only read, and reads the constraint catalogue; it does not run \`npm run validate:db\`.`,
    '',
    `The verdict is only as wide as the checks that ran. A GO says that every check listed as required for the phase passed on the database and environment the gate was run against, at the time stated in the report. ${BUILD_SCOPE_TEXT} It does not inspect the environment of any running service (the outbound check reads the environment of the gate process, so run the gate with the environment the services use), and it does not say the data matches Qoblex, Mintsoft, WooCommerce or Xero unless a reconciliation pack item for that comparison is listed in the report as run and passed. A check that is missing, unreadable or unknown is a NO-GO, never a skipped check; the only checks that may be absent are the ones the report names as optional until they exist.`,
    '',
    'Not checked by the gate: that the CHECK constraints actually fire, and that the Prisma client is generated. Both belong to `npm run validate:db`, which inserts probe rows in a transaction it rolls back and regenerates the client, so it is an operator pre-step run on a scratch database (the fresh-install rehearsal runs it on its own cluster). Also not checked: the build artefact, the `.env` configuration, every item the report lists as NOT YET AVAILABLE, and the authenticity of the rehearsal report beyond who could have written it (see the rehearsal section).',
  ].join('\n'),
  usage: [
    `\`${READINESS_GATE_COMMAND} -- --phase <P0|P1|P2> [--expect-granted <connector[,connector]|none>] [--acceptances <file>] [--rehearsal-dir <dir>] [--report-dir <dir>] [--json]\``,
    '',
    'The phase is required; there is no default, because the same installation can be ready for one phase and not for the next. `DATABASE_URL` must be set in the environment of the gate: it does not read `.env` files, and it never puts a credential on a command line. `--expect-granted` is required for P2 and refused for P0 and P1: it names the connectors (woocommerce, mintsoft, xero) that are meant to be able to write at P2, or `none`, and the outbound check then requires exactly those to be granted and the others held. `--acceptances` names the written warning-acceptance file (default `ops/readiness-warning-acceptances.json` in the checkout; absent means no warning is accepted). `--rehearsal-dir` is where `npm run rehearse:first-install` publishes its reports. `--json` prints the JSON report on standard output and nothing else; progress and the Markdown go to standard error. The report is published as `readiness-gate.json` and `readiness-gate.md` under `<report-dir>/<run id>/`, Markdown first and the JSON last; the JSON names the Markdown by its sha256 and is the commit record.',
  ].join('\n'),
  phases: [
    'What each phase requires. Every row is collected on every run; a required check that is missing, unreadable, unavailable or failed is a NO-GO, and so is an optional-until-present check whose signal exists but cannot be read. A reconciliation pack item that is not yet available is listed, and blocks only at P2.',
    '',
    '| Phase | Meaning |',
    '|---|---|',
    ...PHASE_ROWS,
    '',
    renderChecksTable(),
  ].join('\n'),
  acceptances: [
    'A warning is not a failure, and it is not a pass either: it must be accepted in writing, one warning at a time, or the verdict is NO-GO. The acceptance file is JSON with `schemaVersion` 1 and an `acceptances` list. Every entry names exactly one warning by its `warningId` (no patterns, no wildcards) and carries `acceptedBy` (who), `acceptedAt` (when, an ISO time not in the future), `reason` (why, at least 15 characters), `expiresAt` (an ISO time after `acceptedAt`, no more than 90 days later) and `phases` (the phases it applies to, a non-empty list of P0, P1, P2). An entry that has expired, that is not yet in effect, that does not list the phase being asked about, or that is malformed does not accept anything; a file that cannot be read, has an unknown field, or names the same warning twice is rejected as a whole and nothing is accepted. A failure is never acceptable: only findings the report labels as warnings can be covered. An acceptance for a warning that no longer occurs is listed as unused and does no harm. Because an acceptance is a decision, the file is used only if it is a regular file (a symlink is never followed) owned by root or the account running the gate, not writable by group or others, in a directory whose every ancestor only root or that account can modify; otherwise the whole file is rejected, the report says why, and nothing is accepted.',
  ].join('\n'),
  'exit-codes': renderReadinessGateExitCodeTable(),
  endpoint: [
    'The `/api/admin/rollout-readiness` endpoint reads the same reconciliation findings as the gate. These are blockers there: the endpoint answers HTTP 412 and `?allowWarnings=true` does NOT turn them into 200, because that override records no reason: an unresolved truncation, an unreadable completeness record, a run history that could not be evaluated, a newest-run read that failed, a newest run whose own report recorded a truncation, and a newest run that did not complete. **Changed behaviour:** a newest run with status PARTIAL used to be only a warning that `?allowWarnings=true` accepted; a PARTIAL or FAILED newest run (and any status the check does not recognise) is now a blocker, and only a COMPLETED run can ever clear an earlier truncation. Several runs created at the same instant are read together and judged as their worst member, and runs created at the same instant never clear each other\'s truncations, because their order cannot be proven.',
  ].join('\n'),
}

export const READINESS_GATE_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly ReadinessGateDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'usage', 'phases', 'acceptances', 'exit-codes', 'endpoint'] },
]

export function renderReadinessGateDocBlock(id: ReadinessGateDocBlockId): string {
  return `${READINESS_GATE_DOC_BLOCK_OPEN(id)}\n${READINESS_GATE_DOC_BLOCKS[id]}\n${READINESS_GATE_DOC_BLOCK_CLOSE(id)}`
}
