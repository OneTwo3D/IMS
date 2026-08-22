import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  openRefundAccountingObligationLedger,
  RefundAccountingObligationsUnmet,
  type RefundAccountingObligation,
} from '@/lib/domain/sales/refund-accounting-obligations'

/**
 * o3d-2sm1 ROUND 7 (Codex HIGH) — A NON-THROWING QUEUE NO-OP MUST NOT CLEAR THE RECOVERY FLAG.
 *
 * Round 6 moved the clear of `accountingRetryRequired` to after `queueRefundAccountingActions`
 * returns cleanly. The position was right; the contract underneath it was false.
 * `queueAccountingSync` returned `void` and RETURNED NORMALLY WITHOUT PERSISTING ANYTHING on at
 * least four paths — no active connector, the connector's sync or this type switched off, the order
 * deleted under the enqueue, the payload superseded by the coupon backfill. So a clean return was
 * never proof that the work had been queued, and the obligation came down on a no-op: the original
 * defect through a third seam.
 *
 * These model exactly that: an enqueue that RETURNS CLEANLY AND PERSISTS NOTHING. The ledger is what
 * decides whether that reads as success, so it is what is tested.
 */

const CREDIT_NOTE: RefundAccountingObligation = {
  type: 'CREDIT_NOTE',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
}
const COGS_REVERSAL: RefundAccountingObligation = {
  type: 'COGS_REVERSAL',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
}

/** The configuration as it stood when the hand-off began: Xero active, both postings enabled. */
function postingEnabled(connector: string | null = 'xero') {
  return {
    activeConnector: async () => connector,
    isTypeEnabled: async () => true,
  }
}

test('o3d-2sm1 r7: an enqueue that returns cleanly WITHOUT PERSISTING does not discharge the obligation', async () => {
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE], postingEnabled())

  // THE DEFECT, AS THE CALLER SAW IT. `queueAccountingSync` awaited fine and threw nothing; what it
  // actually did was return early having written no row at all. Under round 6 this was
  // indistinguishable from success, and `clearRefundAccountingRetryState` ran on it.
  ledger.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: 'xero' })

  assert.throws(
    () => ledger.settle(),
    (error: unknown) => {
      assert.ok(error instanceof RefundAccountingObligationsUnmet)
      assert.equal(error.unmet.length, 1)
      assert.match(error.message, /CREDIT_NOTE for SalesOrderRefund refund-1/)
      assert.match(error.message, /switched off, though it was enabled when the hand-off began/)
      return true
    },
    'a silent no-op must not read as success',
  )
})

test('o3d-2sm1 r7: a REFUSED enqueue — deleted order, superseded payload — leaves the posting owed', async () => {
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE], postingEnabled())
  // The enqueue took its locks, found the order gone (or the payload stale), logged, and returned
  // normally. Nothing was written and nothing threw.
  ledger.account(CREDIT_NOTE, { queued: false, reason: 'refused', connector: 'xero' })
  assert.throws(() => ledger.settle(), /the enqueue wrote nothing/)
})

test('o3d-2sm1 r7: a durable row settles the obligation, and ALREADY PRESENT counts as durable', async () => {
  const written = await openRefundAccountingObligationLedger([CREDIT_NOTE], postingEnabled())
  written.account(CREDIT_NOTE, { queued: true, connector: 'xero' })
  written.settle()

  // The idempotency-key hit: this call wrote nothing, but a row for the posting is standing, so the
  // GL counterpart exists. That is queued, not a no-op.
  const alreadyThere = await openRefundAccountingObligationLedger([CREDIT_NOTE], postingEnabled())
  alreadyThere.account(CREDIT_NOTE, { queued: true, connector: 'xero' })
  alreadyThere.settle()
})

test('o3d-2sm1 r7: the ONE no-op that settles is the one the PINNED configuration already decided', async () => {
  // An install with no accounting connector owes nothing and must not be left permanently flagged:
  // "nothing will ever post" is a decision, not a lost posting — the same reading the branch gives a
  // recorded `[]` against a missing list.
  const noConnector = await openRefundAccountingObligationLedger([CREDIT_NOTE], {
    activeConnector: async () => null,
    isTypeEnabled: async () => true,
  })
  noConnector.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: null })
  noConnector.settle()

  // Connector active, this TYPE switched off: same decision, taken per type.
  const typeOff = await openRefundAccountingObligationLedger([CREDIT_NOTE], {
    activeConnector: async () => 'xero',
    isTypeEnabled: async () => false,
  })
  typeOff.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: 'xero' })
  typeOff.settle()

  // But a REFUSAL is never a decision, even when the type is switched off — it is about this call.
  const refusedWhileOff = await openRefundAccountingObligationLedger([CREDIT_NOTE], {
    activeConnector: async () => 'xero',
    isTypeEnabled: async () => false,
  })
  refusedWhileOff.account(CREDIT_NOTE, { queued: false, reason: 'refused', connector: 'xero' })
  assert.throws(() => refusedWhileOff.settle(), /the enqueue wrote nothing/)
})

test('o3d-2sm1 r7: the connector is PINNED for the whole hand-off — a flip is an unmet obligation', async () => {
  // Each enqueue resolves the active connector for itself, so a flip part-way through can queue some
  // postings under one connector and silently decide the rest away under another, with a single flag
  // coming down over the mixture.
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE, COGS_REVERSAL], postingEnabled())
  ledger.account(CREDIT_NOTE, { queued: true, connector: 'xero' })
  ledger.account(COGS_REVERSAL, { queued: true, connector: 'quickbooks' })

  assert.throws(
    () => ledger.settle(),
    /COGS_REVERSAL for SalesOrderRefund refund-1 \(the active accounting connector changed from xero to quickbooks/,
  )
})

test('o3d-2sm1 r7: the in-transaction arm reads a bare false against the pinned verdict', async () => {
  // `queueAccountingSyncTx` answers with a boolean shared by fourteen call sites: false means "no GL
  // counterpart", whether because the type is off or because the enqueue declined. Split it here.
  const declined = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
  declined.accountInTransaction(COGS_REVERSAL, false)
  assert.throws(() => declined.settle(), /the in-transaction enqueue wrote nothing while COGS_REVERSAL was enabled/)

  const switchedOff = await openRefundAccountingObligationLedger([COGS_REVERSAL], {
    activeConnector: async () => 'xero',
    isTypeEnabled: async () => false,
  })
  switchedOff.accountInTransaction(COGS_REVERSAL, false)
  switchedOff.settle()

  const queued = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
  queued.accountInTransaction(COGS_REVERSAL, true)
  queued.settle()
})

test('o3d-2sm1 r7: an obligation never handed to an enqueue at all is caught by the count', async () => {
  // The failure mode a later edit produces: a new recorded sync that no arm queues. Silence there
  // would discharge the flag over a posting nobody ever attempted.
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE, COGS_REVERSAL], postingEnabled())
  ledger.account(CREDIT_NOTE, { queued: true, connector: 'xero' })
  assert.throws(() => ledger.settle(), /1 recorded obligation\(s\) were never handed to an enqueue at all/)
})

/* ------------------------------------------------------------------------------------------------
 * THE WIRING, WHICH NO UNIT ABOVE CAN SEE.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-2sm1 r7: every enqueue in the refund hand-off is accounted for, and it settles before it returns', () => {
  const source = readFileSync(join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  const handoff = source.slice(
    source.indexOf('async function queueRefundAccountingActions(input: {'),
    source.indexOf('async function loadRefundAccountingQueueInput('),
  )
  assert.ok(handoff.length > 0, 'the hand-off must be found')

  // The ledger is opened BEFORE the first enqueue — that is what makes the configuration it checks
  // against the one that held when the hand-off began.
  const openAt = handoff.indexOf('await openRefundAccountingObligationLedger(')
  const firstEnqueueAt = handoff.indexOf('queueAccountingSync(')
  assert.ok(openAt > -1 && firstEnqueueAt > openAt, 'the ledger is opened before anything is queued')

  // NO UNACCOUNTED ENQUEUE. Every facade call is an argument to `ledger.account`, and the
  // in-transaction one is followed by `ledger.accountInTransaction`.
  const facadeCalls = [...handoff.matchAll(/(.{0,40})await queueAccountingSync\(/g)]
  assert.equal(facadeCalls.length, 2, 'the credit note and the non-COGS syncs')
  for (const call of facadeCalls) {
    assert.match(call[1], /ledger\.account\(\w+, $/, 'every facade enqueue hands its answer to the ledger')
  }
  assert.match(handoff, /queueAccountingSyncTx\(tx, sync\)/)
  assert.match(handoff, /ledger\.accountInTransaction\(sync, queuedInTx\)/)

  // AND IT SETTLES LAST: nothing may discharge the obligation unless every answer was met.
  const settleAt = handoff.lastIndexOf('ledger.settle()')
  assert.ok(settleAt > handoff.lastIndexOf('ledger.account'), 'settle comes after the last enqueue')
  assert.match(handoff.slice(settleAt), /ledger\.settle\(\)\n\}/, 'and it is the last thing the hand-off does')
})

test('o3d-2sm1 r7: no enqueue path returns without saying what it did', () => {
  // The defect was a `return` that wrote nothing and reported nothing. A bare `return` anywhere in
  // these functions reintroduces it — the caller cannot tell that path from a queued row.
  for (const [file, fn] of [
    ['lib/connectors/xero/queue.ts', 'export async function queueXeroSync('],
    ['lib/connectors/quickbooks/queue.ts', 'export async function queueQuickBooksSync('],
    ['lib/accounting.ts', 'export async function queueAccountingSync('],
  ] as const) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    const at = source.indexOf(fn)
    assert.ok(at > -1, `${file}: ${fn} must be found`)
    // Everything to the end of the function: the next top-level declaration.
    const body = source.slice(at, source.indexOf('\n}\n', at))
    // The transaction bodies inside legitimately `return` to end early; they are closures, not the
    // enqueue, and they sit at eight spaces or deeper. What must never appear is a `return` with
    // nothing after it at the enqueue's OWN indentation — that is the defect, exactly.
    const bare = body.split('\n').filter((line) => {
      const indent = line.length - line.trimStart().length
      return indent <= 6 && /(?:^|[ )])return$/.test(line.trimEnd())
    })
    assert.deepEqual(bare, [], `${file}: every exit of the enqueue must report an outcome`)
    assert.match(body, /reason: 'not-configured'/, `${file}: and it must be able to say "nothing will post"`)
  }
})
