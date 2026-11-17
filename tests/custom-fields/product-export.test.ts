import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'
import { parseCsv } from '../../lib/csv.ts'

/**
 * PRODUCT CSV EXPORT PINS. The existing columns keep their names and order; the active product custom fields follow as `cf:<key>` columns,
 * appended LAST, in namespace / sort order. A hidden field is not exported. With no custom field the file is byte-for-byte the old one.
 */

let definitions: Array<Record<string, unknown>> = []
let values: Array<Record<string, unknown>> = []
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
        findMany: async (args: { where?: { sku?: { gt: string } }; take?: number }) => {
          calls.products += 1
          const after = args.where?.sku?.gt
          const rows = catalogue.filter((p) => after === undefined || p.sku > after).sort((a, b) => (a.sku < b.sku ? -1 : 1))
          return rows.slice(0, args.take ?? rows.length)
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
  catalogue = Array.from({ length: 1201 }, (_, i) => product(`p${i}`, `SKU${String(i).padStart(5, '0')}`))
  for (const p of catalogue) values.push({ definitionId: 'dA', productId: p.id, valueText: `h-${p.sku}`, valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null })
  const response = await GET(new Request('http://localhost/api/export/products'))
  const rows = parseCsv(await response.text())
  assert.equal(rows.length, 1201, 'every product is exported exactly once, in sku order')
  assert.deepEqual(rows.map((r) => r.sku), [...rows.map((r) => r.sku)].sort())
  assert.equal(rows[1200]!['cf:hazard'], 'h-SKU01200')
  assert.equal(rows[0]!['cf:zone'], '')
  assert.equal(calls.products, 3, 'three product batches (500, 500, 201), not one per product')
  assert.equal(calls.values, 3, 'one values query per batch')
  assert.equal(calls.valueWhereUnbounded, 0, 'no values query is ever unbounded by product')
  assert.deepEqual(calls.valueIdBatchSizes, [500, 500, 201])
  assert.equal(calls.definitions, 1)
})
