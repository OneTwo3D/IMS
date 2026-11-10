import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// When set, successive productionOrder reads answer these statuses in turn (the last one repeats): the
// first is the read before the row lock, the next is the one under it.
let statusScript: string[] | null = null
const recorder = createRecordingDb(({ model, op }: QueryContext) => {
  if (model === 'productionOrder' && op === 'findUnique') {
    const status = statusScript ? (statusScript.length > 1 ? statusScript.shift()! : statusScript[0]!) : 'COMPLETED'
    return { id: 'po1', reference: 'MO-1', status, fxRateToBase: 1, outputProductId: 'p1' }
  }
  if (op === 'findMany') return []
  return null
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const WRITES = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/

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

test('the override rule names the offending line and only passes the configured overhead account', async () => {
  const { findDisallowedOverheadOverride, overheadOverrideRefusal } = await import('@/lib/domain/manufacturing/manufacturing-action-inputs')
  assert.equal(findDisallowedOverheadOverride([{ description: 'Labour', accountCode: '800' }, { description: 'Power', accountCode: null }], '800'), null)
  const stray = findDisallowedOverheadOverride([{ description: 'Labour', accountCode: '800' }, { description: 'Power', accountCode: '9999' }], '800')
  assert.deepEqual(stray, { description: 'Power', accountCode: '9999' })
  assert.match(overheadOverrideRefusal(stray!, '800'), /cost line "Power" is set to account 9999.*\(800\)\. Nothing was posted\./)
  assert.notEqual(findDisallowedOverheadOverride([{ description: 'Labour', accountCode: '800' }], ''), null, 'no configured account means no override passes')
})

test('both posting sites validate overrides against the chart they post with, inside their transaction', () => {
  const source = readFileSync(join(process.cwd(), 'app/actions/manufacturing.ts'), 'utf8')
  const completion = source.indexOf('findDisallowedOverheadOverride(order.manufacturingCostLines, defaultOverheadAccount)')
  const completionLoop = source.indexOf('for (const costLine of order.manufacturingCostLines)', completion)
  assert.ok(completion !== -1 && completion < completionLoop, 'completion credits stored overrides unchecked')
  const edit = source.indexOf('findDisallowedOverheadOverride(cleanedForWrite, settings.manufacturingOverheadAccount)')
  const editTx = source.indexOf('await db.$transaction(async (tx) => {', source.indexOf('export async function updateManufacturingCostLines'))
  assert.ok(edit > editTx && editTx !== -1, 'the edit validates outside the transaction')
})

test('the edit acts on the status read under the row lock, not the one read before it', async () => {
  currentRole = 'MANAGER'
  // Before the lock the order is IN_PROGRESS; by the time the lock is held a completion has committed.
  statusScript = ['IN_PROGRESS', 'COMPLETED']
  recorder.reset()
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  await updateManufacturingCostLines('po1', [{ description: 'Labour', amountForeign: 100 }])
  statusScript = null
  const tx = recorder.calls.indexOf('$transaction')
  const chartReads = recorder.calls.filter((call, i) => call.startsWith('setting.') && i > tx)
  assert.ok(chartReads.length > 0, 'the edit ignored the COMPLETED status read under the lock (no reclass chart was read)')
})

test('an order cancelled between the first read and the lock is refused inside the transaction', async () => {
  currentRole = 'MANAGER'
  statusScript = ['IN_PROGRESS', 'CANCELLED']
  recorder.reset()
  const { updateManufacturingCostLines } = await import('@/app/actions/manufacturing')
  const result = await updateManufacturingCostLines('po1', [{ description: 'Labour', amountForeign: 100 }])
  statusScript = null
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /cancelled/)
  assert.deepEqual(recorder.calls.filter((call) => WRITES.test(call)), [])
})
