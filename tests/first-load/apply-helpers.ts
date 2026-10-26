/**
 * Fixtures for the apply-runner tests. A "prepared run" here is the REAL output of `prepare()` over synthetic datasets (invented SKUs,
 * suppliers and warehouses), rendered the way the command writes it, so the runner is tested against the tool's own bytes and not against
 * a hand-made imitation of them. Nothing here reads real data.
 */
import { renderJson } from '../../lib/first-load/report.ts'
import { canonicalJson, sha256Hex } from '../../lib/first-load/snapshot.ts'
import { prepare, type PrepareResult } from '../../lib/first-load/transform.ts'
import { serializeCsv } from '../../lib/first-load/csv.ts'
import type { DatasetName } from '../../lib/first-load/spec.ts'
import type { IngestedDataset } from '../../lib/first-load/ingest.ts'
import { parseApplyManifest, type ApplyManifest } from '../../lib/first-load/apply/manifest.ts'
import { loadPreparedRun, type PreparedRun } from '../../lib/first-load/apply/prepared.ts'
import { parseCsvStrict } from '../../lib/first-load/csv.ts'
import { keyStep } from '../../lib/first-load/apply/keys.ts'
import { ObservationError, classifyStep, type ObservedEntry, type StepObservation } from '../../lib/first-load/apply/residual.ts'
import type { ApplyStepId } from '../../lib/first-load/apply/constants.ts'
import { type ApplyPorts, type RunRecord, type StepLock, StaleJournalError } from '../../lib/first-load/apply/orchestrate.ts'
import { config, ds, lot, product } from './helpers.ts'

/** Order references of the synthetic orders (named constants: an inline `orderKey: '...'` literal reads as a credential to the secret scanner). */
const PO_ONE = 'ZQSENT-PO-5001'
const PO_TWO = 'ZQSENT-PO-5002'

/** The lock handle for tests that run an executor or the in-memory ports without a real lock. */
export const NO_LOCK: StepLock = { assertLive: async () => undefined }

export type FileMap = Map<string, Uint8Array>

export const WAREHOUSES = {
  'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: false },
  'ZQSENT-OVER': { type: 'RESTOCK', availableForSale: false, syncToStore: false },
} as const

/** The synthetic catalogue: a variable product with two variants, three bundles/BOMs, a fee that is not stock tracked, stock in two warehouses, one zero-cost pair, two orders. */
export function syntheticDatasets(): Partial<Record<DatasetName, IngestedDataset>> {
  return {
    suppliers: ds('suppliers', [{ name: 'ZQSENT Timber Co', currency: 'GBP' }, { name: 'ZQSENT Cotton Ltd', currency: 'EUR' }]),
    products: ds('products', [
      product('ZQSENT-OAK-BOARD'),
      product('ZQSENT-TSHIRT', 'VARIABLE'),
      product('ZQSENT-TSHIRT-M', 'VARIANT', { parentSku: 'ZQSENT-TSHIRT' }),
      product('ZQSENT-TSHIRT-S', 'VARIANT', { parentSku: 'ZQSENT-TSHIRT' }),
      product('ZQSENT-LEG-01', 'BOM'),
      product('ZQSENT-TABLE-01', 'BOM'),
      product('ZQSENT-GIFT-SET', 'KIT'),
      product('ZQSENT-LICENCE-FEE', 'NON_INVENTORY'),
    ]),
    'recipe-lines': ds('recipe-lines', [
      { parentSku: 'ZQSENT-LEG-01', componentSku: 'ZQSENT-OAK-BOARD', qty: '0.5' },
      { parentSku: 'ZQSENT-TABLE-01', componentSku: 'ZQSENT-LEG-01', qty: '4' },
      { parentSku: 'ZQSENT-TABLE-01', componentSku: 'ZQSENT-OAK-BOARD', qty: '2' },
      { parentSku: 'ZQSENT-GIFT-SET', componentSku: 'ZQSENT-TSHIRT-S', qty: '1' },
      { parentSku: 'ZQSENT-GIFT-SET', componentSku: 'ZQSENT-OAK-BOARD', qty: '2' },
    ]),
    'stock-lots': ds('stock-lots', [
      lot('ZQSENT-OAK-BOARD', '60', '5.333333', { warehouseCode: 'ZQSENT-MAIN' }),
      lot('ZQSENT-OAK-BOARD', '5', '4.5', { warehouseCode: 'ZQSENT-OVER' }),
      lot('ZQSENT-LEG-01', '8', '12', { warehouseCode: 'ZQSENT-MAIN' }),
      lot('ZQSENT-TSHIRT-M', '3', '0', { warehouseCode: 'ZQSENT-MAIN' }),
    ]),
    'ims-fx-rates': ds('ims-fx-rates', [{ currency: 'EUR', rate: '1.25', fetchedAt: '2026-09-10T06:00:00Z' }]),
    'purchase-order-lines': ds('purchase-order-lines', [
      { orderKey: PO_ONE, supplierName: 'ZQSENT Timber Co', destinationWarehouseCode: 'ZQSENT-MAIN', sku: 'ZQSENT-OAK-BOARD', qtyOrdered: '60', qtyReceived: '0', unitCostForeign: '4.25' },
      { orderKey: PO_TWO, supplierName: 'ZQSENT Cotton Ltd', destinationWarehouseCode: 'ZQSENT-MAIN', sku: 'ZQSENT-TSHIRT-M', qtyOrdered: '20', qtyReceived: '0', unitCostForeign: '2.1' },
      { orderKey: PO_TWO, supplierName: 'ZQSENT Cotton Ltd', destinationWarehouseCode: 'ZQSENT-MAIN', sku: 'ZQSENT-TSHIRT-S', qtyOrdered: '30', qtyReceived: '0', unitCostForeign: '2.1' },
    ]),
  }
}

export function preparedFiles(result: PrepareResult): FileMap {
  const files: FileMap = new Map()
  for (const out of result.outputs) files.set(out.name, new TextEncoder().encode(out.content))
  files.set('validation-report.json', new TextEncoder().encode(renderJson(result.report)))
  return files
}

export function prepareSynthetic(datasets = syntheticDatasets()): PrepareResult {
  const result = prepare({ config: config({ purchaseOrderKeyPrefix: 'QBX-' }), datasets })
  if (result.blocking) throw new Error(`the synthetic run is blocked: ${JSON.stringify(result.report.findings.filter((f) => f.severity === 'ERROR').map((f) => f.code))}`)
  return result
}

export function manifestText(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    formatVersion: 1,
    runId: 'rehearsal-1',
    preparedDir: '/prepared',
    baseCurrency: 'GBP',
    steps: ['suppliers', 'products', 'opening-stock', 'purchase-orders'],
    expectWarehouses: WAREHOUSES,
    acceptZeroCost: ['ZQSENT-TSHIRT-M@ZQSENT-MAIN'],
    restorePointDir: '/restore',
  }
  const merged = { ...base, ...overrides }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return JSON.stringify(merged)
}

export function manifest(overrides: Record<string, unknown> = {}): ApplyManifest {
  return parseApplyManifest(manifestText(overrides))
}

/** Every fixture value (SKUs, supplier names, warehouse codes, order keys) carries this marker, so a problem that echoes a file value is caught. */
export const SENTINEL = /zqsent/i

export function load(files: FileMap, overrides: Record<string, unknown> = {}): ReturnType<typeof loadPreparedRun> {
  const loaded = loadPreparedRun({ manifest: manifest(overrides), files, woo: null })
  // UNIVERSAL: this runs for every refusal arm of every test that loads through here.
  if (!loaded.ok) for (const problem of loaded.problems) if (SENTINEL.test(problem)) throw new Error(`a problem echoes a prepared-file value: ${problem}`)
  loadedProblemCount += loaded.ok ? 0 : loaded.problems.length
  return loaded
}

/** How many problem strings the sentinel rule has examined in this process (a test prints it as its precondition). */
export let loadedProblemCount = 0

export function loadOk(files: FileMap, overrides: Record<string, unknown> = {}): PreparedRun {
  const loaded = load(files, overrides)
  if (!loaded.ok) throw new Error(`expected a loadable run: ${loaded.problems.join('; ')}`)
  return loaded.run
}

/** A copy of the file map with one file's text replaced (SHA and size in the report are NOT updated: that is the point of most arms). */
export function withFile(files: FileMap, name: string, edit: (text: string) => string): FileMap {
  const copy: FileMap = new Map(files)
  const before = new TextDecoder().decode(files.get(name)!)
  const after = edit(before)
  if (after === before) throw new Error(`the edit of ${name} changed nothing: the arm would be vacuous`)
  copy.set(name, new TextEncoder().encode(after))
  return copy
}

/** Edit an output file AND the report so the file still matches its recorded SHA-256, size and row count (isolates the check under test from the hash check). */
export function withConsistentFile(files: FileMap, name: string, edit: (text: string) => string): FileMap {
  const copy = withFile(files, name, edit)
  const report = JSON.parse(new TextDecoder().decode(files.get('validation-report.json')!))
  const entry = report.outputs.find((o: { name: string }) => o.name === name)!
  const bytes = copy.get(name)!
  entry.sha256 = sha256Hex(bytes)
  entry.bytes = bytes.length
  entry.rows = new TextDecoder().decode(bytes).split('\r\n').filter((l) => l !== '').length - 1
  report.plannedOutputRows[entry.target] = report.outputs.filter((o: { target: string }) => o.target === entry.target).reduce((t: number, o: { rows: number }) => t + o.rows, 0)
  copy.set('validation-report.json', new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`))
  return copy
}

/** The parts of a prepared report the arms edit. */
export interface EditableReport {
  verdict: string
  tool: string
  selfCheckFailures: string[]
  accountingBalanced: boolean
  accounting: Array<{ unaccounted: number }>
  findings: Array<{ severity: string; code: string; message?: string; keys?: string[] }>
  config: { baseCurrency: string }
  outputs: Array<{ name: string; target: string; chunk: number; chunks: number; rows: number; bytes: number; sha256: string }>
  plannedOutputRows: Record<string, number>
  warehouseCodesUsed: string[]
  stock: { totals: { openingQty: string; openingValueBase: string } }
  inputs: Array<{ dataset: string; sha256: string; parts: Array<{ sha256: string }> }>
}

export function withReport(files: FileMap, edit: (report: EditableReport) => void): FileMap {
  const copy: FileMap = new Map(files)
  const report = JSON.parse(new TextDecoder().decode(files.get('validation-report.json')!)) as EditableReport
  edit(report)
  copy.set('validation-report.json', new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`))
  return copy
}

export function problemsOf(files: FileMap, overrides: Record<string, unknown> = {}): string[] {
  const loaded = load(files, overrides)
  return loaded.ok ? [] : loaded.problems
}

export { canonicalJson, serializeCsv }

// ---------------------------------------------------------------------------
// An in-memory "database" and importer for the orchestration tests
// ---------------------------------------------------------------------------

/**
 * Behaves like the real importers where it matters: it loads the rows of the residual file it is handed and REFUSES a row whose key
 * already exists (skipped, as the opening-stock importer does). `failAfterRows` crashes the importer after that many rows are applied.
 * `dropRecipeFor` reproduces the silent-recipe-loss defect of the products importer: the product row is created and counted, but its recipe is silently not written.
 */
export class FakeDatabase {
  readonly entries = new Map<ApplyStepId, ObservedEntry[]>()
  foreignHistory: string[] = []
  unreadable = false
  failAfterRows: number | null = null
  dropRecipeFor = new Set<string>()
  executed: Array<{ step: ApplyStepId; file: string; rows: number; sha256: string }> = []
  journalRecord: RunRecord | null = null
  rails: string[] = []
  readsOf = new Map<ApplyStepId, number>()
  constructor(private readonly prepared: PreparedRun) {}

  seed(step: ApplyStepId, entry: ObservedEntry): void {
    this.entries.set(step, [...(this.entries.get(step) ?? []), entry])
  }

  observeNow(step: ApplyStepId): StepObservation {
    return { entries: [...(this.entries.get(step) ?? [])], foreignHistoryKeys: step === 'opening-stock' ? [...this.foreignHistory] : undefined }
  }

  ports(overrides: Partial<ApplyPorts> = {}): ApplyPorts {
    const prepared = this.prepared
    let applied = 0
    return {
      journal: {
        load: async () => (this.journalRecord === null ? null : structuredClone(this.journalRecord)),
        save: async (record, expected) => {
          const stored = this.journalRecord?.version ?? null
          if (stored !== expected) throw new StaleJournalError()
          this.journalRecord = structuredClone(record)
        },
      },
      observe: async (step) => {
        this.readsOf.set(step, (this.readsOf.get(step) ?? 0) + 1)
        if (this.unreadable) throw new ObservationError('connection refused')
        return this.observeNow(step)
      },
      withStepLock: async (_step, body) => body(NO_LOCK),
      // The verification slice is not built; the in-memory ports stand in for it with a verification that passes, so the arms below test the orchestration. Tests of the absent-port behaviour pass `verify: undefined`.
      verify: async () => [],
      recheckRails: async () => this.rails,
      execute: async (step, file) => {
        const ps = prepared.steps.find((s) => s.step === step)!
        // Read the residual file the way an importer would: parse it, and key its rows.
        const parsed = parseCsvStrict(new TextDecoder().decode(file.bytes))
        const keyed = keyStep(step, { header: parsed.header, rows: parsed.rows.map((r) => ({ chunk: 1, line: r.line, cells: r.cells })) })
        const byKey = new Map(ps.units.map((u) => [u.key, u]))
        this.executed.push({ step, file: file.name, rows: file.rows, sha256: file.sha256 })
        let created = 0
        let skipped = 0
        const errors: string[] = []
        for (const sent of keyed.units) {
          const unit = byKey.get(sent.key)!
          const present = (this.entries.get(step) ?? []).some((e) => e.key === unit.key)
          if (present) { skipped++; errors.push(`${unit.key} already exists`); continue }
          if (this.failAfterRows !== null && applied >= this.failAfterRows) throw new Error('simulated crash between row transactions')
          applied++
          created += unit.rowIndexes.length
          const recipe = this.dropRecipeFor.has(unit.key) ? null : unit.recipe
          this.seed(step, { key: unit.key, collisionKey: unit.collisionKey, fingerprint: unit.fingerprint, recipe })
        }
        return { created, updated: 0, skipped, errors }
      },
      ...overrides,
    }
  }
}

export function classify(prepared: PreparedRun, step: ApplyStepId, observation: StepObservation) {
  const s = prepared.steps.find((x) => x.step === step)!
  return classifyStep(step, s.units, observation)
}
