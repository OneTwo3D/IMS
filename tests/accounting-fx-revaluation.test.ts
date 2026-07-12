import assert from 'node:assert/strict'
import test from 'node:test'

import { selectPriorRevaluationsToReverse } from '@/lib/accounting-fx-revaluation'

const LINES = [{ accountCode: '800', description: 'Unrealised FX', debit: 5, credit: 0 }]

function revaluation(id: string, valuationDate: string, side: 'receivable' | 'payable' = 'receivable') {
  return { id, payload: { kind: 'revaluation', side, valuationDate, lines: LINES } }
}

function reversal(id: string, sourceEntryId: string) {
  return { id, payload: { kind: 'reversal', sourceEntryId, lines: LINES } }
}

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
    { id: 'reval-empty', payload: { kind: 'revaluation', side: 'receivable', valuationDate: '2026-06-01', lines: [] } },
  ]

  assert.deepEqual(selectPriorRevaluationsToReverse(logs, '2026-06-02'), [])
})
