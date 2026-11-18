import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assertFreightEditNotStale,
  FREIGHT_EDIT_STALE_MESSAGE,
  FreightEditRefusedError,
  freightCostLinesFingerprint,
} from '@/lib/domain/purchasing/freight-cost-lines'

/**
 * o3d-aks9m: a freight edit saved from a dialog opened BEFORE another operator's edit replaces the whole line set
 * and so silently reverses that edit. The action compares what the dialog loaded with the lines it reads under the
 * order lock.
 */

const stored = (amount: string) => [
  { id: 'l1', description: 'Freight', amountForeign: amount, vatable: false, distributionMethod: 'BY_VALUE' },
  { id: 'l2', description: 'Duty', amountForeign: '5', vatable: true, distributionMethod: 'BY_WEIGHT' },
]

test('a dialog opened before a concurrent amount edit is refused, and nothing else is', () => {
  const opened = freightCostLinesFingerprint(stored('10'))
  assert.doesNotThrow(() => assertFreightEditNotStale(stored('10'), opened), 'unchanged lines are not stale')
  assert.throws(() => assertFreightEditNotStale(stored('12'), opened), (error: unknown) => (
    error instanceof FreightEditRefusedError && error.message === FREIGHT_EDIT_STALE_MESSAGE
  ))
  assert.doesNotThrow(() => assertFreightEditNotStale(stored('12'), undefined), 'no fingerprint = legacy caller, unchecked')
})

test('the fingerprint sees an added, removed, re-described or re-methoded line, and ignores order and number format', () => {
  const base = freightCostLinesFingerprint(stored('10'))
  const lines = stored('10')
  assert.equal(freightCostLinesFingerprint([...lines].reverse()), base, 'row order is not content')
  assert.equal(freightCostLinesFingerprint(stored('10.0000')), base, '10 and 10.0000 are one amount')
  assert.notEqual(freightCostLinesFingerprint(lines.slice(0, 1)), base, 'a removed line')
  assert.notEqual(freightCostLinesFingerprint([...lines, { id: 'l3', description: 'x', amountForeign: '1', vatable: false, distributionMethod: 'BY_VALUE' }]), base, 'an added line')
  assert.notEqual(freightCostLinesFingerprint([{ ...lines[0]!, description: 'Freight 2' }, lines[1]!]), base, 'a re-described line')
  assert.notEqual(freightCostLinesFingerprint([{ ...lines[0]!, distributionMethod: 'EQUAL_SPLIT' }, lines[1]!]), base, 'a re-methoded line')
  assert.notEqual(freightCostLinesFingerprint([{ ...lines[0]!, vatable: true }, lines[1]!]), base, 'a VAT flag change')
})

test('census: the action checks the dialog fingerprint under the lock, and the dialog sends it', () => {
  const action = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const body = action.slice(action.indexOf('export async function updateFreightPoCosts('))
  const lockAt = body.indexOf('await lockLandedCostRevaluationScope(tx, { freightPoId })')
  const checkAt = body.indexOf('assertFreightEditNotStale(storedLines, expectedCostLinesFingerprint)')
  assert.ok(lockAt > 0 && checkAt > lockAt, 'the stale check runs after the revaluation scope lock')
  assert.match(body.slice(0, 600), /expectedCostLinesFingerprint\?: string/)
  const dialog = readFileSync('app/(dashboard)/purchase-orders/[id]/po-detail-client.tsx', 'utf8')
  assert.match(dialog, /openedFingerprint,\n\s*\)/, 'the dialog passes what it loaded')
})
