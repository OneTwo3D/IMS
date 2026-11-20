import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { gateLegacyExportPrices, LEGACY_EXPORT_PRICE_COLUMNS } from '@/lib/products/legacy-export-price-gate'
import { recordComponentRowFailure, type ComponentPassRow, type ImportCounters } from '@/lib/products/import-row-accounting'
import { createCsvImportExecutionResult, createCsvImportPreviewResult } from '@/lib/csv-import'
import { hasPermission, type Permission } from '@/lib/permissions'

const row = { sku: 'A', salesPriceBase: '9.99', salePriceBase: '7.99', salesPriceTaxInclusive: 'TRUE', inventoryValue: '1.00' }

test('legacy product export blanks price columns without inventory.prices, keeping the columns (o3d-1plf9)', () => {
  for (const role of ['WAREHOUSE', 'READONLY']) {
    assert.equal(hasPermission(role, 'inventory.prices'), false, role)
    const [out] = gateLegacyExportPrices([row], (p: Permission) => hasPermission(role, p))
    for (const column of LEGACY_EXPORT_PRICE_COLUMNS) assert.equal(out![column], '', `${role} ${column}`)
    assert.equal(out!.sku, 'A')
    assert.deepEqual(Object.keys(out!), Object.keys(row))
  }
  assert.equal(row.salesPriceBase, '9.99', 'input rows are not mutated')
})

test('legacy product export keeps prices for roles with inventory.prices (o3d-1plf9)', () => {
  for (const role of ['ADMIN', 'MANAGER', 'FINANCE']) {
    const [out] = gateLegacyExportPrices([row], (p: Permission) => hasPermission(role, p))
    assert.deepEqual(out, row, role)
  }
})

test('the export route applies the price gate and keeps its header (o3d-1plf9)', async () => {
  const src = await readFile(path.join(process.cwd(), 'app/api/export/products/route.ts'), 'utf8')
  assert.match(src, /toCsv\(gateLegacyExportPrices\(buildRows\(batch, values\), canSeePrices\), headers\)/, 'every streamed batch is gated')
  assert.match(src, /'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive'/)
})

function cr(rowOutcome: 'created' | 'updated'): ComponentPassRow {
  return { lineNum: 2, sku: 'K', productId: 'p', components: 'X:1', rowOutcome, componentFailureCounted: false }
}

test('a failed component row stays created/updated and is counted in componentsFailed exactly once (o3d-0rqvs)', () => {
  const counters: ImportCounters = { created: 2, updated: 1, skipped: 0 }
  const created = cr('created')
  recordComponentRowFailure(counters, created)
  recordComponentRowFailure(counters, created)
  assert.deepEqual(counters, { created: 2, updated: 1, skipped: 0, componentsFailed: 1 })
  recordComponentRowFailure(counters, cr('updated'))
  assert.deepEqual(counters, { created: 2, updated: 1, skipped: 0, componentsFailed: 2 })
})

test('component failures make the execute result unsuccessful and show on the preview (o3d-0rqvs)', () => {
  const ok = createCsvImportExecutionResult({ created: 1, updated: 0, skipped: 0, errors: [] })
  assert.equal(ok.success, true)
  assert.equal(ok.componentsFailed, undefined)
  const bad = createCsvImportExecutionResult({ created: 1, updated: 0, skipped: 0, componentsFailed: 1, errors: ['Row 2: K circular'] })
  assert.equal(bad.success, false)
  assert.equal(bad.created, 1, 'the committed product stays counted')
  assert.equal(bad.skipped, 0)
  assert.equal(bad.componentsFailed, 1)
  const preview = createCsvImportPreviewResult({ totalRows: 1, created: 1, updated: 0, errorCount: 0, errors: ['x'], componentsFailed: 1 })
  assert.equal(preview.componentsFailed, 1)
  assert.equal(preview.proposedChanges.skipped, 0)
})

test('every refusal in the component pass records the failure and none adds a skip (o3d-0rqvs)', async () => {
  const src = await readFile(path.join(process.cwd(), 'app/actions/import.ts'), 'utf8')
  const start = src.indexOf('// Pass 2: Set up components for KIT/BOM products')
  const end = src.indexOf('if (preview) {\n    return buildImportPreviewResult(rows.length + dropped', start)
  const pass2 = src.slice(start, end)
  assert.equal((pass2.match(/result\.skipped\+\+/g) ?? []).length, 0, 'no skipped++ in pass 2')
  assert.equal((pass2.match(/recordComponentRowFailure\(result, cr\)/g) ?? []).length, 10)
  const ui = await readFile(path.join(process.cwd(), 'components/ui/csv-import-flow.tsx'), 'utf8')
  assert.match(ui, /result\?\.componentsFailed/)
})
