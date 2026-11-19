import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/** THE SUPPLIER SCREEN'S SERVER ACTIONS (o3d-qk7z0): who may change what, and that every switch audit is written INSIDE the transaction. */

const log: string[] = []
const settings: Record<string, string> = {}
let freshAdminCalls = 0
let roleCalls = 0
const tx = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => (where.key in settings ? { value: settings[where.key]! } : null),
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => { settings[where.key] = update.value; log.push(`set ${where.key}=${update.value}`) },
  },
}
const fakeDb = {
  supplier: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'own' ? { name: 'One Two Enterprises Ltd' } : null) },
  $transaction: async (fn: (t: unknown) => unknown) => { log.push('begin'); const out = await fn(tx); log.push('commit'); return out },
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshAdmin: async () => { freshAdminCalls += 1; return { user: { id: 'admin-1', role: 'ADMIN' } } },
    requireRole: async () => { roleCalls += 1; return { user: { id: 'mgr-1', role: 'MANAGER' } } },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivityInTransaction: async (_c: unknown, p: { action: string }) => { log.push(`audit ${p.action}`) } } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('@/lib/connectors/mintsoft/suppliers/mapping', { namedExports: {} })
mock.module('@/lib/connectors/mintsoft/suppliers/supplier-sync', { namedExports: {} })

const reset = () => { log.length = 0; for (const key of Object.keys(settings)) delete settings[key]; freshAdminCalls = 0; roleCalls = 0 }

test('"required" cannot be saved ON without "send the supplier": refused, nothing written', async () => {
  reset()
  const { saveMintsoftSupplierSwitches } = await import('../app/actions/mintsoft-suppliers.ts')
  const out = await saveMintsoftSupplierSwitches({ createEnabled: false, asnRequired: true, sendSupplierEnabled: false })
  assert.equal(out.success, false)
  assert.match(out.error!, /send the supplier/)
  assert.deepEqual(log, [])
  assert.equal(freshAdminCalls, 1, 'ADMIN with a fresh sign-in')
})

test('the switches save in ONE transaction with their audit rows inside it (default OFF stays OFF unless chosen)', async () => {
  reset()
  const { saveMintsoftSupplierSwitches } = await import('../app/actions/mintsoft-suppliers.ts')
  const out = await saveMintsoftSupplierSwitches({ createEnabled: false, asnRequired: false, sendSupplierEnabled: true })
  assert.equal(out.success, true)
  assert.deepEqual(log, [
    'begin',
    'set mintsoft_supplier_create_enabled=false',
    'set mintsoft_asn_send_supplier_enabled=true',
    'audit mintsoft_asn_send_supplier_enabled_updated',
    'set mintsoft_asn_supplier_required=false',
    'commit',
  ])
})

test('the transfer supplier needs ADMIN with a fresh sign-in, and its audit is inside the transaction', async () => {
  reset()
  const { saveMintsoftTransferSupplier } = await import('../app/actions/mintsoft-suppliers.ts')
  const out = await saveMintsoftTransferSupplier('own')
  assert.equal(out.success, true)
  assert.equal(freshAdminCalls, 1)
  assert.equal(roleCalls, 0, 'a MANAGER session is not what authorises it')
  assert.deepEqual(log, ['begin', 'set mintsoft_transfer_supplier_id=own', 'audit mintsoft_transfer_supplier_updated', 'commit'])
})

test('resolving an unknown create outcome needs ADMIN with a fresh sign-in and a reason', async () => {
  reset()
  const { resolveUnknownMintsoftSupplierCreate } = await import('../app/actions/mintsoft-suppliers.ts')
  const out = await resolveUnknownMintsoftSupplierCreate({ supplierId: 's1', reason: '', outcome: { kind: 'NOT_CREATED' } })
  assert.equal(out.success, false)
  assert.equal(freshAdminCalls, 1)
})
