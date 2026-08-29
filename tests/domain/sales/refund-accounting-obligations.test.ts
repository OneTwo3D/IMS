import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
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
    isTypeEnabledFor: async () => true,
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
    isTypeEnabledFor: async () => true,
  })
  noConnector.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: null })
  noConnector.settle()

  // Connector active, this TYPE switched off: same decision, taken per type.
  const typeOff = await openRefundAccountingObligationLedger([CREDIT_NOTE], {
    activeConnector: async () => 'xero',
    isTypeEnabledFor: async () => false,
  })
  typeOff.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: 'xero' })
  typeOff.settle()

  // But a REFUSAL is never a decision, even when the type is switched off — it is about this call.
  const refusedWhileOff = await openRefundAccountingObligationLedger([CREDIT_NOTE], {
    activeConnector: async () => 'xero',
    isTypeEnabledFor: async () => false,
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

test('o3d-2sm1 r7: the in-transaction arm reads a no-op against the pinned verdict', async () => {
  // The transactional enqueue refuses on a deleted order scope and DECIDES when the type is off.
  // Both wrote nothing; only one of them settles an obligation.
  const declined = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
  declined.accountInTransaction(COGS_REVERSAL, { queued: false, reason: 'refused', connector: 'xero' })
  assert.throws(() => declined.settle(), /the in-transaction enqueue wrote nothing while COGS_REVERSAL was enabled/)

  const switchedOff = await openRefundAccountingObligationLedger([COGS_REVERSAL], {
    activeConnector: async () => 'xero',
    isTypeEnabledFor: async () => false,
  })
  switchedOff.accountInTransaction(COGS_REVERSAL, { queued: false, reason: 'not-configured', connector: 'xero' })
  switchedOff.settle()

  // Switched off UNDER the hand-off, having been enabled when it began: the pinned verdict says this
  // posting was expected to exist, so the no-op is not the decision that was pinned.
  const switchedOffLate = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
  switchedOffLate.accountInTransaction(COGS_REVERSAL, { queued: false, reason: 'not-configured', connector: 'xero' })
  assert.throws(
    () => switchedOffLate.settle(),
    /switched off, though it was enabled when the hand-off began/,
  )

  const queued = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
  queued.accountInTransaction(COGS_REVERSAL, { queued: true, connector: 'xero' })
  queued.settle()
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 8 (Codex HIGH) — THE PIN WAS APPLIED IN ONE ARM ONLY.
 *
 * r7 pinned the connector for the whole hand-off and checked every FACADE answer against it. The
 * in-transaction arm took a bare `true`, which cannot say which connector produced it, while
 * `queueAccountingSyncTx` resolves the active connector for ITSELF — after the pin was taken. So the
 * one arm that could not see a flip was the one arm that did not have to.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-2sm1 r8: a connector flip between the pin and the IN-TRANSACTION enqueue leaves the obligation unmet', async () => {
  const ledger = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())

  // THE FLIP. The row was written — `queueAccountingSyncTx` returned true and the COGS subledger row
  // was recorded beside it — but it was written for QuickBooks, and the credit note that preceded it
  // went to Xero. Under r7 this bare `true` settled the obligation and the recovery flag came down
  // over a refund whose postings are split across two ledgers.
  ledger.accountInTransaction(COGS_REVERSAL, { queued: true, connector: 'quickbooks' })

  assert.throws(
    () => ledger.settle(),
    (error: unknown) => {
      assert.ok(error instanceof RefundAccountingObligationsUnmet)
      assert.equal(error.unmet.length, 1)
      assert.match(error.message, /COGS_REVERSAL for SalesOrderRefund refund-1/)
      assert.match(error.message, /the active accounting connector changed from xero to quickbooks/)
      assert.match(error.message, /queued against a connector it was not reckoned against/)
      return true
    },
  )
})

test('o3d-2sm1 r8: the connector going away mid-hand-off is a flip too, in both arms alike', async () => {
  // ONE RULE, BOTH ARMS: the same sequence of checks, in the same order, over the same outcome shape.
  // The facade arm has always caught this; the transactional arm now catches it identically.
  for (const [arm, apply] of [
    ['facade', (l: Awaited<ReturnType<typeof openRefundAccountingObligationLedger>>) =>
      l.account(COGS_REVERSAL, { queued: true, connector: null })],
    ['in-transaction', (l: Awaited<ReturnType<typeof openRefundAccountingObligationLedger>>) =>
      l.accountInTransaction(COGS_REVERSAL, { queued: true, connector: null })],
  ] as const) {
    const ledger = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
    apply(ledger)
    assert.throws(
      () => ledger.settle(),
      /the active accounting connector changed from xero to none during this hand-off/,
      `${arm}: a connector that vanished under the hand-off must not settle a queued posting`,
    )
  }

  // And the pin is the ONLY thing either arm accepts: the same queued answer under the pinned
  // connector settles in both.
  for (const apply of [
    (l: Awaited<ReturnType<typeof openRefundAccountingObligationLedger>>) =>
      l.account(COGS_REVERSAL, { queued: true, connector: 'xero' }),
    (l: Awaited<ReturnType<typeof openRefundAccountingObligationLedger>>) =>
      l.accountInTransaction(COGS_REVERSAL, { queued: true, connector: 'xero' }),
  ]) {
    const ledger = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled())
    apply(ledger)
    ledger.settle()
  }
})

test('o3d-2sm1 r8: with no connector pinned at all, an enqueue that names one is still a flip', async () => {
  // The direction r7 could not express from a boolean: nothing was configured when the hand-off
  // began — so every obligation was reckoned as "will never post" — and then a connector appeared.
  const ledger = await openRefundAccountingObligationLedger([COGS_REVERSAL], postingEnabled(null))
  ledger.accountInTransaction(COGS_REVERSAL, { queued: true, connector: 'xero' })
  assert.throws(() => ledger.settle(), /the active accounting connector changed from none to xero/)
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
  // r8: THROUGH THE ADAPTER, which is what carries the enqueue's own resolved connector out to the
  // ledger. A bare `queueAccountingSyncTx` here would hand back a boolean again and the pinned check
  // would have nothing to check.
  assert.match(handoff, /queueAccountingSyncTxWithOutcome\(tx, sync\)/)
  assert.ok(
    !/await queueAccountingSyncTx\(tx, sync\)/.test(handoff),
    'the bare-boolean enqueue must not be what this hand-off accounts for',
  )
  assert.match(handoff, /ledger\.accountInTransaction\(sync, outcomeInTx\)/)
  // And the COGS subledger row is still recorded on the queue's OWN decision, not a second recheck.
  assert.match(handoff, /recordRefundCogsReversalFromSync\(tx, sync, outcome\.queued\)/)

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

test('o3d-2sm1 r8: the transactional enqueue names the connector it resolved, on every exit', () => {
  const source = readFileSync(join(process.cwd(), 'lib/accounting.ts'), 'utf8')
  const at = source.indexOf('export async function queueAccountingSyncTx(')
  assert.ok(at > -1, 'the transactional enqueue must be found')
  const body = source.slice(at, source.indexOf('\n}\n', at))

  // A NAKED BOOLEAN IS THE DEFECT. `return true` is precisely the answer that cannot say which
  // connector produced it, and it is what the pinned check had nothing to check.
  const naked = body.split('\n').filter((line) => /(?:^|[ (])return (?:true|false)\b/.test(line))
  assert.deepEqual(naked, [], 'every exit of the transactional enqueue must answer through the out-channel')

  // AND THE QUEUED ANSWERS NAME `context.connector` — the connector the row is actually written
  // under — rather than resolving the active connector a second time. A second read could agree with
  // the pin while the write did not, which is the race being closed, not a check of it.
  //
  // Read as CALL SITES rather than as one exact literal (o3d-ekn8 r4). The previous form counted
  // occurrences of a fixed string, so adding a field to one of the three outcomes failed this
  // assertion while the property it names — every queued answer carries the write's connector —
  // still held. What is asserted is the property.
  const queuedAnswers = [...body.matchAll(/return answer\(\{ queued: true[^}]*\}, ([^)]*)\)/g)]
  assert.equal(
    queuedAnswers.length,
    3,
    'the idempotency hit, the create, and the unique-key collision are the three queued exits',
  )
  for (const answer of queuedAnswers) {
    assert.equal(
      answer[1],
      'context.connector',
      `every queued answer must name the write’s connector, not a second resolution: ${answer[0]}`,
    )
  }

  // o3d-ekn8 r4: and the ONE of the three that writes nothing says so. `queued: true` from the
  // idempotency short-circuit means "the work is on the queue", not "this call put it there" — a
  // caller that rolls its write back on that answer rolls back an empty transaction while a live row
  // is still going to post. Executed against the real enqueue in
  // tests/accounting/enqueue-idempotency-short-circuit.test.ts; pinned here beside its siblings.
  assert.equal(
    queuedAnswers.filter((answer) => answer[0].includes("reason: 'already-queued'")).length,
    1,
    'exactly one queued exit — the short-circuit — reports that it wrote nothing',
  )
  assert.match(body, /return answer\(\{ queued: false, reason: 'refused' \}\)/, 'a deleted order scope is REFUSED, not decided')

  // The adapter must not resolve the connector for itself either: it exists to carry out the one the
  // enqueue resolved.
  const adapterAt = source.indexOf('export async function queueAccountingSyncTxWithOutcome(')
  assert.ok(adapterAt > -1, 'the adapter must be found')
  const adapter = source.slice(adapterAt, source.indexOf('\n}\n', adapterAt))
  assert.ok(
    !/getActiveAccountingConnectorId|getActiveAccountingConnectorInfo/.test(adapter),
    'the adapter must not resolve the connector independently — that is the race, not the fix',
  )
  // And it refuses rather than guessing when the two answers disagree.
  assert.match(adapter, /if \(!outcome \|\| outcome\.queued !== queued\) \{/)
  assert.match(adapter, /return \{ queued: false, reason: 'refused', connector: null \}/)

  // The boolean contract the other call sites read is untouched.
  assert.match(body, /\): Promise<boolean> \{/)
})

/* ------------------------------------------------------------------------------------------------
 * ROUND 9 (Codex HIGH) — THE PINNED VERDICTS WERE NOT PINNED.
 *
 * r8 pinned the connector and checked every ANSWER against it, in both arms. What it did not do was
 * resolve the pinned CONFIGURATION against the pin: each type's verdict was read through a helper
 * that looked the active connector up for itself, after the pin had been taken. An ABA flip — away
 * and back — therefore recorded verdicts belonging to another connector under the pinned one's name,
 * and `willPost` is precisely what licenses the one no-op that may settle an obligation. A late
 * `not-configured` could then discharge a posting the pinned connector was going to make.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The connector flips to QuickBooks the instant after the pin is taken, and back to Xero the instant
 * after the verdict is read — so nothing downstream can see that it ever moved.
 *
 * `isTypeEnabledFor` answers about the connector it is HANDED. The reverted shape resolves `live`
 * instead, which is the defect; the same fake serves both, which is what makes the mutation honest.
 */
function abaFlip(enabledOn: Record<string, boolean>) {
  let live = 'xero'
  const asked: string[] = []
  return {
    asked,
    liveNow: () => live,
    deps: {
      activeConnector: async () => {
        const pinned = live
        live = 'quickbooks'
        return pinned
      },
      isTypeEnabledFor: async (connector: string, _type: AccountingSyncType) => {
        asked.push(connector)
        live = 'xero'
        return enabledOn[connector] ?? false
      },
    },
  }
}

test('o3d-2sm1 r9: an ABA flip between the pin and a type verdict cannot poison the verdict', async () => {
  // CREDIT_NOTE posts on Xero and is switched off on QuickBooks. The hand-off pins Xero.
  const flip = abaFlip({ xero: true, quickbooks: false })
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE], flip.deps)

  assert.equal(ledger.pinnedConnector, 'xero')
  assert.deepEqual(flip.asked, ['xero'], 'the verdict is asked FOR THE PINNED CONNECTOR, explicitly')
  assert.equal(flip.liveNow(), 'xero', 'and the flip has been and gone, so nothing later can see it')

  // THE CONSEQUENCE. A helper that resolved the active connector for itself would have read
  // QuickBooks here, recorded "this posting will never exist", and let the enqueue's no-op settle an
  // obligation the pinned connector was in fact going to post.
  ledger.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: 'xero' })
  assert.throws(
    () => ledger.settle(),
    (error: unknown) => {
      assert.ok(error instanceof RefundAccountingObligationsUnmet)
      assert.match(error.message, /CREDIT_NOTE for SalesOrderRefund refund-1/)
      assert.match(error.message, /switched off, though it was enabled when the hand-off began/)
      return true
    },
  )

  // The in-transaction arm reads the same pinned verdict, so it reaches the same answer.
  const flipTx = abaFlip({ xero: true, quickbooks: false })
  const inTx = await openRefundAccountingObligationLedger([CREDIT_NOTE], flipTx.deps)
  inTx.accountInTransaction(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: 'xero' })
  assert.throws(() => inTx.settle(), /switched off, though it was enabled when the hand-off began/)
})

test('o3d-2sm1 r9: with nothing pinned, no verdict is asked of any connector at all', async () => {
  // "No connector" is a decision the pin already made; asking a per-type helper would only give some
  // other connector's answer a way in.
  const flip = abaFlip({ xero: true, quickbooks: true })
  const ledger = await openRefundAccountingObligationLedger([CREDIT_NOTE, COGS_REVERSAL], {
    ...flip.deps,
    activeConnector: async () => null,
  })
  assert.equal(ledger.pinnedConnector, null)
  assert.deepEqual(flip.asked, [], 'nothing will post, so there is nothing to ask')
  ledger.account(CREDIT_NOTE, { queued: false, reason: 'not-configured', connector: null })
  ledger.accountInTransaction(COGS_REVERSAL, { queued: false, reason: 'not-configured', connector: null })
  ledger.settle()
})

test('o3d-2sm1 r9: the ledger asks for the verdict explicitly, and the hand-off supplies the explicit helper', () => {
  const ledgerSource = readFileSync(join(process.cwd(), 'lib/domain/sales/refund-accounting-obligations.ts'), 'utf8')
  assert.match(
    ledgerSource,
    /willPost\.set\(type, pinnedConnector \? await deps\.isTypeEnabledFor\(pinnedConnector, type\) : false\)/,
    'the verdict must be resolved FOR the pinned connector',
  )
  assert.ok(
    !/deps\.isTypeEnabled\(/.test(ledgerSource),
    'a verdict helper that resolves the active connector for itself is the r9 defect',
  )

  const source = readFileSync(join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  const handoff = source.slice(
    source.indexOf('async function queueRefundAccountingActions(input: {'),
    source.indexOf('async function loadRefundAccountingQueueInput('),
  )
  assert.match(handoff, /isTypeEnabledFor: isAccountingSyncTypeEnabledFor/)
  assert.ok(
    !/isTypeEnabled: isAccountingSyncTypeEnabled\b/.test(handoff),
    'the active-connector form must not be what the pinned hand-off asks',
  )

  // AND THE EXPLICIT FORM IS AN ADDITION, NOT A SUBSTITUTION: the active-connector helper still
  // exists unchanged for its other call sites.
  const accounting = readFileSync(join(process.cwd(), 'lib/accounting.ts'), 'utf8')
  assert.match(accounting, /export async function isAccountingSyncTypeEnabled\(type: AccountingSyncType\): Promise<boolean> \{/)
  assert.match(accounting, /export async function isAccountingSyncTypeEnabledFor\(/)
  // The explicit variant must not resolve the active connector — that is the race, not the fix.
  const at = accounting.indexOf('async function getAccountingPostingContextFor(')
  assert.ok(at > -1, 'the explicit-connector context must be found')
  const body = accounting.slice(at, accounting.indexOf('\n}\n', at))
  assert.ok(
    !/getActiveAccountingConnectorId/.test(body),
    'the explicit-connector verdict must answer about the connector it was given',
  )
})
