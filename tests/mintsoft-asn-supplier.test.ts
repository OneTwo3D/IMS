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
  cache: Record<string, { missingSince: Date | null; active: boolean }>
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
const SEND = { mintsoft_asn_send_supplier_enabled: 'true', mintsoft_supplier_last_sync_at: new Date().toISOString() }

test('a mapped PO supplier sends its Mintsoft id once sending is on, whether or not required is on', async () => {
  for (const required of ['true', 'false']) {
    reset({ settings: { ...SEND, mintsoft_asn_supplier_required: required }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null, active: true } } })
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'send', externalSupplierId: '42', supplierName: 'Acme' })
  }
})

test('unmapped with the setting OFF (the default): created as before, no supplier, no task', async () => {
  reset({ settings: { ...SEND }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'none' })
  assert.equal(state.refusals.length, 0)
})

test('unmapped with the setting ON: refused with the operator text, and ONE task is raised naming the supplier', async () => {
  reset({ settings: { ...SEND, mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } } })
  const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.equal(out.kind, 'refuse')
  assert.match((out as { error: string }).error, /^Map supplier "Acme" in Settings > Mintsoft suppliers/)
  assert.match((out as { error: string }).error, /Nothing was sent/)
  assert.equal(state.refusals.length, 1)
  assert.ok((state.refusals[0] as unknown[]).includes('PURCHASE_ORDER') && (state.refusals[0] as unknown[]).includes('WMS_ASN_SUPPLIER') && (state.refusals[0] as unknown[]).includes('WMS_SUPPLIER_UNMAPPED'))
})

test('a CREATE_PENDING choice is not a mapping', async () => {
  reset({ settings: { ...SEND, mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'CREATE_PENDING', externalSupplierId: null } } })
  assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)).kind, 'refuse')
})

test('a mapped supplier missing from the cache, missing since the last read, or inactive is NEVER sent: refused with a task, required or not', async () => {
  const links = { s1: { state: 'MAPPED', externalSupplierId: '42' } }
  const cases: Array<[string, Fake['cache'], RegExp]> = [
    ['missing since the last read', { '42': { missingSince: new Date(), active: true } }, /not in the latest read/],
    ['absent from the cache', {}, /not in the latest read/],
    ['inactive', { '42': { missingSince: null, active: false } }, /inactive in Mintsoft/],
  ]
  for (const required of ['true', 'false']) {
    for (const [label, cache, text] of cases) {
      reset({ settings: { ...SEND, mintsoft_asn_supplier_required: required }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links, cache })
      const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
      assert.equal(out.kind, 'refuse', `${label} (required=${required})`)
      assert.match((out as { error: string }).error, text)
      assert.match((out as { error: string }).error, /Nothing was sent/)
      assert.equal(state.refusals.length, 1, `${label}: one operator task`)
    }
  }
})

test('SEND SWITCH OFF: a mapped supplier changes nothing on the ASN, so the body stays byte-identical (mapped, required off)', async () => {
  for (const settings of [{} as Record<string, string>, { mintsoft_asn_send_supplier_enabled: 'false' }, { mintsoft_asn_send_supplier_enabled: 'TRUE' }]) {
    reset({ settings, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null, active: true } } })
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client), { kind: 'none' })
    assert.equal(state.refusals.length, 0)
    assert.equal(state.resolved.length, 0)
  }
  // The action sends `externalSupplierId: null` for anything but 'send', and the payload builder adds the field only for a non-empty id.
  const { MINTSOFT_ASN_SUPPLIER_FIELD } = await import('../lib/connectors/mintsoft/suppliers/contract.ts')
  assert.equal(MINTSOFT_ASN_SUPPLIER_FIELD, 'ProductSupplierId')
})

test('required ON while the send switch is OFF refuses (never a supplier-less ASN under required, never an unverified field)', async () => {
  reset({ settings: { mintsoft_asn_supplier_required: 'true' }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null, active: true } } })
  const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.equal(out.kind, 'refuse')
  assert.match((out as { error: string }).error, /mintsoft_asn_send_supplier_enabled/)
})

test('a transfer carries the configured transfer supplier; with none chosen and the setting on it is refused', async () => {
  reset({ settings: { ...SEND, mintsoft_asn_supplier_required: 'true', mintsoft_transfer_supplier_id: 'own' }, transfer: { reference: 'TR-1' }, suppliers: { own: { name: 'One Two Enterprises Ltd' } }, links: { own: { state: 'MAPPED', externalSupplierId: '7' } }, cache: { '7': { missingSince: null, active: true } } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client), { kind: 'send', externalSupplierId: '7', supplierName: 'One Two Enterprises Ltd' })
  reset({ settings: { ...SEND, mintsoft_asn_supplier_required: 'true' }, transfer: { reference: 'TR-1' } })
  const out = await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client)
  assert.equal(out.kind, 'refuse')
  assert.match((out as { error: string }).error, /No supplier is chosen for transfer ASNs/)
  assert.ok((state.refusals[0] as unknown[]).includes('STOCK_TRANSFER'))
  reset({ settings: { ...SEND }, transfer: { reference: 'TR-1' } })
  assert.deepEqual(await resolveAsnSupplier({ kind: 'Transfer', id: 't1' }, client), { kind: 'none' })
})

test('a later success closes the standing task', async () => {
  reset({ settings: { ...SEND }, po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null, active: true } } })
  await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
  assert.equal(state.resolved.length, 1)
})

test('send ON: a mapped, present, active supplier is REFUSED when the list was never read or was read longer ago than the ASN limit (default 24 h)', async () => {
  const base = { po: { reference: 'PO-1', supplierId: 's1' }, suppliers: { s1: { name: 'Acme' } }, links: { s1: { state: 'MAPPED', externalSupplierId: '42' } }, cache: { '42': { missingSince: null, active: true } } }
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  for (const [label, settings] of [
    ['never read', { mintsoft_asn_send_supplier_enabled: 'true' }],
    ['25 hours old', { mintsoft_asn_send_supplier_enabled: 'true', mintsoft_supplier_last_sync_at: hoursAgo(25) }],
    ['3 hours old with a 2 hour limit', { mintsoft_asn_send_supplier_enabled: 'true', mintsoft_supplier_last_sync_at: hoursAgo(3), mintsoft_asn_supplier_cache_max_age_hours: '2' }],
  ] as const) {
    for (const required of ['true', 'false']) {
      reset({ ...base, settings: { ...settings, mintsoft_asn_supplier_required: required } })
      const out = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)
      assert.equal(out.kind, 'refuse', `${label} (required ${required})`)
      assert.match((out as { error: string }).error, /not been read recently enough/)
      assert.equal(state.refusals.length, 1, 'a standing operator task is raised')
    }
  }
  // 23 hours is inside the default limit, and a 30 hour limit accepts 25 hours.
  reset({ ...base, settings: { mintsoft_asn_send_supplier_enabled: 'true', mintsoft_supplier_last_sync_at: hoursAgo(23) } })
  assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)).kind, 'send')
  reset({ ...base, settings: { mintsoft_asn_send_supplier_enabled: 'true', mintsoft_supplier_last_sync_at: hoursAgo(25), mintsoft_asn_supplier_cache_max_age_hours: '30' } })
  assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: 'po1' }, client)).kind, 'send')
})
