import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { gateLegacyExportPrices, LEGACY_EXPORT_PRICE_COLUMNS } from '@/lib/products/legacy-export-price-gate'
import { demoteComponentRowToSkipped, type ComponentPassRow } from '@/lib/products/import-row-accounting'
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
  assert.match(src, /gateLegacyExportPrices\(rows, /)
  assert.match(src, /toCsv\(gated, HEADERS\)/)
  assert.match(src, /'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive'/)
})

function cr(rowOutcome: 'created' | 'updated'): ComponentPassRow {
  return { lineNum: 2, sku: 'K', productId: 'p', components: 'X:1', rowOutcome, demoted: false }
}

test('a failed component row moves from created/updated to skipped exactly once (o3d-0rqvs)', () => {
  const counters = { created: 2, updated: 1, skipped: 0 }
  const created = cr('created')
  demoteComponentRowToSkipped(counters, created)
  demoteComponentRowToSkipped(counters, created)
  assert.deepEqual(counters, { created: 1, updated: 1, skipped: 1 })
  demoteComponentRowToSkipped(counters, cr('updated'))
  assert.deepEqual(counters, { created: 1, updated: 0, skipped: 2 })
})

test('every refusal in the component pass goes through the demotion and none adds a bare skip (o3d-0rqvs)', async () => {
  const src = await readFile(path.join(process.cwd(), 'app/actions/import.ts'), 'utf8')
  const start = src.indexOf('// Pass 2: Set up components for KIT/BOM products')
  const end = src.indexOf('if (preview) {\n    return buildImportPreviewResult(rows.length + dropped', start)
  const pass2 = src.slice(start, end)
  assert.equal((pass2.match(/result\.skipped\+\+/g) ?? []).length, 0, 'no bare skipped++ in pass 2')
  assert.equal((pass2.match(/demoteComponentRowToSkipped\(result, cr\)/g) ?? []).length, 8)
})
