import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'
import { parseCsv } from '../../lib/csv.ts'

/**
 * PRODUCT CSV EXPORT PINS. The existing columns keep their names and order; the active product custom fields follow as `cf:<key>` columns,
 * appended LAST, in namespace / sort order. A hidden field is not exported. With no custom field the file is byte-for-byte the old one.
 */

let definitions: Array<Record<string, unknown>> = []
let values: Array<Record<string, unknown>> = []
let afterProductQuery: ((n: number) => void) | null = null
let catalogue: Array<ReturnType<typeof product>> = []
const calls = { products: 0, definitions: 0, values: 0, valueIdBatchSizes: [] as number[], valueWhereUnbounded: 0 }

function product(id: string, sku: string) { return {
  id, sku, name: `Name ${sku}`, description: null, type: 'SIMPLE', parentId: null, barcode: null, mpn: null, countryOfOrigin: null,
  preferredSupplierLocked: false, weight: null, widthCm: null, heightCm: null, depthCm: null, salesPriceBase: null, salePriceBase: null,
  salesPriceTaxInclusive: false, stockUnit: 'pcs', oversellAllowed: true, imageUrl: null, active: true, lifecycleStatus: 'ACTIVE',
  category: null, parent: null, preferredSupplier: null, stockLevels: [], costLayers: [], productComponents: [],
} }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      product: {
        findMany: async (args: { where?: { id?: { gt: string } }; take?: number }) => {
          calls.products += 1
          const after = args.where?.id?.gt
          const rows = catalogue.filter((p) => after === undefined || p.id > after).sort((a, b) => (a.id < b.id ? -1 : 1))
          const page = rows.slice(0, args.take ?? rows.length).map((p) => ({ ...p }))
          afterProductQuery?.(calls.products)
          return page
        },
      },
      customFieldDefinition: { findMany: async (args: { where: { active: boolean } }) => { calls.definitions += 1; return definitions.filter((d) => d.active === args.where.active) } },
      customFieldValue: {
        findMany: async (args: { where: { productId?: { in: string[] } } }) => {
          calls.values += 1
          const ids = args.where.productId?.in
          if (!ids) { calls.valueWhereUnbounded += 1; return values }
          calls.valueIdBatchSizes.push(ids.length)
          return values.filter((v) => ids.includes(v.productId as string))
        },
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => ({ user: { id: 'u', role: 'ADMIN' } }) } })
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })

let GET: typeof import('../../app/api/export/products/route.ts')['GET']
before(async () => { ({ GET } = await import('../../app/api/export/products/route.ts')) })

const BASE_HEADERS = [
  'productId', 'parentProductId', 'sku', 'name', 'description', 'type', 'parentSku', 'barcode', 'mpn', 'countryOfOrigin',
  'preferredSupplierId', 'preferredSupplierName', 'preferredSupplierLocked', 'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive', 'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components', 'totalStock', 'inventoryValue', 'category',
]

const d = (over: Record<string, unknown>) => ({ entity: 'PRODUCT', namespace: 'logistics', options: null, required: false, sortOrder: 0, active: true, ...over })

function reset() {
  catalogue = [product('p1', 'AAA'), product('p2', 'BBB')]
  afterProductQuery = null
  calls.products = 0; calls.definitions = 0; calls.values = 0; calls.valueIdBatchSizes = []; calls.valueWhereUnbounded = 0
}

async function exportRows() {
  reset()
  const response = await GET(new Request('http://localhost/api/export/products'))
  const text = await response.text()
  return { text, headers: text.split('\r\n')[0]!.split(','), rows: parseCsv(text) }
}

test('with no custom field the header row is exactly the existing one (the last-column pin is still `category`)', async () => {
  definitions = []; values = []
  const { headers } = await exportRows()
  assert.deepEqual(headers, BASE_HEADERS)
  assert.equal(headers.at(-1), 'category')
})

test('active fields are appended after `category`, in namespace then sort order; every earlier column is unchanged', async () => {
  definitions = [
    d({ id: 'dB', key: 'zone', label: 'Zone', type: 'STRING', namespace: 'logistics', sortOrder: 2 }),
    d({ id: 'dA', key: 'hazard', label: 'Hazard', type: 'BOOLEAN', namespace: 'logistics', sortOrder: 1 }),
    d({ id: 'dC', key: 'mass', label: 'Mass', type: 'DECIMAL', namespace: 'manufacturing' }),
    d({ id: 'dOff', key: 'old', label: 'Old', type: 'STRING', active: false }),
  ]
  values = [
    { definitionId: 'dA', productId: 'p1', valueText: null, valueDecimal: null, valueBoolean: true, valueDate: null, valueDateTime: null, valueJson: null },
    { definitionId: 'dB', productId: 'p1', valueText: '=A1+B1, "quoted"', valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null },
    { definitionId: 'dC', productId: 'p2', valueText: null, valueDecimal: '12.5', valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null },
    { definitionId: 'dOff', productId: 'p1', valueText: 'hidden', valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null },
  ]
  const { headers, rows, text } = await exportRows()
  assert.deepEqual(headers.slice(0, BASE_HEADERS.length), BASE_HEADERS)
  assert.deepEqual(headers.slice(BASE_HEADERS.length), ['cf:hazard', 'cf:zone', 'cf:mass'])
  assert.equal(rows[0]!['cf:hazard'], 'true')
  assert.equal(rows[0]!['cf:zone'], "'=A1+B1, \"quoted\"", 'a leading formula character is neutralised exactly like every other text column')
  assert.equal(rows[0]!['cf:mass'], '')
  assert.equal(rows[1]!['cf:mass'], '12.5')
  assert.ok(!text.includes('hidden') && !text.includes('cf:old'), 'a switched-off field and its values are not exported')
})

test('MEMORY AND QUERIES ARE BOUNDED: a large catalogue is read in batches of 500, with the custom values of only that batch, two queries per batch', async () => {
  definitions = [d({ id: 'dA', key: 'hazard', label: 'Hazard', type: 'STRING' }), d({ id: 'dB', key: 'zone', label: 'Zone', type: 'STRING' })]
  values = []
  reset()
  catalogue = Array.from({ length: 1201 }, (_, i) => product(`p${String(i).padStart(5, '0')}`, `SKU${String(i).padStart(5, '0')}`))
  for (const p of catalogue) values.push({ definitionId: 'dA', productId: p.id, valueText: `h-${p.sku}`, valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null })
  const response = await GET(new Request('http://localhost/api/export/products'))
  const rows = parseCsv(await response.text())
  assert.equal(rows.length, 1201, 'every product is exported exactly once, in sku order')
  assert.equal(new Set(rows.map((r) => r.productId)).size, 1201)
  assert.equal(rows.find((r) => r.sku === 'SKU01200')!['cf:hazard'], 'h-SKU01200')
  assert.equal(rows.find((r) => r.sku === 'SKU00000')!['cf:zone'], '')
  for (let from = 0; from < rows.length; from += 500) {
    const skus = rows.slice(from, from + 500).map((r) => r.sku)
    assert.deepEqual(skus, [...skus].sort(), 'sku order holds inside each batch')
  }
  assert.equal(calls.products, 3, 'three product batches (500, 500, 201), not one per product')
  assert.equal(calls.values, 3, 'one values query per batch')
  assert.equal(calls.valueWhereUnbounded, 0, 'no values query is ever unbounded by product')
  assert.deepEqual(calls.valueIdBatchSizes, [500, 500, 201])
  assert.equal(calls.definitions, 1)
})

test('REGRESSION: a SKU edit between batches neither skips nor duplicates a product (paging is on the immutable id)', async () => {
  definitions = []
  values = []
  reset()
  catalogue = Array.from({ length: 1201 }, (_, i) => product(`p${String(i).padStart(5, '0')}`, `SKU${String(i).padStart(5, '0')}`))
  // After the first batch is read: one already-exported product is renamed to sort LAST, and one not-yet-exported product is renamed to sort FIRST.
  // A sku cursor would then repeat the first and skip the second.
  afterProductQuery = (n) => {
    if (n !== 1) return
    catalogue.find((p) => p.id === 'p00000')!.sku = 'ZZZ-RENAMED-LATE'
    catalogue.find((p) => p.id === 'p01200')!.sku = 'AAA-RENAMED-EARLY'
  }
  const rows = parseCsv(await (await GET(new Request('http://localhost/api/export/products'))).text())
  const ids = rows.map((r) => r.productId)
  assert.equal(rows.length, 1201)
  assert.equal(new Set(ids).size, 1201, 'no product twice')
  assert.deepEqual([...ids].sort(), catalogue.map((p) => p.id).sort(), 'no product missing')
})
