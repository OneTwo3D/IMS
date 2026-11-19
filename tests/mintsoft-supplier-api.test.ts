import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMintsoftAsnCreateRequest } from '../lib/connectors/mintsoft/api/client.ts'
import { buildMintsoftSupplierCreateBody, buildMintsoftSupplierListPath, createMintsoftSupplier, fetchMintsoftSuppliers, normalizeMintsoftSupplier } from '../lib/connectors/mintsoft/api/suppliers.ts'
import { classifyMintsoftRequest } from '../lib/connectors/mintsoft/api/read-allowlist.ts'
import { MINTSOFT_ASN_SUPPLIER_FIELD, MINTSOFT_SUPPLIER_PAGE_LIMIT } from '../lib/connectors/mintsoft/suppliers/contract.ts'

/** The wire side of the supplier feature. No request leaves the box: a request double stands in for the Mintsoft transport. */

const baseAsn = {
  externalWarehouseId: '5',
  reference: 'PO-1',
  packagingType: null,
  packageCount: null,
  lines: [{ sourceLineId: 'l1', externalProductId: '11', sku: 'SKU-1', quantity: 2 }],
}

test('the ASN body carries the mapped supplier id, and is byte-identical to the old body without one', () => {
  const without = buildMintsoftAsnCreateRequest(baseAsn).body
  assert.equal(without.includes('Supplier'), false, 'no supplier key when nothing is mapped')
  assert.equal(buildMintsoftAsnCreateRequest({ ...baseAsn, externalSupplierId: null }).body, without)
  assert.equal(buildMintsoftAsnCreateRequest({ ...baseAsn, externalSupplierId: '   ' }).body, without)
  const withSupplier = JSON.parse(buildMintsoftAsnCreateRequest({ ...baseAsn, externalSupplierId: '42', supplierReference: 'S-9' }).body)
  assert.equal(withSupplier[MINTSOFT_ASN_SUPPLIER_FIELD], 42)
  assert.equal(withSupplier.SupplierNotes, 'Supplier reference: S-9', 'SupplierNotes is kept as it was')
})

test('the supplier list is a read and the create is a write, in the path census', () => {
  assert.equal(classifyMintsoftRequest('GET', '/api/Product/Suppliers').class, 'read')
  assert.equal(classifyMintsoftRequest('PUT', '/api/Product/Suppliers').class, 'write')
  assert.equal(classifyMintsoftRequest('POST', '/api/Product/Suppliers').class, 'write')
})

test('a supplier row is normalised, and an unreadable one is refused', () => {
  assert.deepEqual(normalizeMintsoftSupplier({ ID: 7, Name: ' Acme ', Code: 'AC', ContactEmail: 'a@b.example', Active: false })?.externalId, '7')
  assert.equal(normalizeMintsoftSupplier({ ID: 7, Name: 'Acme', Active: false })?.active, false)
  assert.equal(normalizeMintsoftSupplier({ ID: 7, Name: 'Acme' })?.active, true)
  assert.equal(normalizeMintsoftSupplier({ ID: 0, Name: 'Acme' }), null)
  assert.equal(normalizeMintsoftSupplier({ ID: 3 }), null)
})

function pager(pages: unknown[][]) {
  const paths: string[] = []
  const request = (async (path: string) => {
    paths.push(path)
    const page = Number(new URL(path, 'https://x.test').searchParams.get('PageNo'))
    return { data: pages[page - 1] ?? [], error: null, status: 200 }
  }) as never
  return { request, paths }
}
const row = (id: number) => ({ ID: id, Name: `S${id}` })

test('the list pages at the documented limit, paces between pages, and ends on an empty page', async () => {
  const full = Array.from({ length: MINTSOFT_SUPPLIER_PAGE_LIMIT }, (_, i) => row(i + 1))
  const { request, paths } = pager([full, [row(1000)]])
  const sleeps: number[] = []
  const out = await fetchMintsoftSuppliers({ request, pauseMs: 250, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(out.length, MINTSOFT_SUPPLIER_PAGE_LIMIT + 1)
  assert.deepEqual(paths.map((p) => new URL(p, 'https://x.test').searchParams.get('PageNo')), ['1', '2', '3'])
  assert.equal(paths[0], buildMintsoftSupplierListPath(1))
  assert.deepEqual(sleeps, [250, 250], 'a pause before every page after the first')
})

test('a partial list is never returned: a repeated id, a malformed body, an unreadable row and a transport error all throw', async () => {
  await assert.rejects(fetchMintsoftSuppliers({ request: pager([[row(1), row(1)]]).request, pauseMs: 0 }), /appeared twice/)
  await assert.rejects(fetchMintsoftSuppliers({ request: (async () => ({ data: { error: 'x' }, error: null, status: 200 })) as never, pauseMs: 0 }), /expected an array/)
  await assert.rejects(fetchMintsoftSuppliers({ request: pager([[{ ID: 1 }]]).request, pauseMs: 0 }), /cannot read/)
  await assert.rejects(fetchMintsoftSuppliers({ request: (async () => ({ data: null, error: 'boom', status: 500 })) as never, pauseMs: 0 }), /boom/)
})

test('the create body carries only what IMS knows, never an address', () => {
  assert.deepEqual(buildMintsoftSupplierCreateBody({ name: ' Acme ', email: 'a@b.example', contactName: null, phone: ' 01 ' }), { Name: 'Acme', Active: true, ContactEmail: 'a@b.example', ContactNumber: '01' })
})

test('createMintsoftSupplier with no name sends nothing', async () => {
  assert.deepEqual(await createMintsoftSupplier({ name: '  ' }), { created: false, message: 'A supplier needs a name; nothing was sent.' })
})
