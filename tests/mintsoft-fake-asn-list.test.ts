import assert from 'node:assert/strict'
import test from 'node:test'
import * as fakeMintsoftRouteNs from '../app/api/e2e/mintsoft/[...slug]/route.ts'

const fakeMintsoftRoute = 'default' in fakeMintsoftRouteNs
  ? fakeMintsoftRouteNs.default as typeof import('../app/api/e2e/mintsoft/[...slug]/route.ts')
  : fakeMintsoftRouteNs

/**
 * o3d-bhvu: THE E2E FAKE MINTSOFT SERVES THE ASN LIST THE WAY LIVE MINTSOFT DOES.
 *
 * The fake used to serve the ASN list at `GET /api/ASN`, the path live Mintsoft answers with 405. That
 * agreement between a broken client and a matching fake is how the defect passed every e2e run. These
 * pin the fake's list to the live contract established by read-only GETs on 2026-09-18.
 */
type FakeAsn = Parameters<typeof fakeMintsoftRoute.fakeMintsoftAsnListResponse>[0][number]

function asns(count: number): FakeAsn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(100 + index),
    warehouseId: index % 2 === 0 ? '5' : '6',
    reference: `PO-${index}`,
    supplierNotes: null,
    estimatedDelivery: null,
    goodsInType: 'Carton',
    quantity: 1,
    statusId: 1,
    status: 'OPEN',
    createdAt: '2026-09-18T00:00:00.000Z',
    // o3d-btiw: an ASN item carries three quantities, and these rows describe ones nothing has been
    // booked in against yet — which is what the list contract under test is about.
    lines: [{
      id: `L${index}`,
      sourceLineId: `line-${index}`,
      productId: '7',
      sku: 'SKU-7',
      quantity: 3,
      receivedQuantity: 0,
      bookedQuantity: 0,
    }],
  }))
}

async function list(query: string, count = 220) {
  const response = fakeMintsoftRoute.fakeMintsoftAsnListResponse(asns(count), new URLSearchParams(query))
  return { status: response.status, body: await response.json() as unknown }
}

test('the fake ASN list pages like live: 100 per page, [] past the end, 400 above Limit=100, 500 at PageNo=0', async () => {
  assert.equal(((await list('PageNo=1&Limit=100')).body as unknown[]).length, 100)
  assert.equal(((await list('PageNo=3&Limit=100')).body as unknown[]).length, 20)
  assert.deepEqual((await list('PageNo=99&Limit=100')).body, [])
  assert.equal((await list('PageNo=1&Limit=101')).status, 400)
  assert.equal((await list('PageNo=0&Limit=1')).status, 500)
})

test('the fake ASN list carries POReference and items only when asked, and filters by warehouse', async () => {
  const withoutItems = (await list('PageNo=1&Limit=5')).body as Array<Record<string, unknown>>
  assert.equal(withoutItems[0]!.Items, null)
  assert.equal(withoutItems[0]!.POReference, 'PO-0')
  const withItems = (await list('PageNo=1&Limit=5&IncludeASNItems=true')).body as Array<Record<string, unknown>>
  assert.deepEqual(withItems[0]!.Items, [{ ID: 'L0', SourceLineId: 'line-0', ProductId: 7, SKU: 'SKU-7', QuantityExpected: 3 }])
  const warehouse6 = (await list('PageNo=1&Limit=100&WarehouseId=6')).body as Array<Record<string, unknown>>
  assert.ok(warehouse6.length > 0 && warehouse6.every((row) => row.WarehouseId === 6))
})
