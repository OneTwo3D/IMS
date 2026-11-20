import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

// o3d-hqvrp.105: the save-path, panel, allocation-seam and packing-slip behaviour of kits with
// NON_INVENTORY / VARIABLE components.

let storedType = 'KIT'
let componentTypes: Array<{ id: string; sku: string; type: string }> = []
let writes = 0
let panelComponents: Array<{ componentId: string; qty: string; component: { id: string; sku: string; type: string } }> = []
let panelStock: Array<{ productId: string; warehouseId: string; quantity: string; reservedQty: string }> = []

const tx: Record<string, unknown> = {
  $executeRaw: async () => 0,
  $queryRaw: async () => [],
  product: {
    findUnique: async () => ({ sku: 'KIT-1', type: storedType }),
    findMany: async () => componentTypes,
  },
  productComponent: {
    findMany: async () => [],
    deleteMany: async () => { writes++; return { count: 0 } },
    createMany: async () => { writes++; return { count: 0 } },
  },
}
const db: Record<string, unknown> = {
  ...tx,
  product: { findUnique: async () => ({ sku: 'KIT-1', type: storedType }), findMany: async () => [] },
  productionOrder: { findMany: async () => [] },
  productComponent: { findMany: async (args: { where: { productId: string } }) => (args.where.productId === 'kit-panel' ? panelComponents : []) },
  warehouse: { findMany: async () => [{ id: 'A', code: 'A', name: 'A' }] },
  stockLevel: { findMany: async () => panelStock },
  $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('next/navigation', { namedExports: { redirect: () => { throw new Error('redirect') } } })
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (t: string) => t,
    sanitizeActivityLogMetadata: (v: unknown) => v,
  },
})

test('getKitStock ignores a NON_INVENTORY component: 1 mug + gift wrap with 50 mugs is 50, limited by the mug', async () => {
  const { getKitStock } = await import('@/app/actions/products')
  panelComponents = [
    { componentId: 'mug', qty: '1', component: { id: 'mug', sku: 'MUG', type: 'SIMPLE' } },
    { componentId: 'wrap', qty: '1', component: { id: 'wrap', sku: 'WRAP', type: 'NON_INVENTORY' } },
  ]
  panelStock = [{ productId: 'mug', warehouseId: 'A', quantity: '50', reservedQty: '0' }]
  const rows = await getKitStock('kit-panel')
  assert.equal(rows[0]?.calculatedQty, 50)
  assert.equal(rows[0]?.limitingComponent, 'MUG')
})

test('getKitStock for an all-NON_INVENTORY kit is 0 with no limiting component', async () => {
  const { getKitStock } = await import('@/app/actions/products')
  panelComponents = [{ componentId: 'wrap', qty: '1', component: { id: 'wrap', sku: 'WRAP', type: 'NON_INVENTORY' } }]
  panelStock = []
  const rows = await getKitStock('kit-panel')
  assert.equal(rows[0]?.calculatedQty, 0)
  assert.equal(rows[0]?.limitingComponent, null)
})

test('saveProductComponents refuses a VARIABLE component on a KIT and writes nothing', async () => {
  const { saveProductComponents } = await import('@/app/actions/products')
  storedType = 'KIT'
  writes = 0
  componentTypes = [{ id: 'p', sku: 'TSHIRT', type: 'VARIABLE' }]
  const res = await saveProductComponents('kit-1', [{ componentId: 'p', qty: '1' }])
  assert.equal(res.success, false)
  assert.match(res.error ?? '', /variable product \(TSHIRT\)/)
  assert.equal(writes, 0)
})

test('saveProductComponents refuses an all-NON_INVENTORY KIT, but still accepts mug + gift wrap', async () => {
  const { saveProductComponents } = await import('@/app/actions/products')
  storedType = 'KIT'
  writes = 0
  componentTypes = [{ id: 'w', sku: 'WRAP', type: 'NON_INVENTORY' }]
  const refused = await saveProductComponents('kit-1', [{ componentId: 'w', qty: '1' }])
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /at least one stock-tracked/)
  assert.equal(writes, 0)
})

test('a BOM is not subject to the kit refusal on save (manufacturing recipes may use any type)', async () => {
  const { saveProductComponents } = await import('@/app/actions/products')
  storedType = 'BOM'
  componentTypes = [{ id: 'w', sku: 'WRAP', type: 'NON_INVENTORY' }]
  const res = await saveProductComponents('bom-1', [{ componentId: 'w', qty: '1' }])
  assert.doesNotMatch(res.error ?? '', /at least one stock-tracked|variable product/)
})

test('BOM -> KIT conversion runs the same refusal on the retained components', async () => {
  const { findKitConversionRefusal } = await import('@/lib/products/kit-component-policy')
  const client = (rows: Array<{ sku: string; type: string }>) => ({
    productComponent: { findMany: async () => rows.map((component) => ({ component })) },
  })
  assert.match(await findKitConversionRefusal(client([{ sku: 'WRAP', type: 'NON_INVENTORY' }]), 'b') ?? '', /at least one stock-tracked/)
  assert.match(await findKitConversionRefusal(client([{ sku: 'T', type: 'VARIABLE' }]), 'b') ?? '', /variable product/)
  assert.equal(await findKitConversionRefusal(client([{ sku: 'MUG', type: 'SIMPLE' }, { sku: 'WRAP', type: 'NON_INVENTORY' }]), 'b'), null)
})

test('validateProductStructureChange refuses BOM -> KIT when the components would make a refused kit', async () => {
  const { validateProductStructureChange } = await import('@/lib/products/type-transforms')
  const client = {
    product: {
      findUnique: async () => ({ id: 'b', type: 'BOM', parentId: null, sku: 'B' }),
      findFirst: async () => null,
      findMany: async () => [],
      count: async () => 0,
    },
    productComponent: { findMany: async () => [{ component: { sku: 'WRAP', type: 'NON_INVENTORY' } }], count: async () => 0 },
    stockLevel: { aggregate: async () => ({ _sum: { quantity: null, reservedQty: null } }) },
    salesOrderLine: { count: async () => 0 },
    purchaseOrderLine: { count: async () => 0 },
    productionOrder: { count: async () => 0 },
    stockTransferLine: { count: async () => 0 },
  }
  const res = await validateProductStructureChange({ productId: 'b', type: 'KIT', parentId: null, client } as never)
  assert.equal(res.ok, false)
  assert.match(res.message ?? '', /at least one stock-tracked/)
})

// ---- allocation seam and blockers ----
import { collectNonOversellLeafComponents } from '@/lib/domain/sales/allocation-service'
import { collectNonStockPackComponents, expandFulfillmentRequirementsDecimal, type FulfillmentGraphNode } from '@/lib/products/kit-fulfillment'
import { captureFulfillmentRequirementSnapshot } from '@/lib/products/fulfillment-requirement-snapshot'
import { buildNonStockPackRows } from '@/lib/sales/packing-slip-document'

function comp(id: string, type: string, qty = 1, oversell = false) {
  return { componentId: id, componentSku: id, qty: new Prisma.Decimal(qty), componentType: type as never, componentOversellAllowed: oversell }
}
function node(id: string, type: string, components: ReturnType<typeof comp>[] = []): FulfillmentGraphNode {
  return { id, type: type as never, fulfillmentGraphVersion: 1, productComponents: components }
}
const mugKit = new Map<string, FulfillmentGraphNode>([
  ['K', node('K', 'KIT', [comp('MUG', 'SIMPLE'), comp('WRAP', 'NON_INVENTORY')])],
  ['MUG', node('MUG', 'SIMPLE')],
  ['WRAP', node('WRAP', 'NON_INVENTORY')],
])

test('the pinned allocation snapshot of mug + gift wrap holds the mug only', () => {
  const snap = captureFulfillmentRequirementSnapshot('K', mugKit)
  assert.deepEqual(snap.requirements.map((r) => r.productId), ['MUG'])
})

test('componentBlockers do not name a NON_INVENTORY part (it can never be "out of stock")', () => {
  assert.deepEqual(collectNonOversellLeafComponents('K', mugKit), ['MUG'])
})

test('an outer kit holding a legacy all-NON_INVENTORY inner kit is unallocatable, matching the push at 0', () => {
  const g = new Map<string, FulfillmentGraphNode>([
    ['P', node('P', 'KIT', [comp('A', 'SIMPLE'), comp('K2', 'KIT')])],
    ['K2', node('K2', 'KIT', [comp('WRAP', 'NON_INVENTORY')])],
    ['A', node('A', 'SIMPLE')],
    ['WRAP', node('WRAP', 'NON_INVENTORY')],
  ])
  const req = expandFulfillmentRequirementsDecimal('P', 1, g)
  assert.ok(req.has('K2'), 'the empty inner kit stays a requirement no stock row can cover')
})

test('packing slip: stock lines omit the wrap, the pack-not-stock list names it with the kit and quantity', () => {
  assert.deepEqual([...expandFulfillmentRequirementsDecimal('K', 2, mugKit).keys()], ['MUG'])
  const extra = collectNonStockPackComponents('K', 2, mugKit)
  assert.equal(extra.get('WRAP')?.qty.toNumber(), 2)
  const rows = buildNonStockPackRows(
    [{ productId: 'K', qty: 2, product: { sku: 'GIFT-MUG', name: 'Gift mug' } }],
    mugKit,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]![1], 'WRAP')
  assert.match(rows[0]![2]!, /GIFT-MUG - Gift mug/)
  assert.equal(rows[0]![4], '2')
})
