import assert from 'node:assert/strict'
import test from 'node:test'

import { selectPriorRevaluationsToReverse } from '@/lib/accounting-fx-revaluation'

const LINES = [{ accountCode: '800', description: 'Unrealised FX', debit: 5, credit: 0 }]

// o3d-j625 r2: the row's own `connector`. `selectPriorRevaluationsToReverse` now carries it through so
// the reversal can be routed by the books its account codes came out of rather than by the settings
// object beside the enqueue — see the o3d-j625 tests for what that changes.
function revaluation(
  id: string,
  valuationDate: string,
  side: 'receivable' | 'payable' = 'receivable',
  connector = 'xero',
) {
  return { id, connector, payload: { kind: 'revaluation', side, valuationDate, lines: LINES } }
}

function reversal(id: string, sourceEntryId: string, connector = 'xero') {
  return { id, connector, payload: { kind: 'reversal', sourceEntryId, lines: LINES } }
}

test('o3d-j625: the selection carries each prior revaluation\u2019s OWN connector', () => {
  // The whole point of the MEDIUM 1 fix: a revaluation posted under QuickBooks, read back after a
  // switch to Xero, must still say QuickBooks — its AR/AP control and unrealised-FX codes are
  // QuickBooks's, and a reversal of them cannot be posted to Xero.
  const result = selectPriorRevaluationsToReverse(
    [revaluation('reval-qbo', '2026-06-01', 'receivable', 'quickbooks')],
    '2026-06-02',
  )
  assert.equal(result.length, 1, 'precondition: the prior was selected at all')
  assert.equal(
    result[0].connector,
    'quickbooks',
    'the reversal must be attributable to the connector the SOURCE ROW was written under, not to '
    + 'whichever chart the caller happens to hold',
  )
})

test('a prior revaluation whose reversal failed is retried even when a same-date revaluation exists', () => {
  // logs are pre-filtered to ACTIVE statuses, so a FAILED reversal of reval-1 is
  // simply absent. Today (2026-06-02) already has its own revaluation queued.
  const logs = [
    revaluation('reval-1', '2026-06-01'),
    revaluation('reval-2', '2026-06-02'),
  ]

  const result = selectPriorRevaluationsToReverse(logs, '2026-06-02')

  // The earlier revaluation must still be returned for re-reversal — the old
  // blanket same-date short-circuit stranded it permanently (scjz.39).
  assert.deepEqual(result.map((entry) => entry.id), ['reval-1'])
})

test('a prior revaluation with an active reversal is not re-reversed', () => {
  const logs = [
    revaluation('reval-1', '2026-06-01'),
    reversal('rev-1', 'reval-1'),
  ]

  assert.deepEqual(selectPriorRevaluationsToReverse(logs, '2026-06-02'), [])
})

test('same-date and future revaluations are never selected as priors to reverse', () => {
  const logs = [
    revaluation('reval-today', '2026-06-02'),
    revaluation('reval-future', '2026-06-03'),
  ]

  assert.deepEqual(selectPriorRevaluationsToReverse(logs, '2026-06-02'), [])
})

test('revaluations without parseable journal lines are skipped', () => {
  const logs = [
    { id: 'reval-empty', connector: 'xero', payload: { kind: 'revaluation', side: 'receivable', valuationDate: '2026-06-01', lines: [] } },
  ]

  assert.deepEqual(selectPriorRevaluationsToReverse(logs, '2026-06-02'), [])
})
