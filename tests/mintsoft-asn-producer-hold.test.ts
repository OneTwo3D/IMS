import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '../lib/security/producer-disposition-constants.ts'

/**
 * THE TWO ASN BUTTONS UNDER THE PRODUCER-SIDE HOLD.
 *
 * Creating an ASN is a write to the warehouse that an operator does by hand in Mintsoft until the live phase. With the hold
 * enforced and the decision SHADOW the button is refused BEFORE anything exists: no sync job, no WmsAsnMap reservation, no
 * claim, no request. The refusal has its own flag (`shadowed`), it is not a failure and not a "created". OFF is the control that
 * shows the very same call goes on to create its sync job. Mintsoft is LIVE and is never contacted (the registry is a double and
 * tests/no-outbound-network.cjs fails the file if anything tried to leave the box).
 *
 * Named mutation (shown red in the PR): c  asn-reserves-first  the button creates its sync job before asking the seam.
 */

const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft]
function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

const calls: string[] = []
const shadows: Array<{ operation: string; subjectType: string; subjectId: string }> = []
const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async () => {
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
  get: (_target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$queryRaw') {
      return async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?')
        calls.push('$queryRaw')
        if (!text.includes('outbound_shadow_writes')) return []
        const values = query.values ?? []
        shadows.push({ operation: String(values[1]), subjectType: String(values[2]), subjectId: String(values[3]) })
        return [{ id: `shadow-${shadows.length}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      }
    }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$executeRawUnsafe') return undefined
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'op-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => ({ mintsoft: true }),
    isIntegrationPluginEnabled: async () => true,
    INTEGRATION_PLUGIN_SETTING_KEYS: {},
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })

const input = { autoCallback: false }

for (const [label, action] of [['purchase order', 'createMintsoftPurchaseOrderAsn'], ['transfer', 'createMintsoftTransferAsn']] as const) {
  test(`${label} ASN, ON and no grant: refused with the shadow sentence BEFORE any sync job, reservation or request exists; one shadow is kept`, async () => {
    const actions = await import('../app/actions/mintsoft-sync.ts')
    await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' }, async () => {
      calls.length = 0
      shadows.length = 0
      const result = await actions[action]('doc-1', input)
      console.log(`# ON ${label}: ${JSON.stringify(result)} writes=${JSON.stringify(calls.filter((c) => WRITES.has(c.split('.')[1] ?? '')))} shadows=${JSON.stringify(shadows)}`)
      assert.equal(result.success, false)
      assert.equal(result.shadowed, true)
      assert.match(result.error!, /^Not sent by IMS: writes to Mintsoft are held on this installation/)
      assert.match(result.error!, /an operator working by hand/, 'the owner ruling: ASNs are made by hand in Mintsoft today')
      assert.deepEqual(calls.filter((c) => WRITES.has(c.split('.')[1] ?? '')), [], 'nothing was created, reserved or claimed')
      assert.equal(calls.some((c) => c.startsWith('wmsSyncJob.') || c.startsWith('wmsAsnMap.')), false)
      assert.deepEqual(shadows.map((s) => [s.operation, s.subjectId]), [['asn.create', 'doc-1']])
    })
  })

  test(`${label} ASN, OFF (the control): the same call goes on to create its sync job`, async () => {
    const actions = await import('../app/actions/mintsoft-sync.ts')
    await withEnv({}, async () => {
      calls.length = 0
      shadows.length = 0
      const result = await actions[action]('doc-1', input).catch((error: unknown) => ({ success: false, error: String(error) }))
      console.log(`# OFF ${label}: ${JSON.stringify(result).slice(0, 160)} first writes=${JSON.stringify(calls.filter((c) => WRITES.has(c.split('.')[1] ?? '')).slice(0, 3))}`)
      assert.ok(calls.includes('wmsSyncJob.create'), 'CONTROL: the doubles can see the job being created')
      assert.equal('shadowed' in result, false)
      assert.equal(shadows.length, 0)
    })
  })
}

test('ASN: in the live phase (grant and an instant that has passed) the button is not refused by the hold', async () => {
  const actions = await import('../app/actions/mintsoft-sync.ts')
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft', [OUTBOUND_GRANT_ENV.mintsoft]: 'https://wms.example.test|89', [PRODUCER_CUTOFF_ENV.mintsoft]: '2020-01-01T00:00:00Z' }, async () => {
    calls.length = 0
    shadows.length = 0
    const result = await actions.createMintsoftPurchaseOrderAsn('doc-1', input).catch((error: unknown) => ({ success: false, error: String(error) }))
    assert.equal('shadowed' in result, false)
    assert.ok(calls.includes('wmsSyncJob.create'))
    assert.equal(shadows.length, 0)
  })
})
