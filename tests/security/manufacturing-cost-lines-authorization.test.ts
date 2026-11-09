import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'

/**
 * updateManufacturingCostLines on a COMPLETED order queues a MANUFACTURING_RECLASS journal whose credit
 * legs are the cost lines' account codes. It was reachable by WAREHOUSE (permission 'manufacturing'
 * only) with caller-chosen account codes. It now needs the cost-price permission, and an account
 * override must be the configured Manufacturing Overhead account.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE'
let currentRole: Role = 'MANAGER'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

const recorder = createRecordingDb(({ model, op }: QueryContext) => {
  if (model === 'productionOrder' && op === 'findUnique') {
    return { id: 'po1', reference: 'MO-1', status: 'COMPLETED', fxRateToBase: 1, outputProductId: 'p1' }
  }
  if (op === 'findMany') return []
  return null
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const WRITES = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$|^\$transaction$/

before(async () => {
  currentRole = 'MANAGER'
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  await recorder.prove(() => updateManufacturingCostLines('po1', []))
})

test('a WAREHOUSE session is refused, naming the permission, before any read or write', async () => {
  currentRole = 'WAREHOUSE'
  recorder.reset()
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  const result = await updateManufacturingCostLines('po1', [{ description: 'Labour', amountForeign: 100, accountCode: '9999' }])
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing permission inventory\.prices/)
  recorder.assertNoReads('WAREHOUSE calling updateManufacturingCostLines')
})

test('a MANAGER cannot choose an arbitrary account code for a cost line', async () => {
  currentRole = 'MANAGER'
  recorder.reset()
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  const result = await updateManufacturingCostLines('po1', [{ description: 'Labour', amountForeign: 100, accountCode: '9999-CALLER-CHOSEN' }])
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /Manufacturing Overhead account/)
  assert.deepEqual(recorder.calls.filter((call) => WRITES.test(call)), [], 'nothing was written or queued')
})
