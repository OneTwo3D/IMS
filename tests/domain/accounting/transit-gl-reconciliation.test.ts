import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTransitReconciliationSweepJournal,
  isTransitLedgerCoverageSatisfied,
  sumTransitSubledgerMovement,
  type TransitGlReconciliationResult,
} from '@/lib/domain/accounting/transit-gl-reconciliation'
import { evaluateAccountGlReconciliation } from '@/lib/domain/accounting/account-gl-reconciliation'

type AggregateCall = { where: { [k: string]: { gt: Date; lte: Date } } }

/** Minimal stand-in for the Prisma client surface sumTransitSubledgerMovement uses.
 *  `ledgerSum` = Σ signed ledger delta (bill debits positive, receipt/reclass/
 *  credit-note credits negative). */
function mockClient(ledgerSum: number | null) {
  const calls: { transitSubledgerMovement?: AggregateCall } = {}
  return {
    calls,
    client: {
      transitSubledgerMovement: {
        aggregate: async (args: AggregateCall) => {
          calls.transitSubledgerMovement = args
          return { _sum: { baseDelta: ledgerSum } }
        },
      },
    } as never,
  }
}

const W_START = new Date('2026-06-19T00:00:00.000Z')
const W_END = new Date('2026-06-20T00:00:00.000Z')

test('subledger movement is the signed ledger total (bill debits net of reclass/receipt credits)', async () => {
  // e.g. 1000.50 bill debit + (-988.00) receipt/reclass credits already summed.
  const { client } = mockClient(12.5)
  assert.equal(await sumTransitSubledgerMovement(W_START, W_END, client), 12.5)
})

test('empty window (null ledger sum) is zero, not NaN', async () => {
  const { client } = mockClient(null)
  assert.equal(await sumTransitSubledgerMovement(W_START, W_END, client), 0)
})

test('a net-drain window (credits exceed debits) is negative', async () => {
  const { client } = mockClient(-42)
  assert.equal(await sumTransitSubledgerMovement(W_START, W_END, client), -42)
})

test('the ledger is windowed half-open on the GL date dimension', async () => {
  const { calls, client } = mockClient(0)
  await sumTransitSubledgerMovement(W_START, W_END, client)
  assert.deepEqual(calls.transitSubledgerMovement?.where.journalDate, { gt: W_START, lte: W_END })
})

function availableResult(subledgerValue: number, glBalance: number): TransitGlReconciliationResult {
  return { available: true, balanceDate: '2026-06-20', ...evaluateAccountGlReconciliation({ subledgerValue, glBalance }) }
}

const TRANSIT_SWEEP = { transitAccount: '1250', roundingAccount: '7999', currency: 'GBP' }

test('Transit sweep journal: subledger above GL → DR Transit / CR Rounding, balanced', () => {
  const journal = buildTransitReconciliationSweepJournal(availableResult(1000.47, 1000.0), TRANSIT_SWEEP)
  assert.ok(journal)
  assert.deepEqual(journal.lines, [
    { accountCode: '1250', description: 'Transit subledger reconciliation 2026-06-20', debit: 0.47 },
    { accountCode: '7999', description: 'Transit subledger reconciliation 2026-06-20', credit: 0.47 },
  ])
  assert.match(journal.narration, /Transit subledger-vs-GL rounding sweep: DR Transit GBP 0\.47/)
})

test('Transit sweep journal: subledger below GL → CR Transit / DR Rounding', () => {
  const journal = buildTransitReconciliationSweepJournal(availableResult(1000.0, 1000.47), TRANSIT_SWEEP)
  assert.ok(journal)
  assert.deepEqual(journal.lines, [
    { accountCode: '1250', description: 'Transit subledger reconciliation 2026-06-20', credit: 0.47 },
    { accountCode: '7999', description: 'Transit subledger reconciliation 2026-06-20', debit: 0.47 },
  ])
})

test('Transit sweep journal: MATERIAL gap flags (no journal); unavailable produces none', () => {
  // A material discrepancy (a missing/double posting, or an uninstrumented transit
  // flow) exceeds the sweep tolerance and is FLAGGED for human review — never swept.
  assert.equal(buildTransitReconciliationSweepJournal(availableResult(1050, 1000), TRANSIT_SWEEP), null)
  assert.equal(
    buildTransitReconciliationSweepJournal({ available: false, reason: 'no_opening_snapshot' }, TRANSIT_SWEEP),
    null,
  )
})

test('Transit sweep journal: a blank rounding account is the opt-out (residue accepted)', () => {
  assert.equal(
    buildTransitReconciliationSweepJournal(availableResult(1000.47, 1000.0), { ...TRANSIT_SWEEP, roundingAccount: '' }),
    null,
  )
})

test('coverage gate: only windows opening on/after the watermark are reconcilable', () => {
  // The ledger is append-only with NO pre-deploy history; a window whose opening
  // precedes the watermark has no subledger data and must degrade to unavailable.
  assert.equal(isTransitLedgerCoverageSatisfied('2026-06-15', new Date('2026-06-20T00:00:00.000Z')), true)
  assert.equal(isTransitLedgerCoverageSatisfied('2026-06-15', new Date('2026-06-15T00:00:00.000Z')), true)
  assert.equal(isTransitLedgerCoverageSatisfied('2026-06-15', new Date('2026-06-14T00:00:00.000Z')), false)
  // Fail closed: a missing or malformed watermark must never let reconciliation run.
  assert.equal(isTransitLedgerCoverageSatisfied(undefined, new Date('2026-06-20T00:00:00.000Z')), false)
  assert.equal(isTransitLedgerCoverageSatisfied('garbage', new Date('2026-06-20T00:00:00.000Z')), false)
  assert.equal(isTransitLedgerCoverageSatisfied('2026-6-1', new Date('2026-06-20T00:00:00.000Z')), false)
})
