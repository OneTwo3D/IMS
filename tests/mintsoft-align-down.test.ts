import assert from 'node:assert/strict'
import test from 'node:test'
import * as stockSyncHelpersNs from '../lib/connectors/mintsoft/sync/stock-sync-helpers.ts'

const stockSyncHelpers = 'default' in stockSyncHelpersNs
  ? stockSyncHelpersNs.default as typeof import('../lib/connectors/mintsoft/sync/stock-sync-helpers.ts')
  : stockSyncHelpersNs

const { planMintsoftAlignDown, mintsoftAlignDownReasonState } = stockSyncHelpers

const RUN_START = new Date('2026-07-11T10:00:00Z')
const PRIOR_RUN = new Date('2026-07-11T09:00:00Z')

// A baseline input where every gate passes: IMS 10, Mintsoft 7, delta -3, a
// configured reason, thresholds that allow the delta, no pending inbound, a
// matching prior-run discrepancy, and no reservations in the way.
function baseInput(overrides: Partial<Parameters<typeof planMintsoftAlignDown>[0]> = {}) {
  return {
    delta: -3,
    imsQty: 10,
    wmsQty: 7,
    reservedQty: 0,
    reasonConfigured: true,
    thresholds: { absoluteDelta: 5, percentDelta: null },
    openAsnPendingQty: 0,
    inFlightDispatchQty: 0,
    priorDiscrepancy: { delta: -3, lastSeenAt: PRIOR_RUN },
    runStartedAt: RUN_START,
    ...overrides,
  }
}

test('planMintsoftAlignDown applies when every gate passes', () => {
  const decision = planMintsoftAlignDown(baseInput())
  assert.deepEqual(decision, { action: 'apply', qty: -3 })
})

test('planMintsoftAlignDown never handles non-negative deltas', () => {
  assert.equal(planMintsoftAlignDown(baseInput({ delta: 0 })).action, 'hold')
  assert.equal(planMintsoftAlignDown(baseInput({ delta: 4 })).action, 'hold')
})

test('planMintsoftAlignDown holds without a configured adjustment reason', () => {
  const decision = planMintsoftAlignDown(baseInput({ reasonConfigured: false }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /adjustment reason/)
})

test('planMintsoftAlignDown holds when no thresholds are configured (unbounded auto-fix)', () => {
  const decision = planMintsoftAlignDown(baseInput({ thresholds: { absoluteDelta: null, percentDelta: null } }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /thresholds configured/)
})

test('planMintsoftAlignDown holds when the delta breaches the absolute threshold', () => {
  const decision = planMintsoftAlignDown(baseInput({ thresholds: { absoluteDelta: 3, percentDelta: null } }))
  // |delta| = 3 >= 3 breaches (threshold semantics are >=, matching the alert path)
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /breaches/)
})

test('planMintsoftAlignDown holds when the delta breaches the percent threshold', () => {
  const decision = planMintsoftAlignDown(baseInput({ thresholds: { absoluteDelta: null, percentDelta: 20 } }))
  // 3/10 = 30% >= 20%
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /breaches/)
})

test('planMintsoftAlignDown holds while open ASN lines still expect inbound stock', () => {
  const decision = planMintsoftAlignDown(baseInput({ openAsnPendingQty: 2 }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /receipt timing/)
})

test('planMintsoftAlignDown arms on the first run that sees the mismatch', () => {
  const decision = planMintsoftAlignDown(baseInput({ priorDiscrepancy: null }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /Armed/)
})

test('planMintsoftAlignDown does not treat a discrepancy written by THIS run as prior evidence', () => {
  const decision = planMintsoftAlignDown(baseInput({
    priorDiscrepancy: { delta: -3, lastSeenAt: new Date('2026-07-11T10:00:01Z') },
  }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /Armed/)
})

test('planMintsoftAlignDown re-arms when the delta changed since the previous run', () => {
  const decision = planMintsoftAlignDown(baseInput({
    priorDiscrepancy: { delta: -1, lastSeenAt: PRIOR_RUN },
  }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /Armed/)
})

test('planMintsoftAlignDown re-arms when the prior discrepancy has no recorded delta', () => {
  const decision = planMintsoftAlignDown(baseInput({
    priorDiscrepancy: { delta: null, lastSeenAt: PRIOR_RUN },
  }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /Armed/)
})

test('planMintsoftAlignDown never drives on-hand below the reserved quantity', () => {
  const decision = planMintsoftAlignDown(baseInput({ reservedQty: 8 }))
  // target on-hand would be 7 < 8 reserved
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /reserved/)
})

test('planMintsoftAlignDown allows aligning down exactly to the reserved quantity', () => {
  const decision = planMintsoftAlignDown(baseInput({ reservedQty: 7 }))
  assert.deepEqual(decision, { action: 'apply', qty: -3 })
})

test('planMintsoftAlignDown accepts a prior delta equal within tolerance (Decimal round-trip)', () => {
  const beyondTolerance = planMintsoftAlignDown(baseInput({
    priorDiscrepancy: { delta: -3.001, lastSeenAt: PRIOR_RUN },
  }))
  assert.equal(beyondTolerance.action, 'hold')

  const withinTolerance = planMintsoftAlignDown(baseInput({
    priorDiscrepancy: { delta: -3.00001, lastSeenAt: PRIOR_RUN },
  }))
  assert.equal(withinTolerance.action, 'apply')
})

test('planMintsoftAlignDown holds while a despatch is in flight, even when the delta has persisted', () => {
  const decision = planMintsoftAlignDown(baseInput({ inFlightDispatchQty: 2 }))
  assert.equal(decision.action, 'hold')
  if (decision.action === 'hold') assert.match(decision.reason, /despatched at the WMS but not yet recorded as shipped/)
})

test('planMintsoftAlignDown applies again once no despatch is in flight', () => {
  assert.equal(planMintsoftAlignDown(baseInput({ inFlightDispatchQty: 0 })).action, 'apply')
})

// o3d-jwa8m MED-5: with the reason/cost switch ON, a missing inventory account must degrade to a hold (a manual discrepancy), not a per-SKU sweep error.
test('mintsoftAlignDownReasonState: switch on and no inventory account is not configured, naming the inventory account', () => {
  const reason = { active: true, accountCode: '500' }
  assert.deepEqual(
    mintsoftAlignDownReasonState({ reason, reasonCostRequired: true, inventoryAccount: null }),
    { reasonConfigured: false, inventoryAccountMissing: true },
  )
  assert.deepEqual(
    mintsoftAlignDownReasonState({ reason, reasonCostRequired: true, inventoryAccount: '' }),
    { reasonConfigured: false, inventoryAccountMissing: true },
  )
  assert.deepEqual(
    mintsoftAlignDownReasonState({ reason, reasonCostRequired: true, inventoryAccount: '630' }),
    { reasonConfigured: true, inventoryAccountMissing: false },
  )
})

test('mintsoftAlignDownReasonState: switch off never looks at the inventory account (unchanged)', () => {
  const reason = { active: true, accountCode: '500' }
  assert.deepEqual(
    mintsoftAlignDownReasonState({ reason, reasonCostRequired: false, inventoryAccount: null }),
    { reasonConfigured: true, inventoryAccountMissing: false },
  )
  assert.equal(mintsoftAlignDownReasonState({ reason: { active: false, accountCode: '500' }, reasonCostRequired: false, inventoryAccount: '630' }).reasonConfigured, false)
  assert.equal(mintsoftAlignDownReasonState({ reason: { active: true, accountCode: null }, reasonCostRequired: true, inventoryAccount: '630' }).reasonConfigured, false)
  assert.equal(mintsoftAlignDownReasonState({ reason: null, reasonCostRequired: true, inventoryAccount: null }).inventoryAccountMissing, false)
})

test('planMintsoftAlignDown holds naming the inventory account when it is the missing piece', () => {
  const decision = planMintsoftAlignDown(baseInput({ reasonConfigured: false, inventoryAccountMissing: true }))
  assert.equal(decision.action, 'hold')
  assert.match((decision as { reason: string }).reason, /inventory account/)
  // Without the flag the message is the one it always was.
  assert.match((planMintsoftAlignDown(baseInput({ reasonConfigured: false })) as { reason: string }).reason, /adjustment reason/)
})
