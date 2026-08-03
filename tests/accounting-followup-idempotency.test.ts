import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  FOLLOW_UP_IDEMPOTENCY_KEY,
  type FailedFollowUpRow,
  buildFollowUpIdempotencySource,
  planFollowUpEnqueue,
  readFollowUpIdempotencyKey,
  withFollowUpIdempotencyKey,
} from '@/lib/domain/accounting/followup-idempotency'

/**
 * o3d-h2wx: a follow-up's REMOTE idempotency key must survive regeneration of its
 * AccountingSyncLog row.
 *
 * Both connectors derive the remote dedup token from the sync entry's own row id
 * (QuickBooks Request-Id via buildQboRequestId(getIdempotencySource(entryId, ...)),
 * Xero's Idempotency-Key via buildXeroIdempotencyKey(entryId, ...)). hasExistingSyncLog
 * ignores FAILED rows, so re-enqueueing a follow-up — which the back-reference repair
 * sweeps do — creates a NEW row with a NEW id, and therefore a DIFFERENT token.
 *
 * If the FAILED attempt had actually COMMITTED remotely (response lost, or the local
 * status write failed afterwards), the replacement posts under a token the remote system
 * has never seen and a SECOND payment lands against the same invoice. Per-entry
 * idempotency is real, but it does not survive regenerating the entry.
 */

const ORDER = { connector: 'quickbooks', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1' }

test('the follow-up idempotency source does not depend on the sync-log row id (o3d-h2wx)', () => {
  const payload = { accountingInvoiceId: 'inv-9', amount: 120 }
  const first = buildFollowUpIdempotencySource({ ...ORDER, payload })
  const second = buildFollowUpIdempotencySource({ ...ORDER, payload })

  assert.equal(first, second)
  // The whole defect is row-id derivation, so pin that no cuid leaks into the source.
  assert.ok(!/cm[a-z0-9]{20,}/.test(first), `source must not embed a row id; got ${first}`)
})

test('the source separates follow-ups that must NOT share a remote dedup token (o3d-h2wx)', () => {
  const payload = { accountingInvoiceId: 'inv-9' }
  const base = buildFollowUpIdempotencySource({ ...ORDER, payload })

  assert.notEqual(base, buildFollowUpIdempotencySource({ ...ORDER, type: 'INVOICE_PDF', payload }))
  assert.notEqual(base, buildFollowUpIdempotencySource({ ...ORDER, referenceId: 'order-2', payload }))
  assert.notEqual(base, buildFollowUpIdempotencySource({ ...ORDER, referenceType: 'PurchaseInvoice', payload }))
  assert.notEqual(base, buildFollowUpIdempotencySource({ ...ORDER, connector: 'xero', payload }))
})

test('the source is anchored on the external document, so a re-invoiced order is not deduped away (o3d-h2wx)', () => {
  // An order whose invoice was deleted and re-posted needs its payment to reach the NEW
  // invoice. Keying on (type, reference) alone would make the remote system return the
  // ORIGINAL payment against the OLD invoice and we would record a settlement that never
  // happened.
  const first = buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } })
  const second = buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-10' } })
  assert.notEqual(first, second)

  // The allocation follow-up's document is the credit note, not the bill it offsets.
  const allocation = { ...ORDER, type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType: 'SupplierCreditNote' }
  assert.notEqual(
    buildFollowUpIdempotencySource({ ...allocation, payload: { accountingInvoiceId: 'bill-1', creditNoteId: 'cn-1' } }),
    buildFollowUpIdempotencySource({ ...allocation, payload: { accountingInvoiceId: 'bill-1', creditNoteId: 'cn-2' } }),
  )
})

test('an amount or date change does NOT change the key — a retry must still dedupe (o3d-h2wx)', () => {
  // Deliberate: the ambiguous-commit case is a RETRY of the same settlement. If a
  // recomputed amount rotated the key, the exact scenario this fixes would re-open.
  assert.equal(
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', amount: 120, paymentDate: '2026-08-01' } }),
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', amount: 121, paymentDate: '2026-08-02' } }),
  )
})

test('the follow-up key is a field of its OWN, never the generic queue\'s _idempotencyKey (o3d-h2wx)', () => {
  // The blocker Codex found in r1: addPayment already queues INVOICE_PAYMENT rows through
  // queueAccountingSyncTx carrying `_idempotencyKey: invoice-payment:payment:<id>`. Xero's
  // payment branches have ALWAYS ignored that field, so teaching them to read it would
  // change the token of every manual-receipt payment in flight at deploy time — opening
  // the very window this fix closes. A distinct field is only ever set here.
  assert.notEqual(FOLLOW_UP_IDEMPOTENCY_KEY, '_idempotencyKey')
  assert.equal(readFollowUpIdempotencyKey({ _idempotencyKey: 'invoice-payment:payment:p1' }), undefined)
  assert.equal(readFollowUpIdempotencyKey({ [FOLLOW_UP_IDEMPOTENCY_KEY]: 'stable' }), 'stable')
  // Blank is not a token — treating it as present would drop the row's only stable identity.
  assert.equal(readFollowUpIdempotencyKey({ [FOLLOW_UP_IDEMPOTENCY_KEY]: '   ' }), undefined)
  for (const junk of [null, undefined, 'nope', 42, []]) {
    assert.equal(readFollowUpIdempotencyKey(junk), undefined)
  }
})

test('withFollowUpIdempotencyKey stamps the key but never overwrites an existing one (o3d-h2wx)', () => {
  const stamped = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } })
  assert.equal(stamped[FOLLOW_UP_IDEMPOTENCY_KEY], buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } }))

  const preserved = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'already-set' } })
  assert.equal(preserved[FOLLOW_UP_IDEMPOTENCY_KEY], 'already-set')

  const blank = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: '   ' } })
  assert.notEqual(blank[FOLLOW_UP_IDEMPOTENCY_KEY], '   ')
})

test('a live follow-up row short-circuits the enqueue (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' }, liveRowExists: true, failedRows: [] })
  assert.equal(plan.action, 'skip')
})

test('with no prior row the enqueue creates one carrying the stable key (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' }, liveRowExists: false, failedRows: [] })
  assert.equal(plan.action, 'create')
  assert.equal(
    plan.action === 'create' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } }),
  )
})

test('a FAILED follow-up is REUSED, not replaced, so its row id survives (o3d-h2wx)', () => {
  // Reuse is the stronger half of the fix: preserving the row id preserves EVERY token
  // derived from it, including rows already sitting FAILED today with no stamped key.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
})

test('reusing a LEGACY FAILED row must NOT stamp a key — that would rotate its token (o3d-h2wx)', () => {
  // A row enqueued before this change has no follow-up key, so its token comes from the
  // row id. Reuse keeps that row id, so the token is already stable. Stamping a key now
  // would CHANGE it and re-create the double-pay window the fix closes.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF', // non-money, so the fresh payload is kept and only the key rule is under test
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.ok(
    plan.action === 'reuse' && !(FOLLOW_UP_IDEMPOTENCY_KEY in plan.payload),
    'a legacy FAILED row must be retried under the token it already used',
  )
})

test('reuse carries the FAILED row\'s original key forward, not a freshly derived one (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', invoiceNumber: 'INV-2' },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'original-key' } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'original-key')
  // A non-money follow-up re-drives with fresh inputs; only the token is pinned.
  assert.equal(plan.action === 'reuse' ? plan.payload.invoiceNumber : undefined, 'INV-2')
})

test('a non-object payload on the FAILED row does not crash or forge a key (o3d-h2wx)', () => {
  for (const stored of [null, undefined, 'nope', 42]) {
    const plan = planFollowUpEnqueue({
      ...ORDER,
      payload: { accountingInvoiceId: 'inv-9' },
      liveRowExists: false,
      failedRows: [{ id: 'log-old', payload: stored }],
    })
    assert.equal(plan.action, 'reuse')
    assert.ok(
      plan.action === 'reuse' && !(FOLLOW_UP_IDEMPOTENCY_KEY in plan.payload),
      'an unreadable stored payload means "no key was recorded" — fall back to the preserved row id',
    )
  }
})

test('a money-moving reuse pins the REQUEST BODY, not just the token (o3d-h2wx)', () => {
  // Codex r1 #3: posting a recomputed amount under a token the remote system has already
  // seen returns the ORIGINAL payment. We would then record a settlement for an amount
  // that was never posted — local evidence disagreeing with the ledger.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 150, bankAccountId: 'bank-2' },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-1' } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 120)
  assert.equal(plan.action === 'reuse' ? plan.payload.bankAccountId : undefined, 'bank-1')
  // Suppressing a real change silently would be its own defect, so it is reported.
  assert.deepEqual(
    plan.action === 'reuse' ? plan.divergedFields.slice().sort() : [],
    ['amount', 'bankAccountId'],
  )
})

test('a reuse targeting a DIFFERENT document gets a fresh key, not the old token (o3d-h2wx)', () => {
  // Codex r1 #2: the anchors were being derived and then thrown away on reuse. A failed
  // attempt against inv-9 cannot have committed a payment against inv-10, so carrying its
  // token would make the remote system hand back the OLD payment.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'old-token' } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload.accountingInvoiceId : undefined, 'inv-10')
  assert.equal(
    plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-10' } }),
  )
})

test('several FAILED money-moving rows REFUSE rather than guess which token committed (o3d-h2wx)', () => {
  // Codex r1 #4: pre-fix behaviour created a replacement after every failure, and FAILED
  // rows are outside the live-follow-up unique index, so legacy scopes can hold several —
  // each with its own token. Any one may have committed; picking the newest is a guess.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', amount: 120 } },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 } },
    ],
  })
  assert.equal(plan.action, 'refuse')
  assert.match(plan.action === 'refuse' ? plan.reason : '', /duplicate|manually/i)
})

test('several FAILED NON-money rows still retry — a duplicate PDF is not a financial error (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9' },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' } },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' } },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-new')
})

/**
 * Xero's money-moving branches built their Idempotency-Key straight from `entryId`, so a
 * stamped follow-up token was ignored and a regenerated row posted under a key Xero had
 * never seen. They now resolve the source through followUpIdempotencySource(entryId,
 * payload). Asserted against the source because the invariant has to hold for every
 * money-moving call site in the file, including ones added later.
 */
const XERO_PROCESSOR = path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts')
const MONEY_MOVING_XERO_OPS = ['invoice-payment', 'bill-payment', 'purchase-credit-note-allocation']

/**
 * The source argument is itself a call now, so the balanced-paren group is not optional:
 * a plain `[^)]*` stops at the INNER paren and matches nothing, which silently turns both
 * assertions below into no-ops.
 */
function xeroKeyCalls(source: string, op: string): string[] {
  const arg = String.raw`(?:[^()]|\([^()]*\))*`
  return source.match(new RegExp(String.raw`buildXeroIdempotencyKey\(${arg}'${op}'${arg}\)`, 'g')) ?? []
}

test('every Xero money-moving key resolves its source through the follow-up token (o3d-h2wx)', async () => {
  const source = await readFile(XERO_PROCESSOR, 'utf8')

  for (const op of MONEY_MOVING_XERO_OPS) {
    const calls = xeroKeyCalls(source, op)
    assert.ok(calls.length > 0, `expected a '${op}' idempotency key to be built`)
    for (const call of calls) {
      assert.match(
        call,
        /followUpIdempotencySource\(\s*entryId\s*,\s*payload\s*\)/,
        `${call} must resolve its source via followUpIdempotencySource, or a regenerated `
          + 'follow-up posts under a key Xero has never seen and duplicates the payment',
      )
    }
  }
})

test('Xero money-moving branches must NOT start reading the generic _idempotencyKey (o3d-h2wx)', async () => {
  // The r1 blocker, pinned. buildXeroIdempotencyKey prefers payload._idempotencyKey when a
  // payload is passed, and addPayment already sets that field on in-flight INVOICE_PAYMENT
  // rows. Passing `payload` to these branches would rotate their key at deploy time.
  const source = await readFile(XERO_PROCESSOR, 'utf8')

  for (const op of MONEY_MOVING_XERO_OPS) {
    const calls = xeroKeyCalls(source, op)
    assert.ok(calls.length > 0, `expected a '${op}' idempotency key to be built`)
    for (const call of calls) {
      assert.doesNotMatch(
        call,
        /'\s*,\s*payload\s*\)/,
        `${call} must not pass payload as the builder's third argument — that makes it prefer `
          + 'the generic _idempotencyKey and changes the key of every payment already in flight',
      )
    }
  }
})

/**
 * Round 3, from Codex r2. Three of the four new defects came from treating every FAILED row
 * as equally dangerous. The evidence that separates them is already on the row: a failure
 * the connector raised from its OWN validation never reached the network.
 */

test('a same-target money reuse pins the stored body even when it looks wrong (o3d-h2wx)', () => {
  // An earlier revision tried to let a CORRECTED body through when the stored row's
  // errorMessage looked like a pre-call validation failure. That was removed: errorMessage
  // carries no provenance — both connectors overwrite `HTTP nnn` with the remote system's
  // own text, so a remote reply reading "Missing account for PAYMENT" was indistinguishable
  // from our own validation and would have rotated a token that may already have posted
  // (Codex review, r3 blocker A).
  //
  // The cost is real and accepted: a genuinely mis-mapped bank account cannot be corrected
  // automatically. It is reported (divergedFields) and, once it exhausts retries, sits
  // FAILED where the sync UI shows it. A stranded payment that shouts beats a duplicated one.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-new' },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-deleted' } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload.bankAccountId : undefined, 'bank-deleted')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
  assert.deepEqual(plan.action === 'reuse' ? plan.divergedFields : [], ['bankAccountId'])
})

test('several FAILED rows do NOT refuse when none of them targeted this document (o3d-h2wx)', () => {
  // Codex r2 #2: the refusal fired on row COUNT alone, so two failures against a deleted
  // invoice blocked a legitimate payment against its replacement, permanently.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-new', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-old', amount: 120 } },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-old', amount: 120 } },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'rotated')
  assert.equal(plan.action === 'reuse' ? plan.payload.accountingInvoiceId : undefined, 'inv-new')
})

test('only rows targeting THIS document count toward the ambiguity (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-other', payload: { accountingInvoiceId: 'inv-other', amount: 120 } },
      { id: 'log-ambiguous', payload: { accountingInvoiceId: 'inv-9', amount: 110 } },
    ],
  })
  assert.equal(plan.action, 'reuse')
  // The one that could actually have posted this invoice is what must be pinned, not the newest.
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-ambiguous')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 110)
})

test('a FAILED row with no recorded target counts as possibly-this-one (o3d-h2wx)', () => {
  // "Unknown target" must read as "possibly this one" for money: assuming otherwise would
  // rotate the token on exactly the legacy rows least able to survive it.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { amount: 120 } }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
})

test('a same-target money reuse reports pinned/pinned, so the log cannot lie (o3d-h2wx)', () => {
  // Codex r2 #4: the warning was hard-coded to "original token, change suppressed" and so
  // described the exact opposite of what the target-changed path did.
  const pinned = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 150 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 } }],
  })
  assert.equal(pinned.action === 'reuse' ? pinned.tokenDisposition : undefined, 'pinned')
  assert.equal(pinned.action === 'reuse' ? pinned.bodyDisposition : undefined, 'pinned')

  const rotated = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 } }],
  })
  assert.equal(rotated.action === 'reuse' ? rotated.tokenDisposition : undefined, 'rotated')
  assert.equal(rotated.action === 'reuse' ? rotated.bodyDisposition : undefined, 'fresh')
})

test('a rotated disposition is only reported when the token VALUE actually changes (o3d-h2wx)', () => {
  // Codex r3 #F: the rotate branch hard-coded 'rotated', but a new-format row already
  // carries a key derived from scope + anchors. If the recomputed key comes out identical
  // the remote token has not changed, and telling an operator otherwise is a false report.
  const fresh = { accountingInvoiceId: 'inv-10', amount: 120 }
  const sameKey = buildFollowUpIdempotencySource({ ...ORDER, payload: fresh })

  const unchanged = planFollowUpEnqueue({
    ...ORDER,
    payload: fresh,
    liveRowExists: false,
    // Different anchors on the stored payload, so it drops out of the could-have-committed
    // set — but the key it was stamped with is the one we would derive now.
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: sameKey } }],
  })
  assert.equal(unchanged.action === 'reuse' ? unchanged.tokenDisposition : undefined, 'pinned')

  const changed = planFollowUpEnqueue({
    ...ORDER,
    payload: fresh,
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'some-other-key' } }],
  })
  assert.equal(changed.action === 'reuse' ? changed.tokenDisposition : undefined, 'rotated')
})

test('the planner exposes no way to infer "not posted" from free text (o3d-h2wx)', () => {
  // Codex r3 blocker A, pinned structurally: the input type must not carry an error
  // message or a derived flag, so the sound-looking shortcut cannot come back by accident.
  const row: FailedFollowUpRow = { id: 'log-1', payload: {} }
  assert.deepEqual(Object.keys(row).sort(), ['id', 'payload'])
})
