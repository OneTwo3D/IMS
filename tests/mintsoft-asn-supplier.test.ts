import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * WHICH SUPPLIER AN ASN CARRIES, AND THE REFUSAL WHEN IT HAS NONE (o3d-qk7z0). Doubles for the database; Mintsoft is never contacted.
 * Named mutation (shown red in the PR): m  refuse-ignores-setting  an unmapped supplier is refused even with the setting off.
 */

type Fake = {
  settings: Record<string, string>
  po: { reference: string; supplierId: string } | null
  transfer: { reference: string } | null
  suppliers: Record<string, { name: string }>
  links: Record<string, { state: string; externalSupplierId: string | null }>
  cache: Record<string, { missingSince: Date | null }>
  refusals: unknown[]
  resolved: unknown[]
}
const state: Fake = { settings: {}, po: null, transfer: null, suppliers: {}, links: {}, cache: {}, refusals: [], resolved: [] }
const reset = (patch: Partial<Fake>) => Object.assign(state, { settings: {}, po: null, transfer: null, suppliers: {}, links: {}, cache: {}, refusals: [], resolved: [] }, patch)

const fakeDb = {
  setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key in state.settings ? { value: state.settings[where.key]! } : null) },
  purchaseOrder: { findUnique: async () => state.po },
  stockTransfer: { findUnique: async () => state.transfer },
  supplier: { findUnique: async ({ where }: { where: { id: string } }) => state.suppliers[where.id] ?? null },
  mintsoftSupplierLink: { findUnique: async ({ where }: { where: { supplierId: string } }) => state.links[where.supplierId] ?? null },
  mintsoftSupplier: { findUnique: async ({ where }: { where: { externalId: string } }) => state.cache[where.externalId] ?? null },
  refusedAction: { updateMany: async (args: unknown) => { state.resolved.push(args); return { count: 1 } } },
  $queryRaw: async (_strings: unknown, ...values: unknown[]) => { state.refusals.push(values); return [{ id: 'r1', attempts: 1 }] },
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })

const resolveAsnSupplier = async (...args: Parameters<typeof import('../lib/connectors/mintsoft/suppliers/asn-supplier.ts').resolveAsnSupplier>) =>
  (await import('../lib/connectors/mintsoft/suppliers/asn-supplier.ts')).resolveAsnSupplier(...args)
const client = fakeDb as never

test('a mapped PO supplier sends its Mintsoft id, whether or not the setting is on', async () => {
  for (const required of ['true', 'false']) {
    reset({ settings: { mintsoft_asn_supplier_required: required }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null } } })
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'send', externalSupplierId: '42', supplierName: 'Acme' })
  }
})

test('unmapped with the setting OFF (the default): created as before, no supplier, no task', async () => {
  reset({ po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'none' })
  assert.equal(state.refusals.length, 0)
})

test('unmapped with the setting ON: refused with the operator text, and ONE task is raised naming the supplier', async () => {
  reset({ settings: { mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } } })
  const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.equal(out.kind, 'refuse')
  assert.match((out as { error: string }).error, /^Map supplier "Acme" in Settings > Mintsoft suppliers/)
  assert.match((out as { error: string }).error, /Nothing was sent/)
  assert.equal(state.refusals.length, 1)
  assert.ok((state.refusals[0] as unknown[]).includes('PURCHASE_ORDER') && (state.refusals[0] as unknown[]).includes('WMS_ASN_SUPPLIER') && (state.refusals[0] as unknown[]).includes('WMS_SUPPLIER_UNMAPPED'))
})

test('a CREATE_PENDING choice is not a mapping', async () => {
  reset({ settings: { mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'CREATE_PENDING', externalSupplierId: null } } })
  assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)).kind, 'refuse')
})

test('a mapping whose Mintsoft supplier has gone missing is refused when required, and not sent when not', async () => {
  const links = { s1: { state: 'MAPPED', externalSupplierId: '42' } }
  reset({ settings: { mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links, cache: { '42': { missingSince: new Date() } } })
  const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.match((out as { error: string }).error, /no longer in Mintsoft/)
  reset({ po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links, cache: { '42': { missingSince: new Date() } } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'none' })
})

test('a transfer carries the configured transfer supplier; with none chosen and the setting on it is refused', async () => {
  reset({ settings: { mintsoft_asn_supplier_required: 'true', mintsoft_transfer_supplier_id: 'own' }, transfer: { reference: 'TR-1' }, suppliers: { own: { name: 'One Two Enterprises Ltd' } }, links: { own: { state: 'MAPPED', externalSupplierId: '7' } }, cache: { '7': { missingSince: null } } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client), { kind: 'send', externalSupplierId: '7', supplierName: 'One Two Enterprises Ltd' })
  reset({ settings: { mintsoft_asn_supplier_required: 'true' }, transfer: { reference: 'TR-1' } })
  const out = await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client)
  assert.equal(out.kind, 'refuse')
  assert.match((out as { error: string }).error, /No supplier is chosen for transfer ASNs/)
  assert.ok((state.refusals[0] as unknown[]).includes('STOCK_TRANSFER'))
  reset({ transfer: { reference: 'TR-1' } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client), { kind: 'none' })
})

test('a later success closes the standing task', async () => {
  reset({ po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null } } })
  await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.equal(state.resolved.length, 1)
})
