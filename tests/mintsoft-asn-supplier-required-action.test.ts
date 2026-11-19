import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE TWO ASN BUTTONS WITH THE SUPPLIER REQUIRED (o3d-qk7z0): an unmapped supplier is refused BEFORE any sync job, reservation or request exists.
 * Mintsoft is never contacted. A mapped supplier is shown reaching the sync job (the control).
 */

const calls: string[] = []
function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async () => {
      calls.push(`${name}.${method}`)
      switch (method) {
        case 'findMany': return []
        case 'findUnique': case 'findFirst': return null
        case 'count': return 0
        case 'updateMany': case 'deleteMany': return { count: 0 }
        case 'create': return { id: `${name}-1` }
        default: return {}
      }
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$queryRaw') return async () => { calls.push('$queryRaw'); return [] }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})
let supplierAnswer: { kind: string; error?: string; externalSupplierId?: string; supplierName?: string } = { kind: 'none' }
const asked: unknown[] = []
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'op-1' } }), requireFreshPermission: async () => ({ user: { id: 'op-1' } }), freshAuthFailureResult: () => null } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }), isIntegrationPluginEnabled: async () => true, INTEGRATION_PLUGIN_SETTING_KEYS: {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/connectors/mintsoft/suppliers/asn-supplier', { namedExports: { resolveAsnSupplier: async (subject: unknown) => { asked.push(subject); return supplierAnswer } } })

for (const [label, action, kind] of [['purchase order', 'createMintsoftPurchaseOrderAsn', 'PurchaseOrder'], ['transfer', 'createMintsoftTransferAsn', 'Transfer']] as const) {
  test(`${label} ASN: an unmapped supplier (setting on) is refused with the operator text before any job or reservation`, async () => {
    const actions = await import('../app/actions/mintsoft-sync.ts')
    supplierAnswer = { kind: 'refuse', error: 'Map supplier "Acme" in Settings > Mintsoft suppliers, then retry.' }
    calls.length = 0
    asked.length = 0
    const result = await actions[action]('doc-1', { autoCallback: false })
    assert.equal(result.success, false)
    assert.match(result.error!, /^Map supplier "Acme" in Settings > Mintsoft suppliers/)
    assert.deepEqual(asked, [{ kind, id: 'doc-1' }])
    assert.equal(calls.some((c) => c.startsWith('wmsSyncJob.') || c.startsWith('wmsAsnMap.')), false, 'nothing was created or reserved')
  })

  test(`${label} ASN CONTROL: a mapped supplier goes on to create its sync job`, async () => {
    const actions = await import('../app/actions/mintsoft-sync.ts')
    supplierAnswer = { kind: 'send', externalSupplierId: '42', supplierName: 'Acme' }
    calls.length = 0
    await actions[action]('doc-1', { autoCallback: false }).catch(() => undefined)
    assert.ok(calls.includes('wmsSyncJob.create'), 'CONTROL: the doubles can see the job being created')
  })
}
