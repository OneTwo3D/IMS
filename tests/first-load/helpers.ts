import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { serializeCsv } from '../../lib/first-load/csv.ts'
import { ingestDataset, parseColumnMap, type ColumnMap, type IngestedDataset } from '../../lib/first-load/ingest.ts'
import { DATASETS, type DatasetName } from '../../lib/first-load/spec.ts'
import { prepare, type PrepareConfig, type PrepareResult } from '../../lib/first-load/transform.ts'

/** A canonical dataset built in memory. `rows` are objects keyed by canonical column; omitted columns are blank. */
export function ds(name: DatasetName, rows: Array<Record<string, string>>, file = `${name}.csv`): IngestedDataset {
  const spec = DATASETS[name]
  const header = spec.columns.filter((column) => spec.required.includes(column) || rows.some((row) => column in row))
  const text = serializeCsv(header, rows.map((row) => header.map((column) => row[column] ?? '')))
  return ingestDataset(name, new TextEncoder().encode(text), file, null)
}

export function config(overrides: Partial<PrepareConfig> = {}): PrepareConfig {
  return {
    runId: 'test',
    baseCurrency: 'GBP',
    asOf: '2026-10-01',
    inTransitConvention: 'counted-in-source',
    purchaseOrderKeyPrefix: 'T-',
    transferKeyPrefix: 'T-',
    maxPurchaseTaxRate: '0.25',
    ...overrides,
  }
}

export function run(datasets: Partial<Record<DatasetName, IngestedDataset>>, overrides: Partial<PrepareConfig> = {}): PrepareResult {
  return prepare({ config: config(overrides), datasets })
}

export function product(sku: string, type = 'SIMPLE', extra: Record<string, string> = {}): Record<string, string> {
  return { sku, name: `Name of ${sku}`, type, ...extra }
}

export function lot(sku: string, qty: string, unitCost: string, extra: Record<string, string> = {}): Record<string, string> {
  return { sku, warehouseCode: 'MAIN', qty, unitCost, currency: 'GBP', ...extra }
}

/** Every arm prints how many cases it examined and fails when it examined none. */
export function precondition(t: TestContext, label: string, count: number): void {
  t.diagnostic(`precondition: ${label} = ${count}`)
  assert.ok(count > 0, `precondition not reached: ${label} is ${count}`)
}

export function rowsOf(result: PrepareResult, target: string): Array<Record<string, string>> {
  const files = result.outputs.filter((file) => file.target === target).sort((a, b) => a.chunk - b.chunk)
  const out: Array<Record<string, string>> = []
  for (const file of files) {
    const lines = file.content.split('\r\n').filter((line) => line !== '')
    const header = lines[0].split(',')
    for (const line of lines.slice(1)) {
      // The fixtures used with this helper never contain quoted commas in the columns it reads.
      const cells = line.split(',')
      out.push(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])))
    }
  }
  return out
}

export function findingCodes(result: PrepareResult, severity?: string): string[] {
  return result.report.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code)
}

export function dispositionCodes(result: PrepareResult, dataset: string, outcome: string): string[] {
  return result.report.dispositions.filter((d) => d.dataset === dataset && d.outcome === outcome).map((d) => d.code)
}

// ---------------------------------------------------------------------------
// Loading the synthetic fixture the way the CLI does
// ---------------------------------------------------------------------------
export const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'first-load', 'fixtures')

export interface FixtureManifest {
  inputs: Array<{ dataset: DatasetName; file: string; columnMap?: string }>
  [key: string]: unknown
}

export function loadFixtureDatasets(
  dir = FIXTURE_DIR,
  transformText: (dataset: DatasetName, text: string) => string = (_name, text) => text,
): Partial<Record<DatasetName, IngestedDataset>> {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as FixtureManifest
  const maps = new Map<string, ColumnMap>()
  const out: Partial<Record<DatasetName, IngestedDataset>> = {}
  for (const input of manifest.inputs) {
    let mapping = null
    if (input.columnMap) {
      if (!maps.has(input.columnMap)) maps.set(input.columnMap, parseColumnMap(readFileSync(path.join(dir, input.columnMap), 'utf8'), input.columnMap))
      mapping = maps.get(input.columnMap)!.datasets[input.dataset] ?? null
    }
    const text = transformText(input.dataset, readFileSync(path.join(dir, input.file), 'utf8'))
    out[input.dataset] = ingestDataset(input.dataset, new TextEncoder().encode(text), input.file, mapping)
  }
  return out
}

/** Deterministic PRNG so a "shuffled" run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Shuffles the data lines of a CSV text (header stays first). Fixture files have no embedded newlines. */
export function shuffleCsvText(text: string, seed: number): string {
  const lines = text.split('\n').filter((line) => line !== '')
  const [header, ...data] = lines
  const random = mulberry32(seed)
  for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[data[i], data[j]] = [data[j], data[i]]
  }
  return [header, ...data].join('\n') + '\n'
}
