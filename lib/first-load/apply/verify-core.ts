/**
 * POST-RUN VERIFICATION, THE PURE PART: what the load must look like afterwards, decided from plain data.
 *
 * No database, no clock, no filesystem. `db/verify.ts` reads the database and hands the numbers here; every decision about "does this pass" is made in this file so a test can
 * drive it with a fabricated reading and so a mutation to any rule is caught without a database.
 *
 * WHAT A VERIFICATION ITEM MAY SAY. `expected` and `actual` are closed words and counts. Never a SKU, a supplier, a reference, a warehouse code, a quantity or an amount from the
 * prepared files (problem text reaches logs). A table name is a schema name, not data, and may be named. A failing stock total says how many totals differ, not what they are:
 * the operator reads the numbers from the database with the query in docs/first-load-apply.md.
 *
 * COARSENESS RULE. Nothing here compares through a value coarser than what is stored: stock quantities and values are compared as exact decimals (tolerance zero), row counts as
 * integers, and the census compares an exact `count(*)` of every table (not a statistics counter and not a fixed list of tables).
 */
import { D, type Dec } from '../money'
import { STEP_TARGET } from './constants'
import type { StepResult, VerificationItem } from './orchestrate'
import type { PreparedRun } from './prepared'
import { tablesOfKind } from './table-classes'

/** The ids of the verification items, a closed list: the report, the gate and the document name each one. */
export const VERIFICATION_IDS = [
  'accounting-identity',
  'row-chain-to-prepared-report',
  'final-readback',
  'rails-after-load',
  'stock-totals',
  'opening-movements',
  'stock-levels-equal-layers',
  'invariants',
  'bom-recipe-drift',
  'purchase-orders-draft',
  'base-currency',
  'migrations-applied',
  'outbound-held',
  'no-held-writes',
  'no-queue-growth',
  'census-baseline',
  'write-census',
] as const
export type VerificationId = (typeof VERIFICATION_IDS)[number]

/** What each item checks, in one sentence each: the document's table is compared with this, row for row. */
export const VERIFICATION_MEANING: Readonly<Record<VerificationId, string>> = {
  'accounting-identity': 'In every step, emitted = created + skipped (existing); nothing was updated, failed or left in conflict.',
  'row-chain-to-prepared-report': "In every step, the rows of the units are all of the prepared file's rows, the units are what the step emitted, and the file's row count is the one the prepared report planned: the tool's accounting continues into the runner's with no row in between.",
  'final-readback': 'The database is read again from scratch at the end and every unit of every selected step is present and matching, with no row nobody in this run emitted. The step results are not trusted.',
  'rails-after-load': 'The rails (nobody else connected, no data class holding a row it must not, warehouses and base currency as declared, every row of a table the runner writes attributable to the files) hold over the finished load.',
  'stock-totals': 'Opening-layer quantity and value equal the file per warehouse and the prepared report in total, exactly (tolerance zero), and no other layer exists.',
  'opening-movements': 'There is one opening movement per opening layer, their quantity equals the file, and no movement of another type exists.',
  'stock-levels-equal-layers': 'Every stock level equals the sum of the remaining quantity of its layers, and nothing is reserved. A level without a layer, or a layer without a level, is a difference.',
  invariants: 'The application\'s own scheduled invariant check, run in process and writing nothing, completes with no critical finding.',
  'bom-recipe-drift': 'ProductComponent and the manufacturing BOM agree for every BOM product.',
  'purchase-orders-draft': 'Every loaded purchase order is a draft, and there are as many as the file has.',
  'base-currency': 'The base currency is locked, is GBP and is the manifest\'s.',
  'migrations-applied': 'Every migration of this checkout is recorded and finished, and none is rolled back.',
  'outbound-held': 'The outbound-write status, evaluated against the installation\'s environment (this process\'s, which is the env file\'s variables on a whitelist), exits 0 under --expect-held: no grant, none unreadable, nothing queued or live.',
  'no-held-writes': 'The number of refused outbound writes in the activity log equals its number at the start of the load (a count, not a time window).',
  'no-queue-growth': 'The outbound queue, the accounting sync log, the warehouse job queue and the email queue hold the rows they held at the start.',
  'census-baseline': 'The starting counts were recorded on the run record before the first importer call.',
  'write-census': 'Comparing an exact row count of every base table now with the starting counts, only tables the runner writes changed; any other changed table (or a table that appeared or vanished) is named.',
}

/** Tables whose growth would mean a connector effect leaked out of the system actor's switch. They are named separately from the census so a failure says what it means. */
export const QUEUE_TABLES = ['integration_outbox', 'accounting_sync_logs', 'wms_sync_jobs', 'email_outbox'] as const

/**
 * The tables a load may change, single-sourced from the table registry: exactly the RUNNER_WRITES class. Every other table that changes is RED and named.
 * (The registry is itself checked against the schema, so a new table cannot be silently allowed.)
 */
export function expectedWrittenTables(): ReadonlySet<string> {
  return new Set(tablesOfKind('RUNNER_WRITES'))
}

export const item = (id: VerificationId, ok: boolean, expected: string, actual: string): VerificationItem => ({ id, result: ok ? 'pass' : 'fail', expected, actual })

// ---------------------------------------------------------------------------
// The baseline: taken once, before any importer call, recorded on the run record
// ---------------------------------------------------------------------------

export interface Baseline {
  /** Exact row count of every base table of the schema, by table name. */
  tables: Record<string, number>
  /** Rows of the activity log whose action is the outbound hold's refusal. */
  heldWrites: number
}

export function parseBaseline(raw: unknown): Baseline | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.tables !== 'object' || r.tables === null || Array.isArray(r.tables)) return null
  const tables: Record<string, number> = {}
  for (const [name, n] of Object.entries(r.tables as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null
    tables[name] = n
  }
  if (Object.keys(tables).length === 0) return null
  if (typeof r.heldWrites !== 'number' || !Number.isSafeInteger(r.heldWrites) || r.heldWrites < 0) return null
  return { tables, heldWrites: r.heldWrites }
}

export interface Reading {
  tables: Record<string, number>
  heldWrites: number
}

/** The census: every table whose exact count changed, a table that appeared or vanished counted as changed. Sorted. */
export function changedTables(baseline: Baseline, now: Reading): string[] {
  const names = new Set([...Object.keys(baseline.tables), ...Object.keys(now.tables)])
  return [...names].filter((name) => baseline.tables[name] !== now.tables[name]).sort()
}

export function censusItems(baseline: Baseline | null, now: Reading): VerificationItem[] {
  if (baseline === null) {
    // Fail closed: without the starting counts nothing can be said about what changed. A load begun before the baseline existed cannot be census-verified.
    return [
      item('census-baseline', false, 'recorded before the first write', 'missing or unreadable'),
      item('no-held-writes', false, 'compared with the baseline', 'no baseline'),
      item('no-queue-growth', false, 'compared with the baseline', 'no baseline'),
      item('write-census', false, 'compared with the baseline', 'no baseline'),
    ]
  }
  const changed = changedTables(baseline, now)
  const allowed = expectedWrittenTables()
  const unexpected = changed.filter((name) => !allowed.has(name))
  const queueGrew = QUEUE_TABLES.filter((name) => baseline.tables[name] !== now.tables[name])
  return [
    item('census-baseline', true, 'recorded before the first write', `recorded for ${Object.keys(baseline.tables).length} table(s)`),
    item('no-held-writes', now.heldWrites === baseline.heldWrites, 'no new refused outbound write', `${now.heldWrites - baseline.heldWrites} new`),
    item('no-queue-growth', queueGrew.length === 0, 'outbox, accounting sync, warehouse job and email queues unchanged', queueGrew.length === 0 ? 'unchanged' : `changed: ${queueGrew.join(', ')}`),
    item('write-census', unexpected.length === 0, 'only the tables the runner writes changed', unexpected.length === 0 ? `${changed.length} table(s) changed, all expected` : `${unexpected.length} unexpected: ${unexpected.join(', ')}`),
  ]
}

// ---------------------------------------------------------------------------
// The file's own accounting
// ---------------------------------------------------------------------------

/** The identity per step, restated from the results, and that nothing was updated, failed or conflicted. */
export function accountingItem(steps: readonly StepResult[]): VerificationItem {
  const bad = steps.filter((s) => s.emitted !== s.created + s.updated + s.skippedExisting + s.failed || s.updated !== 0 || s.failed !== 0 || s.conflicts.length > 0)
  return item('accounting-identity', bad.length === 0 && steps.length > 0, 'emitted = created + skipped, nothing updated, failed or in conflict, in every step', bad.length === 0 ? `holds for ${steps.length} step(s)` : `${bad.length} step(s) differ`)
}

/**
 * The chain to the tool: for every selected step, the rows of its units are all of the prepared file's rows, the units are what the step emitted, and the file's row count is
 * the one the prepared report planned for that target. So `read = emitted + excluded + rejected` (the tool's) continues into `emitted = created + skipped + failed` (the runner's)
 * with no row in between.
 */
export function chainItem(prepared: PreparedRun, steps: readonly StepResult[]): VerificationItem {
  let broken = 0
  const planned = (prepared.report as unknown as { plannedOutputRows?: Record<string, unknown> }).plannedOutputRows ?? {}
  for (const step of prepared.steps) {
    const rowsOfUnits = step.units.reduce((total, u) => total + u.rowIndexes.length, 0)
    const result = steps.find((s) => s.step === step.step)
    const fileRows = step.files.reduce((total, f) => total + f.rows, 0)
    if (rowsOfUnits !== step.data.rows.length || fileRows !== step.data.rows.length || planned[STEP_TARGET[step.step]] !== step.data.rows.length || result === undefined || result.emitted !== step.units.length) broken++
  }
  return item('row-chain-to-prepared-report', broken === 0 && prepared.steps.length > 0, "every unit's rows are the prepared file's rows, and the file's rows are the prepared report's planned rows", broken === 0 ? `holds for ${prepared.steps.length} step(s)` : `${broken} step(s) break the chain`)
}

// ---------------------------------------------------------------------------
// Stock: exact totals
// ---------------------------------------------------------------------------

export interface StockTotals {
  qty: Dec
  value: Dec
}

/** What the opening-stock file says per UPPER warehouse code, summed exactly. */
export function fileStockTotals(prepared: PreparedRun): Map<string, StockTotals> {
  const out = new Map<string, StockTotals>()
  const step = prepared.steps.find((s) => s.step === 'opening-stock')
  if (!step) return out
  const col = (name: string) => step.data.header.indexOf(name)
  const [warehouse, qty, cost] = [col('warehouseCode'), col('qty'), col('unitCostBase')]
  for (const row of step.data.rows) {
    const code = (row.cells[warehouse] ?? '').trim().toUpperCase()
    const q = new D((row.cells[qty] ?? '0').trim() || '0')
    const c = new D((row.cells[cost] ?? '0').trim() || '0')
    const had = out.get(code) ?? { qty: new D(0), value: new D(0) }
    out.set(code, { qty: had.qty.add(q), value: had.value.add(q.mul(c)) })
  }
  return out
}

/**
 * The opening layers in the database against the file, per warehouse and in total, tolerance ZERO (the same numbers pass through, so any difference is a defect).
 * `report` is the prepared report's collapsed total, the tool's own figure; the database must equal it too.
 */
export function stockTotalsItem(args: { file: ReadonlyMap<string, StockTotals>; database: ReadonlyMap<string, StockTotals>; report: { qty: string; value: string } | null; nonOpeningLayers: number }): VerificationItem {
  let differ = 0
  const codes = new Set([...args.file.keys(), ...args.database.keys()])
  for (const code of codes) {
    const f = args.file.get(code)
    const d = args.database.get(code)
    if (!f || !d || !f.qty.eq(d.qty) || !f.value.eq(d.value)) differ++
  }
  const sum = (m: ReadonlyMap<string, StockTotals>): StockTotals => [...m.values()].reduce((t, v) => ({ qty: t.qty.add(v.qty), value: t.value.add(v.value) }), { qty: new D(0), value: new D(0) })
  const total = sum(args.database)
  if (args.report === null) differ++
  else if (!total.qty.eq(new D(args.report.qty)) || !total.value.eq(new D(args.report.value))) differ++
  if (args.nonOpeningLayers !== 0) differ++
  return item('stock-totals', differ === 0, 'opening-layer quantity and value equal the file per warehouse and the prepared report in total, exactly; no other layer', differ === 0 ? `equal for ${codes.size} warehouse total(s)` : `${differ} total(s) differ`)
}
