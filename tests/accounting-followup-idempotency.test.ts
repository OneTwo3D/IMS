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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-old' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
})

test('reusing a LEGACY FAILED row pins its token EXPLICITLY, not implicitly (o3d-h2wx)', () => {
  // A legacy row's token is its own id. An earlier revision left that implicit -- stamp
  // nothing, rely on the row id surviving -- which meant the token died with the row, so
  // losing it to retention had to be refused. Writing the value down instead reproduces a
  // byte-identical remote key wherever the payload is carried (Codex r4).
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-legacy' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(
    plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    'log-legacy',
    'the stamped key must be the exact token the row already posted under -- its own id',
  )
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
})

test('reuse carries the FAILED row effective token forward, not a freshly derived one (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', invoiceNumber: 'INV-2' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'original-key' },
      effectiveToken: 'original-key',
    }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'original-key')
  // A non-money follow-up re-drives with fresh inputs; only the token is pinned.
  assert.equal(plan.action === 'reuse' ? plan.payload.invoiceNumber : undefined, 'INV-2')
})

test('a non-object payload on the FAILED row does not crash or lose its token (o3d-h2wx)', () => {
  for (const stored of [null, undefined, 'nope', 42]) {
    const plan = planFollowUpEnqueue({
      ...ORDER,
      payload: { accountingInvoiceId: 'inv-9' },
      liveRowExists: false,
      failedRows: [{ id: 'log-old', payload: stored, effectiveToken: 'log-old' }],
    })
    assert.equal(plan.action, 'reuse')
    // An unreadable payload still has a token -- the connector resolved it from the row --
    // and an unknown target counts as possibly-this-one, so it must be pinned.
    assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-old')
    assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-1' }, effectiveToken: 'log-old' }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'old-token' }, effectiveToken: 'log-old' }],
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
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-new' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old' },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-new' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-old' },
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-deleted' }, effectiveToken: 'log-old' }],
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-old', amount: 120 }, effectiveToken: 'log-new' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-old', amount: 120 }, effectiveToken: 'log-old' },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'rotated')
  assert.equal(plan.action === 'reuse' ? plan.payload.accountingInvoiceId : undefined, 'inv-new')
})

test('only rows targeting THIS document count toward the ambiguity (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-other', payload: { accountingInvoiceId: 'inv-other', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-other' },
      { id: 'log-ambiguous', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 110 }, effectiveToken: 'log-ambiguous' },
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
    failedRows: [{ id: 'log-legacy', payload: { amount: 120 }, effectiveToken: 'log-legacy' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
})

test('a same-target money reuse reports pinned/pinned, so the log cannot lie (o3d-h2wx)', () => {
  // Codex r2 #4: the warning was hard-coded to "original token, change suppressed" and so
  // described the exact opposite of what the target-changed path did.
  const pinned = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old' }],
  })
  assert.equal(pinned.action === 'reuse' ? pinned.tokenDisposition : undefined, 'pinned')
  assert.equal(pinned.action === 'reuse' ? pinned.bodyDisposition : undefined, 'pinned')

  const rotated = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old' }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: sameKey }, effectiveToken: 'log-old' }],
  })
  assert.equal(unchanged.action === 'reuse' ? unchanged.tokenDisposition : undefined, 'pinned')

  const changed = planFollowUpEnqueue({
    ...ORDER,
    payload: fresh,
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'some-other-key' }, effectiveToken: 'log-old' }],
  })
  assert.equal(changed.action === 'reuse' ? changed.tokenDisposition : undefined, 'rotated')
})

test('the planner exposes no way to infer not-posted from free text (o3d-h2wx)', () => {
  // Codex r3 blocker A, pinned structurally: the input type must not carry an error message
  // or a flag derived from one, so the sound-looking shortcut cannot come back by accident.
  // effectiveToken is a VALUE the connector resolved, not an inference about what happened.
  const row: FailedFollowUpRow = { id: 'log-1', payload: {}, effectiveToken: 'log-1' }
  assert.deepEqual(Object.keys(row).sort(), ['effectiveToken', 'id', 'payload'])
})

test('a pinned token survives the row it came from disappearing (o3d-h2wx)', () => {
  // THE invariant the design rests on, and what let the tombstone go away (Codex r4).
  //
  // Retention hard-deletes accounting rows by age alone (o3d-nepa), so the FAILED row a
  // pinned token came from can vanish mid-flight. Because the planner writes that token onto
  // the payload, the connector re-plans by feeding plan.payload back in — and the row the
  // re-plan CREATES posts under the identical remote token. No refusal, no tombstone, and
  // nothing that a later retry could resurrect under a rotated token.
  const pinned = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-legacy' }],
  })
  assert.equal(pinned.action, 'reuse')
  const carried = pinned.action === 'reuse' ? pinned.payload : {}
  assert.equal(carried[FOLLOW_UP_IDEMPOTENCY_KEY], 'log-legacy')

  // The row is gone by the time we re-plan.
  const replanned = planFollowUpEnqueue({ ...ORDER, payload: carried, liveRowExists: false, failedRows: [] })
  assert.equal(replanned.action, 'create')
  assert.equal(
    replanned.action === 'create' ? replanned.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    'log-legacy',
    'the created row must post under the vanished row\'s token, or the retry duplicates the payment',
  )

  // And again, so a second lost race cannot rotate it either.
  const twice = planFollowUpEnqueue({
    ...ORDER,
    payload: replanned.action === 'create' ? replanned.payload : {},
    liveRowExists: false,
    failedRows: [],
  })
  assert.equal(twice.action === 'create' ? twice.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-legacy')
})

test('two racing workers that both lose the CAS converge on ONE token (o3d-h2wx)', () => {
  // Codex r4 #3: concurrent lost-CAS workers each wrote their own tombstone with a distinct
  // rotated token. Now both re-plan from the same pinned value, so whichever rows they
  // create carry the identical remote key and the ledger deduplicates them.
  const row = { id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-legacy' }
  const workers = [row, row].map(() => planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9' },
    liveRowExists: false,
    failedRows: [row],
  }))
  const tokens = workers.map((plan) => (plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : null))
  assert.deepEqual(tokens, ['log-legacy', 'log-legacy'])
})

test('a token already being carried is authoritative over a newly-appeared row (o3d-h2wx)', () => {
  // Codex r5 #1: the pin assignment was unconditional, so on a re-plan a FAILED row that
  // appeared in the meantime would displace the token we had already committed to posting
  // under. If the carried token's request had committed, that is a duplicate payment.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-new', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'carried-token' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'carried-token')
})

test('a carried token that CONFLICTS with a surviving row refuses rather than picking one (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'a-different-token' }],
  })
  assert.equal(plan.action, 'refuse')
})

test('ambiguity is counted in DISTINCT TOKENS, not rows (o3d-h2wx)', () => {
  // Codex r5 #3: refusing on row count stranded a case that is not ambiguous at all.
  // Reruns of one QuickBooks receipt all carry `invoice-payment:payment:<id>`, and FAILED
  // rows do not occupy the live slot, so several rows can share one effective token —
  // whichever committed, committed under that token, so pinning it is unambiguous.
  const sharedToken = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'invoice-payment:payment:p1' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'invoice-payment:payment:p1' },
    ],
  })
  assert.equal(sharedToken.action, 'reuse')
  assert.equal(
    sharedToken.action === 'reuse' ? sharedToken.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    'invoice-payment:payment:p1',
  )

  // Genuinely distinct tokens still refuse — that is the case nothing can disambiguate.
  const distinct = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-new' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old' },
    ],
  })
  assert.equal(distinct.action, 'refuse')
  assert.match(distinct.action === 'refuse' ? distinct.reason : '', /different idempotency tokens/i)
})

test('rows sharing one token pin the OLDEST body, not the newest (o3d-h2wx)', () => {
  // Codex r6: a shared token means the remote system deduplicates the attempts, so whichever
  // reached it FIRST is the request that stands. Pinning a newer row's materially different
  // body would record a settlement the ledger never made.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    // newest first, as both connectors order them
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'shared' },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 120)
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'shared')
})

test('a carried token selects the row that used it, not merely the newest (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried' },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'carried' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'carried' },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'carried')
})

test('an INCOMPLETE oldest body is skipped in favour of one that could have posted (o3d-h2wx)', () => {
  // Codex r7 #3: pinning the oldest unconditionally could select a body missing a required
  // field. Both connectors reject such a body BEFORE any HTTP call, so it provably never
  // posted — and pinning it strands the payment behind a request that can never succeed.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'shared' },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-new')
  assert.equal(plan.action === 'reuse' ? plan.payload.bankAccountId : undefined, 'bank-1')
  // The token is still the shared one — completeness selects the BODY, never the token.
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'shared')
})

test('when every shared-token body is incomplete the oldest is still pinned (o3d-h2wx)', () => {
  // No candidate could have posted, so there is nothing to prefer — fall back rather than
  // silently dropping to a rotated token.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', amount: 150 }, effectiveToken: 'shared' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'shared' },
    ],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'shared')
})

test('completeness only applies to money-moving types (o3d-h2wx)', () => {
  // A PDF or note has no required-field guard to prove anything by, so the oldest stands.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9' },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'shared' },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'shared' },
    ],
  })
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
})

test('completeness mirrors the connectors\' guards: falsy ids missing, zero amount valid (o3d-h2wx)', () => {
  // The guards are `!accountingInvoiceId || !bankAccountId || amount == null`, which are not
  // uniform: an id is rejected when FALSY (so '' counts as missing) but an amount only when
  // null/undefined (so a legitimate zero must NOT). Getting either wrong misreads whether an
  // attempt could have posted (Codex review, r8).
  const withBodies = (older: Record<string, unknown>) => planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared' },
      { id: 'log-old', payload: older, effectiveToken: 'shared' },
    ],
  })

  // A zero amount is a real request — the oldest must still win.
  const zero = withBodies({ accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 0 })
  assert.equal(zero.action === 'reuse' ? zero.syncLogId : undefined, 'log-old')

  // An empty-string id is rejected pre-call, so that body provably never posted.
  const blankId = withBodies({ accountingInvoiceId: '', bankAccountId: 'bank-1', amount: 120 })
  assert.equal(blankId.action === 'reuse' ? blankId.syncLogId : undefined, 'log-new')

  const blankBank = withBodies({ accountingInvoiceId: 'inv-9', bankAccountId: '', amount: 120 })
  assert.equal(blankBank.action === 'reuse' ? blankBank.syncLogId : undefined, 'log-new')
})

// ---------------------------------------------------------------------------
// o3d-qsbs — an anchorless legacy money row could block a replacement document for ever.
//
// The issue blames `couldHaveCommittedThis`: a FAILED row with no recorded anchor is treated as
// possibly targeting the document now being posted. That treatment is CORRECT and stays — for money
// movement "unknown target" has to read as "possibly this one" — and the two non-money bullets in
// the issue describe no defect at all, because `moneyMoving` gates both the body pin and the
// refusal, so an anchorless INVOICE_EMAIL or WC_INVOICE_NOTE row has never blocked anything.
//
// The liveness cost the issue actually observed is paid two branches further down, and by a
// different mechanism. An anchorless legacy INVOICE_PAYMENT row is anchorless precisely because it
// has no `accountingInvoiceId` — which is also one of the fields the connector validates BEFORE it
// builds a request. So that row provably never reached the ledger, and yet:
//
//   • with one such row the planner pinned its stored body, re-sending a request the connector
//     rejects out of hand, for ever — the "corrected body never goes out" symptom; and
//   • with two, their tokens were counted as candidates that "may have committed" and the scope
//     refused permanently.
//
// Both now key on the same proof the module already trusted for choosing which body to pin. The
// issue's own fix sketch — backfill `accountingInvoiceId` onto these rows from the parent invoice
// sync row — is NOT implemented, and must not be: it would write the CURRENT invoice id onto a
// historical attempt, asserting that the old attempt targeted a document that may not have existed
// when it ran. That manufactures a match in the duplication direction, which is the one direction
// this module never guesses in.
// ---------------------------------------------------------------------------

test('[o3d-qsbs] one unpostable legacy row pins its TOKEN but not its unusable body', () => {
  // Missing bankAccountId, so `!accountingInvoiceId || !bankAccountId || amount == null` rejects it
  // before any HTTP call. Pinning that body re-sends the same rejection every time and the payment
  // never leaves. The token is still pinned — nothing rotates — because the point is only that this
  // token was never seen remotely, so the RECOMPUTED body is safe to send under it.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { amount: 200 }, effectiveToken: 'log-legacy' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-legacy')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'fresh', 'the unusable body must not be re-sent')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-legacy')
  assert.equal(plan.action === 'reuse' ? plan.payload.bankAccountId : undefined, 'bank-1')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 200)
})

test('[o3d-qsbs] two unpostable legacy rows do not refuse — neither token ever left', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-newer', payload: { amount: 200 }, effectiveToken: 'log-newer' },
      { id: 'log-older', payload: { amount: 200 }, effectiveToken: 'log-older' },
    ],
  })
  assert.equal(plan.action, 'reuse', 'two tokens that were never sent are not two candidates for having committed')
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'fresh')
})

test('[o3d-qsbs] a POSTABLE row still refuses alongside an unpostable one', () => {
  // The exclusion is a proof about ONE row, not a licence to ignore history. A complete body could
  // have committed under its own token, so it and the carried/other candidate still conflict.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [
      { id: 'log-complete', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 }, effectiveToken: 'log-complete' },
      { id: 'log-legacy', payload: { amount: 200 }, effectiveToken: 'log-legacy' },
    ],
  })
  assert.equal(plan.action, 'refuse')
  assert.match(plan.action === 'refuse' ? plan.reason : '', /2 different idempotency tokens/i)
})

test('[o3d-qsbs] an EMPTY stored payload is never proof that nothing posted', () => {
  // `{}` is what retention's compaction leaves behind, and it is indistinguishable from a genuinely
  // empty payload. Negating the postability check would read it as "provably never sent" — retention
  // manufacturing evidence about a remote call — so it counts as a candidate token instead. Money
  // types are not compacted today; the guard is here so that stays true by construction rather than
  // by nobody having widened the compaction predicate yet.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-compacted', payload: {}, effectiveToken: 'log-compacted' }],
  })
  assert.equal(plan.action, 'refuse', 'an unreadable history must not be read as an innocent one')
})

test('[o3d-qsbs] an UNREADABLE stored payload is never proof either', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-null', payload: null, effectiveToken: 'log-null' }],
  })
  assert.equal(plan.action, 'refuse')
})

test('[o3d-qsbs] a compacted body is still never PINNED as the request', () => {
  // The other half of the same distinction: `{}` proves nothing about what was sent, but it also
  // cannot BE sent. An earlier retention attempt pinned exactly such an object as the request body
  // and made money-moving retries permanently unusable (o3d-nepa round 1 finding 2).
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [{ id: 'log-compacted', payload: {}, effectiveToken: 'log-compacted' }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'fresh')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 200)
})
