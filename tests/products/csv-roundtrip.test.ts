import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parseCsv } from '@/lib/csv'
import { PRODUCTS_IMPORT_HEADERS } from '@/lib/first-load/spec'
import {
  CSV_CLEAR_TOKEN,
  PRODUCT_CSV_COLUMNS,
  allowedProductCsvColumns,
  chooseProductCsvColumns,
} from '@/lib/products/csv-roundtrip/columns'
import { analyseProductCsvHeaders, type RoundTripProduct } from '@/lib/products/csv-roundtrip/plan'
import { PLAN_CHUNK, runProductCsvEdit } from '@/lib/products/csv-roundtrip/run'
import { loadSelectedProducts } from '@/lib/products/csv-roundtrip/selection'
import {
  buildBatchUpdateSql,
  type PlannedUpdate,
  type ProductCsvLookupTables,
  type ProductCsvStore,
} from '@/lib/products/csv-roundtrip/store'
import { buildProductCsvTemplate } from '@/lib/products/csv-roundtrip/template'
import { hasPermission, type Permission } from '@/lib/permissions'

const ROOT = process.cwd()
const canAll: (permission: Permission) => boolean = () => true
const canWithoutPrices = (permission: Permission) => permission !== 'inventory.prices'

function product(sku: string, overrides: Partial<RoundTripProduct> = {}): RoundTripProduct {
  return {
    id: `id-${sku}`, sku, name: `Name ${sku}`, description: `Desc ${sku}`, barcode: null, mpn: null, countryOfOrigin: 'GB',
    weight: '0.5000', widthCm: '10.00', heightCm: null, depthCm: null, imageUrl: null,
    salesPriceBase: '9.9900', salePriceBase: null, salesPriceTaxInclusive: true, stockUnit: 'pcs', oversellAllowed: true,
    preferredSupplierId: null, preferredSupplierLocked: false, categoryId: null, lifecycleStatus: 'ACTIVE',
    updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides,
  }
}

const TABLES: ProductCsvLookupTables = {
  supplierIdByName: new Map([['acme ltd', 'sup-1']]),
  supplierNameById: new Map([['sup-1', 'Acme Ltd']]),
  categoryIdByPath: new Map([['apparel', 'cat-1'], ['apparel>t-shirts', 'cat-2']]),
  categoryPathById: new Map([['cat-1', 'Apparel'], ['cat-2', 'Apparel > T-Shirts']]),
}

/** An in-memory store that applies batches the way the SQL does: only the fields a row changed, nothing else. */
class FakeStore implements ProductCsvStore {
  readonly products = new Map<string, RoundTripProduct>()
  readonly calls = { lookups: 0, bySku: 0, barcodes: 0, batches: 0 }
  failBatchContaining: string | null = null
  constructor(products: RoundTripProduct[]) { for (const p of products) this.products.set(p.sku, { ...p }) }
  async loadLookupTables() { this.calls.lookups++; return TABLES }
  async findProductsBySku(skus: readonly string[]) {
    this.calls.bySku++
    return skus.flatMap((sku) => { const found = this.products.get(sku); return found ? [{ ...found }] : [] })
  }
  async findBarcodeOwners(barcodes: readonly string[]) {
    this.calls.barcodes++
    const owners = new Map<string, string>()
    for (const p of this.products.values()) if (p.barcode && barcodes.includes(p.barcode)) owners.set(p.barcode, p.id)
    return owners
  }
  async writeBatch(updates: readonly PlannedUpdate[]) {
    this.calls.batches++
    const staleIds: string[] = []
    if (this.failBatchContaining && updates.some((u) => u.sku === this.failBatchContaining)) throw new Error('simulated failure')
    let written = 0
    for (const update of updates) {
      const target = this.products.get(update.sku)!
      // The statement's version guard: a row that moved on since the plan read it is not written.
      if (target.updatedAt.getTime() !== update.expectedUpdatedAt.getTime()) { staleIds.push(update.id); continue }
      for (const change of update.changes) (target as unknown as Record<string, unknown>)[change.field] = change.value
      target.updatedAt = new Date(target.updatedAt.getTime() + 1)
      written++
    }
    return { written, staleIds }
  }
}

const csv = (rows: string[]) => rows.join('\n')

/** A downloaded file for `products`, in the exact form the download produces. */
function download(products: RoundTripProduct[], keys: string[]): string {
  const chosen = chooseProductCsvColumns(keys, canAll)
  assert.ok(chosen.ok)
  return buildProductCsvTemplate(products, chosen.ok ? chosen.columns : [], TABLES)
}
/** Replace one cell of a downloaded file's first data row. */
function editCell(file: string, sku: string, column: string, value: string): string {
  const rows = parseCsv(file)
  const headers = Object.keys(rows[0])
  const lines = [headers.join(',')]
  for (const row of rows) {
    const copy = { ...row }
    if (row.sku === sku) copy[column] = value
    lines.push(headers.map((h) => `"${copy[h].replace(/"/g, '""')}"`).join(','))
  }
  return lines.join('\n')
}

// --------------------------------------------------------------------------------------------- the column registry

test('every offered column is one the existing product import already reads, under the same header', () => {
  const importSource = readFileSync(join(ROOT, 'app/actions/import.ts'), 'utf8')
  const headers = new Set<string>(PRODUCTS_IMPORT_HEADERS)
  for (const column of PRODUCT_CSV_COLUMNS) {
    assert.ok(headers.has(column.key), `${column.key} is not an importer header`)
    assert.ok(importSource.includes(`'${column.key}'`), `importProductsCsv does not read ${column.key}`)
  }
  assert.ok(PRODUCT_CSV_COLUMNS.every((column) => column.key !== 'sku'), 'sku is the key, not an editable column')
})

test('only nullable product fields are marked clearable', () => {
  const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')
  const model = schema.slice(schema.indexOf('model Product {'), schema.indexOf('@@map("products")'))
  for (const column of PRODUCT_CSV_COLUMNS) {
    const line = model.split('\n').find((l) => new RegExp(`^\\s+${column.field}\\s`).test(l))
    assert.ok(line, `no Product.${column.field}`)
    const nullable = /^\s+\w+\s+\w+\?/.test(line)
    assert.equal(column.nullable, nullable, `${column.key} nullability disagrees with the schema (${line.trim()})`)
  }
})

// --------------------------------------------------------------------------------------------- the column picker

test('the picker offers price columns only to a role holding inventory.prices', () => {
  const withPrices = allowedProductCsvColumns((p) => hasPermission('ADMIN', p)).map((c) => c.key)
  const withoutPrices = allowedProductCsvColumns(canWithoutPrices).map((c) => c.key)
  for (const key of ['salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive']) {
    assert.ok(withPrices.includes(key))
    assert.ok(!withoutPrices.includes(key))
  }
  assert.ok(withoutPrices.includes('name') && withoutPrices.includes('weight'))
})

test('choosing columns keeps registry order, drops duplicates, and refuses unknown or forbidden ones', () => {
  const ok = chooseProductCsvColumns(['weight', 'name', 'weight'], canAll)
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.columns.map((c) => c.key), ['name', 'weight'])

  const forbidden = chooseProductCsvColumns(['name', 'salesPriceBase'], canWithoutPrices)
  assert.equal(forbidden.ok, false)
  assert.match(!forbidden.ok ? forbidden.error : '', /inventory\.prices/)

  assert.equal(chooseProductCsvColumns(['type'], canAll).ok, false, 'type is not editable by CSV')
  assert.equal(chooseProductCsvColumns(['sku'], canAll).ok, false, 'sku is always included, never picked')
  assert.equal(chooseProductCsvColumns([], canAll).ok, false)
})

// --------------------------------------------------------------------------------------------- the template

test('the template holds exactly the selection, its variants, SKU first and only the chosen columns', async () => {
  const rows = [
    { ...product('TSHIRT'), parentId: null },
    { ...product('TSHIRT-S'), parentId: 'id-TSHIRT' },
    { ...product('TSHIRT-M'), parentId: 'id-TSHIRT' },
    { ...product('MUG'), parentId: null },
    { ...product('OTHER'), parentId: null },
  ]
  const asked: unknown[] = []
  const client = {
    product: {
      findMany: async (args: { where: { OR: Array<{ id?: { in: string[] }; parentId?: { in: string[] } }> } }) => {
        asked.push(args)
        const ids = new Set(args.where.OR[0].id!.in)
        return rows.filter((r) => ids.has(r.id) || (r.parentId !== null && ids.has(r.parentId)))
      },
    },
  }
  const selected = await loadSelectedProducts(client as never, { mode: 'ids', ids: ['id-TSHIRT', 'id-MUG', 'id-TSHIRT-S'] })
  assert.deepEqual(selected.map((p) => p.sku), ['MUG', 'TSHIRT', 'TSHIRT-M', 'TSHIRT-S'])
  assert.equal(asked.length, 1, 'one query for the whole selection')

  const chosen = chooseProductCsvColumns(['weight', 'name'], canAll)
  assert.ok(chosen.ok)
  const file = buildProductCsvTemplate(selected, chosen.ok ? chosen.columns : [], TABLES)
  const lines = file.split('\r\n')
  assert.equal(lines[0], 'sku,name,weight,rev')
  assert.equal(lines.length, 5)
  assert.match(lines[2], /^TSHIRT,Name TSHIRT,0\.5000,name=[0-9a-f]{8};weight=[0-9a-f]{8}$/)
})

test('the template renders supplier and category by name and booleans as TRUE/FALSE', () => {
  const chosen = chooseProductCsvColumns(['preferredSupplierName', 'category', 'oversellAllowed', 'salesPriceBase'], canAll)
  assert.ok(chosen.ok)
  const file = buildProductCsvTemplate([product('A', { preferredSupplierId: 'sup-1', categoryId: 'cat-2' })], chosen.ok ? chosen.columns : [], TABLES)
  assert.deepEqual(parseCsv(file), [{
    sku: 'A', category: 'Apparel > T-Shirts', oversellAllowed: 'TRUE', salesPriceBase: '9.9900', preferredSupplierName: 'Acme Ltd',
    rev: parseCsv(file)[0].rev,
  }])
})

// --------------------------------------------------------------------------------------------- blank, clear, absent

async function preview(store: FakeStore, text: string, can = canAll) {
  return runProductCsvEdit({ mode: 'preview', text, canUse: can, store })
}
async function apply(store: FakeStore, text: string, can = canAll) {
  return runProductCsvEdit({ mode: 'apply', text, canUse: can, store })
}

test('a BLANK cell leaves the field unchanged, in preview and in apply (the destructive-blank bug)', async () => {
  const store = new FakeStore([product('A', { description: 'Keep me', weight: '0.5000', countryOfOrigin: 'GB', barcode: '123' })])
  const file = csv(['sku,name,description,weight,countryOfOrigin,barcode,salesPriceBase,preferredSupplierName,category', 'A,,,,,,,,'])
  const dry = await preview(store, file)
  assert.equal(dry.changedProducts, 0)
  assert.equal(dry.unchangedProducts, 1)
  assert.deepEqual(dry.errors, [])
  const done = await apply(store, file)
  assert.equal(done.written, 0)
  assert.equal(store.calls.batches, 0, 'nothing to write, so no transaction opened')
  const after = store.products.get('A')!
  assert.equal(after.description, 'Keep me')
  assert.equal(after.weight, '0.5000')
  assert.equal(after.countryOfOrigin, 'GB')
  assert.equal(after.barcode, '123')
  assert.equal(after.salesPriceBase, '9.9900')
})

test('a blank cell changes nothing even when the row changes another field', async () => {
  const store = new FakeStore([product('A', { description: 'Keep me' })])
  await apply(store, csv(['sku,name,description', 'A,New name,']))
  const after = store.products.get('A')!
  assert.equal(after.name, 'New name')
  assert.equal(after.description, 'Keep me')
})

test('the clear token empties a nullable field, and only that field', async () => {
  const store = new FakeStore([product('A', { description: 'Gone', mpn: 'M-1', preferredSupplierId: 'sup-1', categoryId: 'cat-1', salePriceBase: '5.0000' })])
  const file = csv([`sku,description,mpn,preferredSupplierName,category,salePriceBase,weight`, `A,${CSV_CLEAR_TOKEN},,${CSV_CLEAR_TOKEN},${CSV_CLEAR_TOKEN},${CSV_CLEAR_TOKEN},`])
  const dry = await preview(store, file)
  assert.equal(dry.changedProducts, 1)
  assert.deepEqual(
    dry.diffs[0].changes.map((c) => [c.column, c.from, c.to]).sort(),
    [['category', 'Apparel', ''], ['description', 'Gone', ''], ['preferredSupplierName', 'Acme Ltd', ''], ['salePriceBase', '5.0000', '']],
  )
  await apply(store, file)
  const after = store.products.get('A')!
  assert.equal(after.description, null)
  assert.equal(after.preferredSupplierId, null)
  assert.equal(after.categoryId, null)
  assert.equal(after.salePriceBase, null)
  assert.equal(after.mpn, 'M-1', 'a blank cell beside the token is still unchanged')
  assert.equal(after.weight, '0.5000')
})

test('the clear token is refused for a field that cannot be empty, and the row is not applied at all', async () => {
  const store = new FakeStore([product('A')])
  const file = csv([`sku,name,description,stockUnit,oversellAllowed,lifecycleStatus,preferredSupplierLocked`, `A,${CSV_CLEAR_TOKEN},Changed,${CSV_CLEAR_TOKEN},${CSV_CLEAR_TOKEN},${CSV_CLEAR_TOKEN},${CSV_CLEAR_TOKEN}`])
  const done = await apply(store, file)
  assert.equal(done.written, 0)
  assert.equal(done.errorRows, 1)
  for (const key of ['name', 'stockUnit', 'oversellAllowed', 'lifecycleStatus', 'preferredSupplierLocked']) {
    assert.match(done.errors[0], new RegExp(`${key} cannot be cleared`))
  }
  assert.equal(store.products.get('A')!.description, 'Desc A', 'the valid edit on a failing row is not applied either')
})

test('the clear token is refused for a country of origin that is already invalid (the editor rule)', async () => {
  const store = new FakeStore([product('A', { countryOfOrigin: 'ZZ' })])
  const done = await apply(store, csv([`sku,countryOfOrigin`, `A,${CSV_CLEAR_TOKEN}`]))
  assert.equal(done.errorRows, 1)
  assert.match(done.errors[0], /invalid stored country/)
  assert.equal(store.products.get('A')!.countryOfOrigin, 'ZZ')
})

test('a column absent from the file is never touched', async () => {
  const store = new FakeStore([product('A', { description: 'Keep', weight: '1.0000', salesPriceBase: '3.0000' })])
  await apply(store, csv(['sku,name', 'A,Renamed']))
  const after = store.products.get('A')!
  assert.deepEqual(
    { name: after.name, description: after.description, weight: after.weight, price: after.salesPriceBase, unit: after.stockUnit },
    { name: 'Renamed', description: 'Keep', weight: '1.0000', price: '3.0000', unit: 'pcs' },
  )
  const sql = buildBatchUpdateSql(
    [{ id: 'id-A', sku: 'A', expectedUpdatedAt: new Date(0), changes: [{ column: 'name', label: 'Name', field: 'name', from: '', to: 'Renamed', value: 'Renamed' }] }],
    PRODUCT_CSV_COLUMNS.filter((c) => c.key === 'name'),
  )
  assert.ok(!/"description"|"weight"|"salesPriceBase"/.test(sql.sql), 'the statement names only the columns the file carries')
})

// --------------------------------------------------------------------------------------------- update-only, preview

test('an unknown SKU is rejected, nothing is created, and the other rows still apply', async () => {
  const store = new FakeStore([product('A')])
  const file = csv(['sku,name', 'A,Renamed', 'NOPE,Created?'])
  const dry = await preview(store, file)
  assert.equal(dry.changedProducts, 1)
  assert.equal(dry.errorRows, 1)
  assert.match(dry.errors[0], /Row 3 \(NOPE\): SKU not found.*does not create/)
  const done = await apply(store, file)
  assert.equal(done.written, 1)
  assert.equal(store.products.size, 1)
})

test('a SKU repeated in the file is an error on the repeat', async () => {
  const store = new FakeStore([product('A')])
  const done = await preview(store, csv(['sku,name', 'A,One', 'A,Two']))
  assert.equal(done.changedProducts, 1)
  assert.match(done.errors[0], /already appears on row 2/)
})

test('the preview shows the per-product diff and writes nothing', async () => {
  const store = new FakeStore([product('A'), product('B', { name: 'Same' })])
  const dry = await preview(store, csv(['sku,name,weight,salesPriceBase,oversellAllowed', 'A,Renamed,0.75,12.5,false', 'B,Same,0.5,9.99,true']))
  assert.equal(dry.mode, 'preview')
  assert.equal(dry.changedProducts, 1)
  assert.equal(dry.unchangedProducts, 1)
  assert.deepEqual(dry.fieldChangeCounts, { name: 1, weight: 1, salesPriceBase: 1, oversellAllowed: 1 })
  assert.deepEqual(dry.diffs, [{
    sku: 'A',
    name: 'Name A',
    changes: [
      { column: 'name', label: 'Name', from: 'Name A', to: 'Renamed' },
      { column: 'weight', label: 'Weight (kg)', from: '0.5000', to: '0.7500' },
      { column: 'salesPriceBase', label: 'Regular price', from: '9.9900', to: '12.5000' },
      { column: 'oversellAllowed', label: 'Oversell allowed', from: 'TRUE', to: 'FALSE' },
    ],
  }])
  assert.equal(store.calls.batches, 0)
  assert.equal(store.products.get('A')!.name, 'Name A')
})

test('numerically equal values are not changes (0.5 against 0.5000)', async () => {
  const store = new FakeStore([product('A')])
  const dry = await preview(store, csv(['sku,weight,salesPriceBase', 'A,0.5,9.99']))
  assert.equal(dry.changedProducts, 0)
})

test('an unedited download uploads as no change, including a description the exporter had to guard', async () => {
  const products = [product('A', { description: '=SUM(A1)' }), product('B', { description: '-10% off', mpn: '+44' }), product('C', { description: "it's fine" })]
  const store = new FakeStore(products)
  const chosen = chooseProductCsvColumns(['description', 'mpn', 'weight', 'category'], canAll)
  assert.ok(chosen.ok)
  const file = buildProductCsvTemplate(products, chosen.ok ? chosen.columns : [], TABLES)
  assert.match(file, /'=SUM\(A1\)/, 'the exporter did guard the cell')
  const dry = await preview(store, file)
  assert.equal(dry.changedProducts, 0, JSON.stringify(dry.diffs))
  assert.deepEqual(dry.errors, [])
})

test('values the importer would silently misread are errors here', async () => {
  const store = new FakeStore([product('A')])
  const file = csv(['sku,oversellAllowed,weight,salesPriceBase,countryOfOrigin,lifecycleStatus,category,preferredSupplierName', 'A,maybe,-1,£5,Atlantis,GONE,Nope > Nowhere,Nobody'])
  const done = await preview(store, file)
  assert.equal(done.errorRows, 1)
  for (const fragment of ['not TRUE or FALSE', 'non-negative number', 'unrecognised country', 'not one of DRAFT', 'does not exist', 'supplier "Nobody" not found']) {
    assert.ok(done.errors[0].includes(fragment), `${fragment}: ${done.errors[0]}`)
  }
})

test('decimal precision is checked, not rounded', async () => {
  const store = new FakeStore([product('A')])
  const done = await preview(store, csv(['sku,widthCm,weight', 'A,1.234,0.12345']))
  assert.match(done.errors[0], /widthCm: "1.234" has more than 2 decimal places/)
  assert.match(done.errors[0], /weight: "0.12345" has more than 4 decimal places/)
})

test('a barcode already held by another product, or given twice in the file, is refused', async () => {
  const store = new FakeStore([product('A'), product('B', { barcode: '555' }), product('C')])
  const done = await preview(store, csv(['sku,barcode', 'A,555', 'C,777', 'B,777']))
  assert.equal(done.changedProducts, 1)
  assert.match(done.errors[0], /Row 2 \(A\).*barcode "555" is already in use/)
  assert.match(done.errors[1], /Row 4 \(B\).*barcode "777" is also given to C/)
})

test('a lifecycle change is written with the derived active flag, and the warehouse mark follows the caller\'s sync permission', async () => {
  const store = new FakeStore([product('A')])
  const seen: boolean[] = []
  const original = store.writeBatch.bind(store)
  store.writeBatch = async (updates, ...rest: unknown[]) => { seen.push((rest[1] as { markWarehouse?: boolean } | undefined)?.markWarehouse === true); return original(updates) }
  await runProductCsvEdit({ mode: 'apply', text: csv(['sku,lifecycleStatus,name', 'A,archived,Renamed']), canUse: canAll, store, markWarehouse: true })
  assert.deepEqual(seen, [true])
  assert.equal(store.products.get('A')!.lifecycleStatus, 'ARCHIVED')
})

// --------------------------------------------------------------------------------------------- headers and permissions

test('a file with price columns is refused whole for a role without inventory.prices', async () => {
  const store = new FakeStore([product('A')])
  const file = csv(['sku,name,salePriceBase', 'A,Renamed,4.00'])
  const done = await apply(store, file, canWithoutPrices)
  assert.match(done.fatal ?? '', /salePriceBase.*inventory\.prices/)
  assert.equal(done.written, 0)
  assert.equal(store.calls.bySku, 0, 'refused before any product was read')
  assert.equal(store.products.get('A')!.name, 'Name A')
  const allowed = await apply(store, file, canAll)
  assert.equal(allowed.written, 1)
  assert.equal(store.products.get('A')!.salePriceBase, '4.0000')
})

test('header analysis: sku is required, other columns are ignored with a note, duplicates refused', () => {
  assert.match(!analyseProductCsvHeaders(['name'], canAll).ok ? (analyseProductCsvHeaders(['name'], canAll) as { error: string }).error : '', /no "sku" column/)
  assert.match((analyseProductCsvHeaders(['sku'], canAll) as { error: string }).error, /no editable columns/)
  assert.match((analyseProductCsvHeaders(['sku', 'name', 'Name'], canAll) as { error: string }).error, /more than once/)
  const ok = analyseProductCsvHeaders(['SKU', 'Name', 'type', 'components', 'productId'], canAll)
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.ignored, ['type', 'components', 'productId'])
  assert.deepEqual(ok.ok && ok.columns.map((c) => c.key), ['name'])
})

test('type, parent and components in the file are warned about and never written', async () => {
  const store = new FakeStore([product('A')])
  const done = await apply(store, csv(['sku,name,type,parentSku,components', 'A,Renamed,KIT,P,B:1']))
  assert.equal(done.written, 1)
  assert.match(done.warnings[0], /type, parentSku, components/)
  assert.equal((store.products.get('A') as unknown as Record<string, unknown>).type, undefined)
})

test('an empty file, a BOM, and CRLF line endings', async () => {
  const store = new FakeStore([product('A')])
  assert.match((await preview(store, 'sku,name')).fatal ?? '', /no data rows/)
  const done = await apply(store, '﻿sku,name\r\nA,Renamed\r\n')
  assert.equal(done.written, 1)
})

// --------------------------------------------------------------------------------------------- batches and failure

test('a failing batch is rolled back and reported, and the other batches still apply', async () => {
  const products = Array.from({ length: 600 }, (_, i) => product(`S${String(i).padStart(4, '0')}`))
  const store = new FakeStore(products)
  store.failBatchContaining = 'S0300'
  const file = csv(['sku,name', ...products.map((p) => `${p.sku},Edited ${p.sku}`)])
  const done = await apply(store, file)
  assert.equal(done.failedProducts, 250)
  assert.equal(done.written, 350)
  assert.equal(store.calls.batches, 3)
  assert.match(done.errors[0], /rolled back and not saved: simulated failure/)
  assert.equal(store.products.get('S0300')!.name, 'Name S0300')
})

test('the SQL for a batch is parameterised, set-based, and bumps updatedAt', () => {
  const columns = PRODUCT_CSV_COLUMNS.filter((c) => ['name', 'weight', 'lifecycleStatus', 'preferredSupplierName'].includes(c.key))
  const sql = buildBatchUpdateSql([
    { id: 'id-A', sku: 'A', expectedUpdatedAt: new Date(0), changes: [{ column: 'name', label: 'Name', field: 'name', from: '', to: "x'; DROP TABLE products;--", value: "x'; DROP TABLE products;--" }] },
    { id: 'id-B', sku: 'B', expectedUpdatedAt: new Date(0), changes: [{ column: 'lifecycleStatus', label: 'Lifecycle status', field: 'lifecycleStatus', from: '', to: 'ARCHIVED', value: 'ARCHIVED' }] },
  ], columns)
  assert.ok(!sql.sql.includes('DROP TABLE'), 'values travel as bind parameters, never in the text')
  assert.match(sql.sql, /UPDATE "products" AS p/)
  assert.match(sql.sql, /"updatedAt" = now\(\)/)
  assert.match(sql.sql, /"active" = CASE WHEN/)
  assert.match(sql.sql, /"preferredSupplierUpdatedAt" = CASE WHEN/)
  assert.ok(sql.values.includes("x'; DROP TABLE products;--"))
  assert.equal((sql.sql.match(/UPDATE/g) ?? []).length, 1, 'one statement for the whole batch')
})

test('a chunk is one SKU read, however many rows it holds', async () => {
  const products = Array.from({ length: PLAN_CHUNK }, (_, i) => product(`C${i}`))
  const store = new FakeStore(products)
  await preview(store, csv(['sku,name', ...products.map((p) => `${p.sku},X`)]))
  assert.equal(store.calls.bySku, 1)
})

// --------------------------------------------------------------------------------------------- review round 1

test('REGRESSION (stale file): an unedited cell never overwrites a newer edit made in IMS after the download', async () => {
  const original = product('A', { salesPriceBase: '9.9900', description: 'Old description' })
  const file = download([original], ['description', 'salesPriceBase', 'weight'])
  // Someone edits the product in IMS after the download.
  const store = new FakeStore([{ ...original, salesPriceBase: '15.0000', description: 'Newer description', updatedAt: new Date('2026-11-02T10:00:00.000Z') }])
  // The operator only edits the weight in the file.
  const done = await apply(store, editCell(file, 'A', 'weight', '2.5'))
  assert.deepEqual(done.errors, [])
  assert.equal(done.written, 1)
  const after = store.products.get('A')!
  assert.equal(after.weight, '2.5000')
  assert.equal(after.salesPriceBase, '15.0000', 'the untouched price cell did not restore the old value')
  assert.equal(after.description, 'Newer description')
})

test('REGRESSION (stale file): an EDITED cell whose field changed in IMS since the download refuses the row', async () => {
  const original = product('A', { salesPriceBase: '9.9900' })
  const file = download([original], ['salesPriceBase', 'weight'])
  const store = new FakeStore([{ ...original, salesPriceBase: '15.0000', updatedAt: new Date('2026-11-02T10:00:00.000Z') }])
  const done = await apply(store, editCell(editCell(file, 'A', 'salesPriceBase', '11'), 'A', 'weight', '3'))
  assert.equal(done.written, 0)
  assert.match(done.errors[0], /salesPriceBase was changed in IMS after this file was downloaded \(it is now "15\.0000"\)/)
  assert.equal(store.products.get('A')!.weight, '0.5000', 'the row is refused whole, including its other edit')
  assert.equal(store.products.get('A')!.salesPriceBase, '15.0000')
})

test('REGRESSION (race): a product edited between the plan read and the write is not overwritten', async () => {
  const original = product('A')
  const store = new FakeStore([original])
  const file = download([original], ['name'])
  const racing: ProductCsvStore = {
    loadLookupTables: () => store.loadLookupTables(),
    findProductsBySku: async (skus) => {
      const found = await store.findProductsBySku(skus)
      // The editor saves right after the plan read this product.
      const live = store.products.get('A')!
      live.name = 'Edited meanwhile'
      live.updatedAt = new Date('2026-11-03T10:00:00.000Z')
      return found
    },
    findBarcodeOwners: (b) => store.findBarcodeOwners(b),
    writeBatch: (u) => store.writeBatch(u),
  }
  const done = await runProductCsvEdit({ mode: 'apply', text: editCell(file, 'A', 'name', 'From the file'), canUse: canAll, store: racing })
  assert.equal(done.written, 0)
  assert.match(done.errors[0], /changed in IMS while the import was running/)
  assert.equal(store.products.get('A')!.name, 'Edited meanwhile')
})

test('a file without the rev column still applies its non-blank cells, with a warning that staleness cannot be detected', async () => {
  const store = new FakeStore([product('A')])
  const done = await apply(store, csv(['sku,name', 'A,Renamed']))
  assert.equal(done.written, 1)
  assert.match(done.warnings.join(' '), /no "rev" column/)
  const withRev = await apply(store, download([store.products.get('A')!], ['name']))
  assert.deepEqual(withRev.warnings, [])
})

test('a numerically equal retyped cell (0.5 for 0.5000) is unedited and does not trip the stale check', async () => {
  const original = product('A')
  const file = download([original], ['weight', 'name'])
  const store = new FakeStore([{ ...original, weight: '0.7000', updatedAt: new Date('2026-11-02T10:00:00.000Z') }])
  const done = await apply(store, editCell(editCell(file, 'A', 'weight', '0.5'), 'A', 'name', 'New'))
  assert.deepEqual(done.errors, [])
  assert.equal(store.products.get('A')!.weight, '0.7000')
  assert.equal(store.products.get('A')!.name, 'New')
})

test('REGRESSION (formula guard): stored text is only unguarded when the download added the guard', async () => {
  const stored = ["=SUM(1)", "'=SUM(1)", "-10% off", "'-10% off", "'quoted", "+44 now", "@home"]
  const products = stored.map((description, i) => product(`F${i}`, { description }))
  const file = download(products, ['description'])
  const cells = parseCsv(file).map((r) => r.description)
  assert.deepEqual(cells, ["'=SUM(1)", "'=SUM(1)", "'-10% off", "'-10% off", "'quoted", "'+44 now", "'@home"])
  const store = new FakeStore(products)
  const dry = await preview(store, file)
  assert.equal(dry.changedProducts, 0, JSON.stringify(dry.diffs))
  const done = await apply(store, file)
  assert.equal(done.written, 0)
  assert.deepEqual(products.map((p) => store.products.get(p.sku)!.description), stored, 'no stored text was altered')
})

test('an edit TO a guard-looking value is stored verbatim, not stripped', async () => {
  const original = product('A', { description: 'plain' })
  const file = download([original], ['description'])
  const store = new FakeStore([original])
  await apply(store, editCell(file, 'A', 'description', "'=keep the apostrophe"))
  assert.equal(store.products.get('A')!.description, "'=keep the apostrophe")
})
