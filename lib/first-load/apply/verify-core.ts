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
import { sha256Hex } from '../snapshot'
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
  'accounting-identity': "In every step the result rows are exactly the prepared units (each key once, none missing or extra), each created or already there; emitted = created + skipped (existing); nothing updated, failed or in conflict.",
  'row-chain-to-prepared-report': "In every step the units' rows are a permutation of the prepared file's rows (each row in exactly one unit), the units are what the step emitted, and the file's row count is the one the prepared report planned.",
  'final-readback': 'The database is read again from scratch at the end and every unit of every selected step is present and matching by its own key and fingerprint, with no row nobody in this run emitted. The step results are not trusted.',
  'rails-after-load': 'The rails (nobody else connected, no data class holding a row it must not, warehouses and base currency as declared, every row of a table the runner writes attributable to the files) hold over the finished load.',
  'stock-totals': 'Every opening layer equals its own file record (SKU and warehouse): received quantity and unit cost exactly, nothing consumed; the stored keys are exactly the file\'s; the sums equal the prepared report; no other layer exists.',
  'opening-movements': 'Each file record has exactly one opening movement, linked to exactly one layer of the same SKU and warehouse, and the movement\'s quantity, unit cost and value equal the file\'s and the layer\'s exactly; the movement leaves no warehouse and no movement of another type exists.',
  'stock-levels-equal-layers': 'For every SKU and warehouse pair the stock level equals the sum of the remaining quantity of that pair\'s layers, and nothing is reserved. A level without a layer, or a layer without a level, is a difference.',
  invariants: 'The application\'s own scheduled invariant check, run in process and writing nothing, completes with no critical finding.',
  'bom-recipe-drift': 'ProductComponent and the manufacturing BOM agree for every BOM product (the application\'s own per-product drift report is empty).',
  'purchase-orders-draft': 'The stored purchase orders are exactly the file\'s, by reference (each once, none missing or extra), and each is a draft.',
  'base-currency': 'The base currency is locked, is GBP and is the manifest\'s.',
  'migrations-applied': 'The migration table holds exactly the checkout\'s migrations, by name and in applied order, each finished and none rolled back, with no duplicate. Differences are reported as closed codes and counts (MIGRATIONS_MISSING, EXTRA, DUPLICATE, UNFINISHED, ROLLED_BACK, OUT_OF_ORDER).',
  'outbound-held': 'The outbound-write status, evaluated against the installation\'s environment (this process\'s, which is the env file\'s variables on a whitelist), exits 0 under --expect-held: no grant, none unreadable, nothing queued or live.',
  'no-held-writes': 'The refused outbound writes in the activity log are the same rows, by id, as at the start of the load (a set, not a count and not a time window); too many to list at the start or now is a failure.',
  'no-queue-growth': 'The outbound queue, the accounting sync log, the warehouse job queue and the email queue hold the same content as at the start (a digest of every row, so a row replaced by another is seen with the count unchanged).',
  'census-baseline': 'The starting state (a count of every table, a content digest of every table the runner does not write, and the refused-write ids) was recorded on the run record before the first importer call.',
  'write-census': 'Against that starting state, only tables the runner writes changed: any other table whose count OR content digest changed (or that appeared or vanished) is named.',
}

// ---------------------------------------------------------------------------
// Migrations: identity, not a count
// ---------------------------------------------------------------------------

export interface MigrationRow {
  name: string
  finished: boolean
  rolledBack: boolean
}

/** The identity of a schema: the hash of the ordered list of migration names. Two checkouts or databases with the same count and another name differ. */
export function migrationsHash(names: readonly string[]): string {
  return sha256Hex(new TextEncoder().encode(names.join('\n')))
}

/**
 * The target's migration table against the checkout's EXACT ordered list. `rows` are in the order they were applied. Every difference is a closed code and a count (never a name):
 * MIGRATIONS_MISSING, MIGRATIONS_EXTRA, MIGRATIONS_DUPLICATE, MIGRATIONS_UNFINISHED, MIGRATIONS_ROLLED_BACK, MIGRATIONS_OUT_OF_ORDER. Empty means identical. Used by the precondition
 * before any write AND by the `migrations-applied` item: one function, so the two cannot disagree.
 */
export function compareMigrations(expected: readonly string[], rows: readonly MigrationRow[]): string[] {
  const want = new Set(expected)
  const seen = new Map<string, number>()
  for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1)
  const problems: string[] = []
  const missing = expected.filter((n) => !seen.has(n)).length
  const extra = [...seen.keys()].filter((n) => !want.has(n)).length
  const duplicate = [...seen.values()].filter((n) => n > 1).length
  const unfinished = rows.filter((r) => !r.finished).length
  const rolledBack = rows.filter((r) => r.rolledBack).length
  if (missing > 0) problems.push(`MIGRATIONS_MISSING x${missing}`)
  if (extra > 0) problems.push(`MIGRATIONS_EXTRA x${extra}`)
  if (duplicate > 0) problems.push(`MIGRATIONS_DUPLICATE x${duplicate}`)
  if (unfinished > 0) problems.push(`MIGRATIONS_UNFINISHED x${unfinished}`)
  if (rolledBack > 0) problems.push(`MIGRATIONS_ROLLED_BACK x${rolledBack}`)
  if (problems.length === 0 && rows.some((r, i) => r.name !== expected[i])) problems.push('MIGRATIONS_OUT_OF_ORDER x1')
  return problems
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

export const HELD_IDS_CAP = 5000
const TABLE_NAME = /^[A-Za-z0-9_]{1,63}$/

export interface Baseline {
  /** Exact row count of every base table of the schema, by table name. */
  tables: Record<string, number>
  /** A digest of the CONTENT of every table the runner does not write (md5 over its sorted rows), so a row replaced by another, or changed in place, is seen with the count unchanged. */
  digests: Record<string, string>
  /** The ids of the activity-log rows that record a refused outbound write; null when there were more than HELD_IDS_CAP (then nothing can be proved and the item fails). */
  heldIds: string[] | null
}

export function parseBaseline(raw: unknown): Baseline | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.tables !== 'object' || r.tables === null || Array.isArray(r.tables)) return null
  const tables: Record<string, number> = {}
  for (const [name, n] of Object.entries(r.tables as Record<string, unknown>)) {
    // A table name reaches problem text, so a baseline that holds anything but a plain schema name is no baseline.
    if (!TABLE_NAME.test(name) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null
    tables[name] = n
  }
  if (Object.keys(tables).length === 0) return null
  if (typeof r.digests !== 'object' || r.digests === null || Array.isArray(r.digests)) return null
  const digests: Record<string, string> = {}
  for (const [name, d] of Object.entries(r.digests as Record<string, unknown>)) {
    if (!TABLE_NAME.test(name) || typeof d !== 'string' || !/^[0-9a-f]{32}$/.test(d)) return null
    digests[name] = d
  }
  let heldIds: string[] | null = null
  if (r.heldIds !== null) {
    if (!Array.isArray(r.heldIds) || r.heldIds.length > HELD_IDS_CAP || r.heldIds.some((x) => typeof x !== 'string')) return null
    heldIds = [...(r.heldIds as string[])].sort()
  }
  return { tables, digests, heldIds }
}

export type Reading = Baseline

/** Every table whose exact count changed; a table that appeared or vanished counts as changed. Sorted. */
export function changedTables(baseline: Baseline, now: Reading): string[] {
  const names = new Set([...Object.keys(baseline.tables), ...Object.keys(now.tables)])
  return [...names].filter((name) => baseline.tables[name] !== now.tables[name]).sort()
}

/** Every table (of those the runner does not write) whose CONTENT digest changed or that gained or lost its digest. Sorted. */
export function changedContent(baseline: Baseline, now: Reading): string[] {
  const names = new Set([...Object.keys(baseline.digests), ...Object.keys(now.digests)])
  return [...names].filter((name) => baseline.digests[name] !== now.digests[name]).sort()
}

export function censusItems(baseline: Baseline | null, now: Reading): VerificationItem[] {
  if (baseline === null) {
    // Fail closed: without the starting state nothing can be said about what changed. A load begun before the baseline existed cannot be census-verified.
    return [
      item('census-baseline', false, 'recorded before the first write', 'missing or unreadable'),
      item('no-held-writes', false, 'compared with the baseline', 'no baseline'),
      item('no-queue-growth', false, 'compared with the baseline', 'no baseline'),
      item('write-census', false, 'compared with the baseline', 'no baseline'),
    ]
  }
  const allowed = expectedWrittenTables()
  const changed = [...new Set([...changedTables(baseline, now), ...changedContent(baseline, now)])].sort()
  const unexpected = changed.filter((name) => !allowed.has(name))
  const queueChanged = QUEUE_TABLES.filter((name) => baseline.tables[name] !== now.tables[name] || baseline.digests[name] !== now.digests[name] || baseline.digests[name] === undefined)
  // The refused outbound writes by ID: the same count with another row is a different set.
  let heldOk = false
  let heldActual = 'cannot be proved (too many to list at the start or now)'
  if (baseline.heldIds !== null && now.heldIds !== null) {
    const before = new Set(baseline.heldIds)
    const added = now.heldIds.filter((id) => !before.has(id)).length
    const nowSet = new Set(now.heldIds)
    const removed = baseline.heldIds.filter((id) => !nowSet.has(id)).length
    heldOk = added === 0 && removed === 0
    heldActual = heldOk ? `the same ${now.heldIds.length} row(s)` : `${added} new, ${removed} gone`
  }
  return [
    item('census-baseline', true, 'recorded before the first write', `recorded for ${Object.keys(baseline.tables).length} table(s), ${Object.keys(baseline.digests).length} with a content digest`),
    item('no-held-writes', heldOk, 'the same refused outbound writes, by id', heldActual),
    item('no-queue-growth', queueChanged.length === 0, 'outbox, accounting sync, warehouse job and email queues unchanged in content', queueChanged.length === 0 ? 'unchanged' : `changed: ${queueChanged.join(', ')}`),
    item('write-census', unexpected.length === 0, 'only the tables the runner writes changed, in count or in content', unexpected.length === 0 ? `${changed.length} table(s) changed, all expected` : `${unexpected.length} unexpected: ${unexpected.join(', ')}`),
  ]
}

// ---------------------------------------------------------------------------
// The file's own accounting
// ---------------------------------------------------------------------------

const GOOD_ROW_OUTCOMES = new Set(['created', 'skipped-existing', 'would-skip-existing'])

/**
 * The identity per step, restated from the results AND from the units themselves: the counts hold, nothing was updated, failed or left in conflict, and the step's rows are EXACTLY the
 * prepared units (each key once, none missing, none extra), every one created or already there. Equal counts over different keys do not pass.
 */
export function accountingItem(prepared: PreparedRun, steps: readonly StepResult[]): VerificationItem {
  let bad = 0
  for (const step of prepared.steps) {
    const r = steps.find((s) => s.step === step.step)
    const keys = new Set(step.units.map((u) => u.key))
    const rowKeys = r ? r.rows.map((row) => row.key) : []
    const exact = r !== undefined && rowKeys.length === keys.size && new Set(rowKeys).size === keys.size && rowKeys.every((k) => keys.has(k)) && r.rows.every((row) => GOOD_ROW_OUTCOMES.has(row.outcome))
    if (!r || !exact || r.emitted !== r.created + r.updated + r.skippedExisting + r.failed || r.updated !== 0 || r.failed !== 0 || r.conflicts.length > 0 || r.emitted !== keys.size) bad++
  }
  const extra = steps.filter((s) => !prepared.steps.some((p) => p.step === s.step)).length
  const ok = bad === 0 && extra === 0 && prepared.steps.length > 0
  return item('accounting-identity', ok, "in every step the rows are exactly the prepared units, each created or already there; emitted = created + skipped; nothing updated, failed or in conflict", ok ? `holds for ${prepared.steps.length} step(s)` : `${bad + extra} step(s) differ`)
}

/**
 * The chain to the tool: for every selected step, the rows of its units are EXACTLY the prepared file's rows (each row index once, none missing: a permutation, not a matching count),
 * the units are what the step emitted, and the file's row count is the one the prepared report planned for that target.
 */
export function chainItem(prepared: PreparedRun, steps: readonly StepResult[]): VerificationItem {
  let broken = 0
  const planned = (prepared.report as unknown as { plannedOutputRows?: Record<string, unknown> }).plannedOutputRows ?? {}
  for (const step of prepared.steps) {
    const indexes = step.units.flatMap((u) => u.rowIndexes).sort((a, b) => a - b)
    const permutation = indexes.length === step.data.rows.length && indexes.every((n, i) => n === i)
    const result = steps.find((s) => s.step === step.step)
    const fileRows = step.files.reduce((total, f) => total + f.rows, 0)
    if (!permutation || fileRows !== step.data.rows.length || planned[STEP_TARGET[step.step]] !== step.data.rows.length || result === undefined || result.emitted !== step.units.length) broken++
  }
  const ok = broken === 0 && prepared.steps.length > 0
  return item('row-chain-to-prepared-report', ok, "every prepared row belongs to exactly one unit, and the file's rows are the prepared report's planned rows", ok ? `holds for ${prepared.steps.length} step(s)` : `${broken} step(s) break the chain`)
}

// ---------------------------------------------------------------------------
// Stock: per record, exactly
// ---------------------------------------------------------------------------

/** One opening-stock record the file asks for, keyed `UPPERSKU|UPPERWAREHOUSE`. */
export interface StockPair {
  qty: Dec
  cost: Dec
}

export function fileStockPairs(prepared: PreparedRun): Map<string, StockPair> {
  const out = new Map<string, StockPair>()
  const step = prepared.steps.find((s) => s.step === 'opening-stock')
  if (!step) return out
  const col = (name: string) => step.data.header.indexOf(name)
  const [sku, warehouse, qty, cost] = [col('sku'), col('warehouseCode'), col('qty'), col('unitCostBase')]
  for (const row of step.data.rows) {
    const key = `${(row.cells[sku] ?? '').trim().toUpperCase()}|${(row.cells[warehouse] ?? '').trim().toUpperCase()}`
    out.set(key, { qty: new D((row.cells[qty] ?? '0').trim() || '0'), cost: new D((row.cells[cost] ?? '0').trim() || '0') })
  }
  return out
}

export interface StoredLayer {
  key: string
  received: Dec
  remaining: Dec
  cost: Dec
}

/**
 * The opening layers against the file PER PAIR: the stored keys are exactly the file's keys (each once), and for every pair the received quantity and the unit cost equal the file's and
 * nothing has been consumed. Then the tool's collapsed total, which the sums must equal. A total that matches while two pairs swapped their quantities fails here.
 */
export function stockTotalsItem(args: { file: ReadonlyMap<string, StockPair>; layers: readonly StoredLayer[]; report: { qty: string; value: string } | null; nonOpeningLayers: number }): VerificationItem {
  let differ = 0
  const byKey = new Map<string, StoredLayer[]>()
  for (const l of args.layers) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l])
  for (const key of new Set([...args.file.keys(), ...byKey.keys()])) {
    const want = args.file.get(key)
    const have = byKey.get(key) ?? []
    if (!want || have.length !== 1 || !have[0]!.received.eq(want.qty) || !have[0]!.cost.eq(want.cost) || !have[0]!.remaining.eq(want.qty)) differ++
  }
  const qty = args.layers.reduce((t, l) => t.add(l.received), new D(0))
  const value = args.layers.reduce((t, l) => t.add(l.received.mul(l.cost)), new D(0))
  if (args.report === null || !qty.eq(new D(args.report.qty)) || !value.eq(new D(args.report.value))) differ++
  if (args.nonOpeningLayers !== 0) differ++
  return item('stock-totals', differ === 0, 'each opening layer equals its file record exactly (quantity, cost, nothing consumed), the keys are exactly the file\'s, the sums equal the prepared report, and no other layer exists', differ === 0 ? `equal for ${args.file.size} record(s)` : `${differ} record(s) or total(s) differ`)
}

export interface StoredMovement {
  id: string
  key: string
  qty: Dec
  cost: Dec | null
  total: Dec | null
  /** Movement leaves a warehouse (it must not). */
  fromWarehouse: boolean
  /** The layers whose adjustment-movement link is this movement. */
  layers: Array<{ key: string; received: Dec; cost: Dec }>
}

/**
 * Each opening movement PAIRED with its layer by identity: exactly one movement per file record (by SKU and warehouse), linked (the link the apply writes) to exactly one layer of the SAME
 * pair, and the movement's quantity, unit cost and value equal the file's and the layer's, exactly. Counts and sums that match while records are exchanged fail.
 */
export function openingMovementsItem(args: { file: ReadonlyMap<string, StockPair>; movements: readonly StoredMovement[]; otherTypes: number }): VerificationItem {
  let differ = 0
  const byKey = new Map<string, StoredMovement[]>()
  for (const m of args.movements) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m])
  for (const key of new Set([...args.file.keys(), ...byKey.keys()])) {
    const want = args.file.get(key)
    const have = byKey.get(key) ?? []
    if (!want || have.length !== 1) { differ++; continue }
    const m = have[0]!
    const layer = m.layers.length === 1 ? m.layers[0]! : null
    const value = want.qty.mul(want.cost).toDecimalPlaces(6)
    const ok = layer !== null && layer.key === key && layer.received.eq(want.qty) && layer.cost.eq(want.cost)
      && m.qty.eq(want.qty) && m.cost !== null && m.cost.eq(want.cost) && m.total !== null && m.total.eq(value) && !m.fromWarehouse
    if (!ok) differ++
  }
  if (args.otherTypes !== 0) differ++
  return item('opening-movements', differ === 0, "one opening movement per file record, linked to its own layer, equal to the file in quantity, cost and value; no other movement", differ === 0 ? `${args.file.size} paired movement(s)` : `${differ} record(s) differ`)
}

/** The purchase orders by reference: exactly the file's orders, each a draft. */
export function purchaseOrdersItem(args: { references: readonly string[]; stored: ReadonlyArray<{ reference: string; status: string }> }): VerificationItem {
  const want = new Set(args.references)
  const seen = new Set<string>()
  let differ = 0
  for (const po of args.stored) {
    if (!want.has(po.reference) || seen.has(po.reference) || po.status !== 'DRAFT') differ++
    seen.add(po.reference)
  }
  differ += [...want].filter((r) => !seen.has(r)).length
  return item('purchase-orders-draft', differ === 0, 'the stored orders are exactly the file\'s, by reference, each a draft', differ === 0 ? `${want.size} draft order(s)` : `${differ} order(s) differ`)
}
