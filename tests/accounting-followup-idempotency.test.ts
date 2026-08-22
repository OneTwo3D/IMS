import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  FOLLOW_UP_IDEMPOTENCY_KEY,
  type FailedFollowUpRow,
  type FollowUpPayload,
  buildFollowUpIdempotencySource,
  planFollowUpEnqueue,
  readFollowUpIdempotencyKey,
  storedBodyMayHaveReachedTheLedger,
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

/**
 * o3d-0m56 round 10 — WHAT HAS HANDLED a row is what its unstamped `remoteAttemptedAt` proves, so
 * every row double has to say so. It is a PRESENCE, not an instant: round 9 compared the row's
 * `createdAt` against a global epoch, and Codex round 10 showed that boundary being crossed by a
 * clock skew, by a cached read that ignored the documented reset, and by a rollback.
 *
 * `attemptStampingCustodyAt` is written by binaries that stamp before every money call — at create,
 * and at every claim — and is taken away by the database's forfeit trigger from any row claimed by
 * a binary that does not. Its VALUE is never compared with anything, which is why the doubles below
 * use one deliberately absurd timestamp for it.
 */
const IN_CUSTODY = new Date('2026-08-01T09:00:00Z')
/**
 * The same fact, carried by a row whose custody was taken in a completely different year from
 * anything else in these tests. Nothing may read it as an instant, so nothing may care.
 */
const IN_CUSTODY_LONG_AGO = new Date('1999-01-01T00:00:00Z')
/**
 * A row a binary outside stamping custody created (the column did not exist for it) or claimed (the
 * trigger nulled it) — unstamped because nothing stamped it, not because nothing was sent from it.
 */
const OUTSIDE_CUSTODY = null

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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: IN_CUSTODY,
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
      failedRows: [{ id: 'log-old', payload: stored, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-1' }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'old-token' }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-new', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-new', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120, bankAccountId: 'bank-deleted' }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-old', amount: 120 }, effectiveToken: 'log-new', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-old', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-other', payload: { accountingInvoiceId: 'inv-other', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-other', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-ambiguous', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 110 }, effectiveToken: 'log-ambiguous', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
    failedRows: [{ id: 'log-legacy', payload: { amount: 120 }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(pinned.action === 'reuse' ? pinned.tokenDisposition : undefined, 'pinned')
  assert.equal(pinned.action === 'reuse' ? pinned.bodyDisposition : undefined, 'pinned')

  const rotated = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: sameKey }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(unchanged.action === 'reuse' ? unchanged.tokenDisposition : undefined, 'pinned')

  const changed = planFollowUpEnqueue({
    ...ORDER,
    payload: fresh,
    liveRowExists: false,
    failedRows: [{ id: 'log-old', payload: { accountingInvoiceId: 'inv-9', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'some-other-key' }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(changed.action === 'reuse' ? changed.tokenDisposition : undefined, 'rotated')
})

test('the planner exposes no way to infer not-posted from free text (o3d-h2wx)', () => {
  // Codex r3 blocker A, pinned structurally: the input type must not carry an error message
  // or a flag derived from one, so the sound-looking shortcut cannot come back by accident.
  // effectiveToken, remoteAttemptedAt and attemptStampingCustodyAt are all VALUES the connector
  // read off the row — a resolved token, a claimed timestamp, and the custody the row carries — not
  // inferences about what the failure meant.
  const row: FailedFollowUpRow = { id: 'log-1', payload: {}, effectiveToken: 'log-1', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }
  assert.deepEqual(Object.keys(row).sort(),
    ['attemptStampingCustodyAt', 'effectiveToken', 'id', 'payload', 'remoteAttemptedAt'])
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
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
  const row = { id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }
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
    failedRows: [{ id: 'log-new', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'carried-token', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'carried-token')
})

test('a carried token that CONFLICTS with a surviving row refuses rather than picking one (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'a-different-token', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'invoice-payment:payment:p1', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'invoice-payment:payment:p1', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-new', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'log-old', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'carried', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'carried', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', amount: 150 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-new', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 150 }, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-old', payload: older, effectiveToken: 'shared', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
    failedRows: [{ id: 'log-legacy', payload: { amount: 200 }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
      { id: 'log-newer', payload: { amount: 200 }, effectiveToken: 'log-newer', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-older', payload: { amount: 200 }, effectiveToken: 'log-older', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
      { id: 'log-complete', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 }, effectiveToken: 'log-complete', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      { id: 'log-legacy', payload: { amount: 200 }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
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
    failedRows: [{ id: 'log-compacted', payload: {}, effectiveToken: 'log-compacted', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(plan.action, 'refuse', 'an unreadable history must not be read as an innocent one')
})

test('[o3d-qsbs] an UNREADABLE stored payload is never proof either', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200, [FOLLOW_UP_IDEMPOTENCY_KEY]: 'carried-token' },
    liveRowExists: false,
    failedRows: [{ id: 'log-null', payload: null, effectiveToken: 'log-null', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
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
    failedRows: [{ id: 'log-compacted', payload: {}, effectiveToken: 'log-compacted', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'fresh')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 200)
})

test('[o3d-qsbs] an UNSENDABLE row never displaces the token of one that may have committed', () => {
  // Codex r10 #1. The split between "could this be sent" and "is there proof nothing left" is
  // right, but token selection did not follow it through: `couldHaveCommitted[0]` is simply the
  // NEWEST surviving row. Here the newest is a legacy body missing `accountingInvoiceId` and
  // `bankAccountId`, so both connectors reject it before any HTTP call — it provably never posted,
  // and its token was correctly excluded from the ambiguity count, so nothing refuses. The OLDER
  // row is a complete body that may well have committed under `tok-sent`.
  //
  // Pinning the unsendable row's token sends the retry under a key the ledger has never seen while
  // a payment under `tok-sent` may already stand: two payments against one invoice.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-unsendable', payload: { amount: 200 }, effectiveToken: 'tok-never-left', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      {
        id: 'log-sendable',
        payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
        effectiveToken: 'tok-sent',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
      },
    ],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(
    plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    'tok-sent',
    'the retry must go out under the token of the attempt that may have committed, not the one that provably never left',
  )
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-sendable')
  // ...and because that attempt may have committed, its BODY is pinned too: a recomputed amount
  // under a token the ledger already saw records a settlement that never happened.
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'pinned')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'pinned')
})

test('[o3d-qsbs] the may-have-committed token wins even when the unsendable row is the only complete-looking one', () => {
  // The same hazard where the unsendable row carries the anchor. `couldHaveCommittedThis` still
  // matches both (the older row names the same invoice; the newer one names nothing, which reads as
  // "possibly this one"), and the newer one is missing `bankAccountId` so it provably never posted.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 200 },
    liveRowExists: false,
    failedRows: [
      { id: 'log-unsendable', payload: { accountingInvoiceId: 'inv-9', amount: 200 }, effectiveToken: 'tok-never-left', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY },
      {
        id: 'log-sendable',
        payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 175 },
        effectiveToken: 'tok-sent',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
      },
    ],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'tok-sent')
  // The pinned body is the one that may have posted — 175, not the recomputed 200.
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 175)
  assert.equal(plan.action === 'reuse' ? plan.bodyDisposition : undefined, 'pinned')
})

// --- o3d-19gy: a repair may not rewrite whose ledger the row was raised against ---------------
//
// Codex r1 finding 2 (CRITICAL). The connectors stamp the freshly-rebuilt follow-up payload with the
// CURRENTLY connected organisation and hand it to this planner for both outcomes. On a revival that
// stamp is not a fact about the new work — the row already records which organisation its earlier
// attempt was made against, and that record is the only evidence the post-time guard has. Overwriting
// it does not merely lose evidence, it FORGES agreement: a payment first attempted against
// organisation A, revived while connected to B, still pinned to A's idempotency token, sailed through
// a guard that was comparing B against B.
//
// cvj9's rule, literally: a marker may only be written by the row that actually took the action.

const CONNECTION_KEY = '_connectionProvenance'

test('o3d-19gy: a NON-MONEY revival carries the ROW own origin, not the current connection', () => {
  // The path that actually rewrote it. The money path keeps the stored body wholesale and so kept the
  // stamp by accident; this one rebuilds the body from the caller's freshly-stamped payload.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', invoiceNumber: 'INV-2', [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', [CONNECTION_KEY]: 'xero:tenant-A', [FOLLOW_UP_IDEMPOTENCY_KEY]: 'original-key' },
      effectiveToken: 'original-key',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
  assert.equal(
    plan.action === 'reuse' ? plan.payload[CONNECTION_KEY] : undefined,
    'xero:tenant-A',
    'the revived row must still say organisation A — it is the only evidence that A was ever involved',
  )
  // ...and the things that SHOULD be carried still are: A's token, and the fresh body.
  assert.equal(plan.action === 'reuse' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'original-key')
  assert.equal(plan.action === 'reuse' ? plan.payload.invoiceNumber : undefined, 'INV-2')
})

// PASSES UNDER REVERT, DELIBERATELY. The money path pins the stored body wholesale, so it carried the
// stored stamp by accident rather than by rule. This pins that accident as a requirement: the next
// person to "tidy" the money branch into rebuilding from the fresh payload would otherwise reopen
// finding 2 on the only path where the body is A's as well as the token.
test('o3d-19gy: a MONEY revival keeps organisation A on the row, so the post-time guard can still refuse', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-2', amount: 150, [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, [CONNECTION_KEY]: 'xero:tenant-A' },
      effectiveToken: 'log-old',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload[CONNECTION_KEY] : undefined, 'xero:tenant-A')
  assert.equal(plan.action === 'reuse' ? plan.payload.amount : undefined, 120, 'and A body is still the pinned one')
})

test('o3d-19gy: a repair does not INVENT an origin for a legacy row that recorded none', () => {
  // The row predates stamping. It took an action, under some organisation, and nobody wrote it down.
  // Stamping the current one now would claim knowledge the repair does not have — the post-time verdict
  // must go on reading this as `no-origin-recorded`, which is the truth, and (since Codex r3 finding 2)
  // refuse it rather than wave it through.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    type: 'INVOICE_PDF',
    payload: { accountingInvoiceId: 'inv-9', [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{ id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9' }, effectiveToken: 'log-legacy', remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY }],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(
    plan.action === 'reuse' ? CONNECTION_KEY in plan.payload : true,
    false,
    'no origin was recorded, and a repair is not a witness',
  )
})

test('o3d-19gy: a spent row from ANOTHER organisation is left intact and the new work gets its own row', () => {
  // Nothing is carried back on this branch — the token is freshly derived and the body recomputed — so
  // reusing the row would be pure bookkeeping. Bookkeeping tidiness is not a reason to erase the only
  // surviving trace that an attempt was made against organisation A. A new row costs one insert; it
  // also avoids stranding B's legitimate work behind a post-time refusal it could never satisfy.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', amount: 120, [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-tenant-a',
      payload: { accountingInvoiceId: 'inv-9', amount: 120, [CONNECTION_KEY]: 'xero:tenant-A' },
      effectiveToken: 'log-tenant-a',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'create', 'organisation A row is not repurposed')
  assert.equal(plan.action === 'create' ? plan.payload[CONNECTION_KEY] : undefined, 'xero:tenant-B')
})

// PASSES UNDER REVERT, DELIBERATELY — it is the control. A guard is only worth having if the ordinary
// path is untouched by it, and this is the assertion that the new refusal did not swallow the common case.
test('o3d-19gy: a spent row from the SAME organisation is still reused, so nothing ordinary changed', () => {
  // The case that outranks the fix. Same organisation, different document: this is the ordinary
  // spent-row reuse and it must be completely unaffected.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', amount: 120, [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-same-org',
      payload: { accountingInvoiceId: 'inv-9', amount: 120, [CONNECTION_KEY]: 'xero:tenant-B' },
      effectiveToken: 'log-same-org',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-same-org')
  assert.equal(plan.action === 'reuse' ? plan.payload[CONNECTION_KEY] : undefined, 'xero:tenant-B')
})

test('o3d-19gy: an UNREADABLE origin on the spent row is not treated as a match', () => {
  // Two unreadable values are not "the same value". A row whose stamp cannot be read is a row something
  // this module does not recognise has written, and repurposing it would destroy whatever it meant.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', amount: 120, [CONNECTION_KEY]: 'xero:tenant-B' },
    liveRowExists: false,
    failedRows: [{
      id: 'log-garbled',
      payload: { accountingInvoiceId: 'inv-9', amount: 120, [CONNECTION_KEY]: 42 },
      effectiveToken: 'log-garbled',
      remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'create')
})

// ---------------------------------------------------------------------------
// ONE PREDICATE FOR "DID THIS ATTEMPT REACH THE LEDGER" (o3d-m5qk)
// ---------------------------------------------------------------------------
//
// Two branches arrived at this merge with a version of the question, and they answer differently on
// exactly one input: an EMPTY `{}` body. The pin-selection predicate (`bodyCouldHaveReachedTheLedger`,
// private) reads `{}` as "could not have been sent", because it is missing every required field. The
// capacity guards must NOT read it that way: retention compacts a payload to `{}`, so reading a
// compacted body as proof that nothing posted is retention manufacturing evidence about a remote call.
// `storedBodyMayHaveReachedTheLedger` is built on `bodyProvesNoCallLeft` for that reason, and it is
// the ONE definition both capacity guards import — the sales one and the supplier one.

test('o3d-m5qk: a RETENTION-COMPACTED body is not proof that nothing posted', () => {
  // The case the two branches disagreed about, and the one that pays a supplier twice if it goes the
  // other way: `{}` is what a payload looks like after retention has compacted it away, and it is
  // indistinguishable from a body that was never populated.
  assert.equal(storedBodyMayHaveReachedTheLedger('INVOICE_PAYMENT', {}), true)
  assert.equal(storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', {}), true)
})

test('o3d-m5qk: an unreadable or absent body is not proof either', () => {
  for (const payload of [null, undefined, 'not an object', 42, ['array']]) {
    assert.equal(
      storedBodyMayHaveReachedTheLedger('INVOICE_PAYMENT', payload),
      true,
      `${JSON.stringify(payload) ?? 'undefined'} must not be read as "nothing was sent"`,
    )
  }
})

test('o3d-m5qk: a PRESENT body missing a field the connector rejects pre-call IS proof', () => {
  // The one sound "this did not post" signal in the system. Both connectors validate before they build
  // a request, so a body they would have rejected never reached the wire — and this is the only
  // exemption either capacity guard grants a FAILED money row.
  assert.equal(
    storedBodyMayHaveReachedTheLedger('INVOICE_PAYMENT', { accountingInvoiceId: 'INV-1', amount: 10 }),
    false,
    'no bankAccountId: the Xero INVOICE_PAYMENT case returns before building a request',
  )
  assert.equal(
    storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', { bankAccountId: 'bank-1', amount: 10 }),
    false,
    'no accountingInvoiceId, and the supplier guard is the identical shape',
  )
  // A complete body could have been sent, so it counts against capacity.
  assert.equal(
    storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', { accountingInvoiceId: 'INV-1', bankAccountId: 'b', amount: 10 }),
    true,
  )
})

test('o3d-m5qk: a legitimate ZERO amount is present, and an empty-string id is not', () => {
  // Mirrors the connectors' guards exactly, which are not uniform: `!accountingInvoiceId` rejects an
  // empty string, while `amount == null` accepts a zero. Getting either wrong misreads whether an
  // attempt could have posted.
  assert.equal(
    storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', { accountingInvoiceId: 'INV-1', bankAccountId: 'b', amount: 0 }),
    true,
    'a zero-value payment is a request the connector would have sent',
  )
  assert.equal(
    storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', { accountingInvoiceId: '', bankAccountId: 'b', amount: 10 }),
    false,
    'an empty id is falsy, and the connector rejects it before building anything',
  )
})

test('o3d-m5qk: a type with no declared required fields answers "may have posted"', () => {
  // Non-money follow-ups (PDF, attachment, note) have no pre-call validation to prove anything from, so
  // nothing about them is ever proof that no call was made.
  assert.equal(storedBodyMayHaveReachedTheLedger('INVOICE_PDF', {}), true)
  assert.equal(storedBodyMayHaveReachedTheLedger('INVOICE_PDF', { anything: 1 }), true)
})

test('o3d-m5qk: the two capacity guards import the ONE predicate rather than deriving their own', async () => {
  // The whole point of merging them. Two guards deriving "nothing was sent" differently would disagree
  // about whether a document still has capacity, which for money is the entire question — and the
  // disagreement would be invisible, because each one is individually reasonable.
  const root = process.cwd()
  for (const file of [
    'lib/domain/accounting/invoice-payment-capacity.ts',
    'lib/domain/accounting/payment-reversal.ts',
  ]) {
    const src = await readFile(path.join(root, file), 'utf8')
    assert.ok(
      src.includes("import { storedBodyMayHaveReachedTheLedger } from '@/lib/domain/accounting/followup-idempotency'"),
      `${file} must import the shared predicate`,
    )
    assert.equal(
      src.indexOf('REQUIRED_BODY_FIELDS'),
      -1,
      `${file} must not re-derive the required-field table — that is the second definition`,
    )
  }
})

/* --------------------------------------------------------------------------------------- *
 * o3d-0m56 round 8 (Codex, HIGH) — A REVIVAL MUST NOT DESTROY THE EVIDENCE OF WHAT WAS
 * ATTEMPTED.
 *
 * The revival is a WRITE OVER the recycled row's payload, and that payload IS the row's
 * attempt: its anchors say which document it targeted, its amount and date say what it sent,
 * and `_followUpIdempotencyKey` (or, for a legacy row, its id) is the token whose mark the
 * ledger carries. Reaching the rotate branch means every surviving FAILED row targets a
 * DIFFERENT document — so the row it used to grab was, by construction, the record of an
 * attempt against another invoice.
 * --------------------------------------------------------------------------------------- */

test('an ATTEMPTED FAILED row is never recycled — its payload is evidence (o3d-0m56)', () => {
  // log-old posted to inv-9 and lost its response. The order is now re-invoiced as inv-10, so
  // nothing surviving could have committed inv-10 and the token must rotate. Rotating it ON TOP
  // of log-old would throw away the only local record that inv-9 was ever paid.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, paymentDate: '2026-08-01' },
      effectiveToken: 'log-old',
      remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'),
      attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'create', 'a row a remote call left must be left exactly as it is')
  assert.equal(plan.action === 'create' ? plan.payload.accountingInvoiceId : undefined, 'inv-10')
  assert.equal(
    plan.action === 'create' ? plan.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined,
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-10' } }),
  )
})

test('a never-attempted FAILED row is still recycled — it records nothing (o3d-0m56)', () => {
  // remoteAttemptedAt is claimed by one conditional write immediately before the remote call, so
  // NULL is proof no call ever left this row — PROVIDED nothing but a binary that claims the stamp
  // has handled the row, which is what `attemptStampingCustodyAt` being present establishes. Its
  // payload is then a plan, not a record, and reusing the row rather than accumulating replacements
  // costs nothing.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
      effectiveToken: 'log-old',
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: IN_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
  assert.equal(plan.action === 'reuse' ? plan.tokenDisposition : undefined, 'rotated')
})

test('the recycle steps over an attempted row and takes an unattempted one (o3d-0m56)', () => {
  // Newest first. log-sent posted; log-unsent was rejected before any call was made. Only the
  // second may be written over, and the choice must not be "whichever happens to be first".
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      {
        id: 'log-sent',
        payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
        effectiveToken: 'log-sent',
        remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'),
        attemptStampingCustodyAt: IN_CUSTODY,
      },
      {
        id: 'log-unsent',
        payload: { accountingInvoiceId: 'inv-8', bankAccountId: 'bank-1', amount: 120 },
        effectiveToken: 'log-unsent',
        remoteAttemptedAt: null,
        attemptStampingCustodyAt: IN_CUSTODY,
      },
    ],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-unsent')
})

test('a re-invoiced order cannot rotate away the token its first payment posted under (o3d-0m56)', () => {
  // THE DOUBLE POST THIS CLOSES, played out as the connector plays it.
  //
  //  1. A LEGACY row (no stamped key, so its token IS its row id) posts £100 to inv-9. Xero
  //     commits it and the response is lost; the row ends FAILED with remoteAttemptedAt set and
  //     a payment in the ledger marked settlementMarkerFor('log-a').
  //  2. inv-9 is voided and re-raised as inv-10. The sweep re-enqueues, and nothing surviving
  //     could have committed inv-10 — so the token legitimately rotates.
  //  3. inv-10 turns out to be the wrong document (the void is reversed, the back-reference
  //     resolves to inv-9 again) and a payment for inv-9 is enqueued once more.
  //
  // Step 3 must pin 'log-a'. `ledgerClearsFollowUpRevival` only probes a PINNED token, and the
  // probe only recognises the committed payment by settlementMarkerFor('log-a') — the amount and
  // date fallback loses it the moment either is recomputed. Recycling log-a at step 2 rotated its
  // token and erased its anchors, so step 3 saw no attempt at all, skipped the probe, and paid
  // inv-9 twice.
  type Row = { id: string; payload: FollowUpPayload; remoteAttemptedAt: Date | null; attemptStampingCustodyAt: Date | null }
  const rows: Row[] = [{
    id: 'log-a',
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-08-01' },
    remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'),
    attemptStampingCustodyAt: IN_CUSTODY,
  }]
  // Xero's followUpIdempotencySource, exactly: the stamped key when there is one, else the row id.
  const asFailedRow = (row: Row): FailedFollowUpRow => ({
    id: row.id,
    payload: row.payload,
    effectiveToken: readFollowUpIdempotencyKey(row.payload) ?? row.id,
    remoteAttemptedAt: row.remoteAttemptedAt,
    attemptStampingCustodyAt: row.attemptStampingCustodyAt,
  })
  // What both connectors do with a plan: a reuse OVERWRITES the row's payload, a create adds one.
  const apply = (plan: ReturnType<typeof planFollowUpEnqueue>, newId: string) => {
    if (plan.action === 'reuse') rows.find((row) => row.id === plan.syncLogId)!.payload = plan.payload
    else if (plan.action === 'create') rows.unshift({ id: newId, payload: plan.payload, remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY })
    else assert.fail(`unexpected plan ${plan.action}`)
  }

  apply(planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-09-01' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  }), 'log-b')

  const stillThere = rows.find((row) => row.id === 'log-a')!
  assert.equal(stillThere.payload.accountingInvoiceId, 'inv-9', 'the attempt against inv-9 must survive')
  assert.equal(stillThere.payload.amount, 100)
  assert.equal(readFollowUpIdempotencyKey(stillThere.payload), undefined, 'and must not be given a new token')

  const back = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 105, paymentDate: '2026-09-02' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  })

  assert.equal(back.action, 'reuse')
  assert.equal(back.action === 'reuse' ? back.syncLogId : undefined, 'log-a')
  assert.equal(back.action === 'reuse' ? back.tokenDisposition : undefined, 'pinned',
    'a rotated disposition here would ALSO skip the ledger probe, which is the double post')
  assert.equal(back.action === 'reuse' ? back.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-a',
    'the token must be the one the committed payment carries the mark of')
  assert.equal(back.action === 'reuse' ? back.payload.amount : undefined, 100,
    'and the body stays pinned, so a recomputed amount cannot record a settlement never made')
})

/* --------------------------------------------------------------------------------------- *
 * o3d-0m56 round 10 (Codex, HIGH x3) — AN UNSTAMPED ROW IS ONLY EVIDENCE OF NOTHING WHEN
 * NOTHING BUT A STAMPING BINARY HAS HANDLED IT, AND THE ROW SAYS SO ITSELF.
 *
 * Round 9 said "created at or after a recorded epoch". Three ways that was not enough, all of
 * them the same shape — the thing that made the premise true lived outside the row:
 *
 *   1. the epoch came from the app process's clock and `createdAt` from the database's, so a
 *      skew put rows on the wrong side of the boundary;
 *   2. the documented recovery (delete the settings key) was invisible to a process that had
 *      already cached the epoch;
 *   3. a ROLLBACK posts unstamped rows AFTER an epoch established once — and a rollback is a
 *      sequential deploy, so the "no overlap" order round 9 leaned on was satisfied throughout.
 *
 * `attemptStampingCustodyAt` carries the fact instead: written by binaries that stamp, at create
 * and at every claim, and taken away by the database from any row a binary that does not stamp
 * claims. The tests below cover the deploy window, a ROLLBACK, and a CLOCK SKEW.
 * --------------------------------------------------------------------------------------- */

test('a FAILED money row created outside stamping custody is never recycled (o3d-0m56 r10)', () => {
  // log-old was created after the migration's backfill and before the new process was live, so
  // nothing stamped it and nothing gave it custody — but a payment for inv-9 may well be sitting
  // in Xero under its token.
  // Reaching the rotate branch means the row targets a DIFFERENT document from the one being
  // enqueued, which is exactly when recycling would overwrite it.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{
      id: 'log-old',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, paymentDate: '2026-06-30' },
      effectiveToken: 'log-old',
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: OUTSIDE_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'create',
    'a NULL stamp on a row nothing was going to stamp proves nothing, so its payload is not disposable')
})

test('a ROLLBACK that claimed this binary\'s row costs that row its custody (o3d-0m56 r10)', () => {
  // FINDING 3, at the planner. log-mine was created by a stamping binary — under round 9's rule it
  // was created after the epoch, so its NULL stamp was "proof". Then the binary was ROLLED BACK,
  // the old version claimed the row and posted from it, and nothing stamped that call.
  //
  // Round 9 had no way to see this: the epoch is established once and the row's createdAt never
  // moves, so the row still sat on the trusted side of the boundary and its payload was recycled
  // away. Custody CAN see it — the claim came through the database's forfeit trigger, which nulls
  // the column for any claim that does not re-assert it, and a rolled-back binary cannot re-assert
  // a column it has never heard of.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{
      id: 'log-mine',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120, paymentDate: '2026-08-02' },
      effectiveToken: 'log-mine',
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: OUTSIDE_CUSTODY,
    }],
  })

  assert.equal(plan.action, 'create',
    'a row whose custody a rollback forfeited is not disposable, whenever it was created')
})

test('NO CLOCK is consulted: the custody stamp is read as a presence, never as an instant (o3d-0m56 r10)', () => {
  // FINDING 1. Round 9 compared two timestamps written by two different machines, and being a few
  // seconds out on the wrong side of that comparison meant an attempted row read as never-attempted.
  //
  // Custody removes the comparison. These two rows carry custody stamps 27 years apart — one long
  // before any epoch this test file mentions, one in a future no clock on either machine has
  // reached — and both are recycled, because the only question asked of the column is whether it is
  // there. There is no boundary for a skew to move a row across.
  const withCustody = (custodyAt: Date) => planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [{
      id: 'log-skewed',
      payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
      effectiveToken: 'log-skewed',
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: custodyAt,
    }],
  })

  for (const custodyAt of [IN_CUSTODY_LONG_AGO, new Date('2099-12-31T23:59:59Z')]) {
    const plan = withCustody(custodyAt)
    assert.equal(plan.action, 'reuse', `custody at ${custodyAt.toISOString()} must still be custody`)
    assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-skewed')
  }
})

test('the recycle steps over a row outside custody and takes one inside it (o3d-0m56 r10)', () => {
  // Newest first, and neither row carries a stamp — so under round 8's rule alone both looked
  // disposable. Only the one whose custody is intact may be written over, and the choice must not
  // be "whichever happens to be first".
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 120 },
    liveRowExists: false,
    failedRows: [
      {
        id: 'log-rolled-back',
        payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 120 },
        effectiveToken: 'log-rolled-back',
        remoteAttemptedAt: null,
        attemptStampingCustodyAt: OUTSIDE_CUSTODY,
      },
      {
        id: 'log-mine',
        payload: { accountingInvoiceId: 'inv-8', bankAccountId: 'bank-1', amount: 120 },
        effectiveToken: 'log-mine',
        remoteAttemptedAt: null,
        attemptStampingCustodyAt: IN_CUSTODY,
      },
    ],
  })

  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-mine')
})

test('the deploy-window double post, played out end to end (o3d-0m56 r10)', () => {
  // THE DEFECT, as the connector would live it:
  //
  //  1. `prisma migrate deploy` backfills every money row that exists. The build starts.
  //  2. The OLD binary — still serving — queues log-a for inv-9 and posts £100. Xero commits it
  //     and the response is lost. log-a ends FAILED, and UNSTAMPED, because the old binary has no
  //     `authoriseMoneyPost` to claim the stamp.
  //  3. The new process comes up. inv-9 is voided and re-raised as inv-10, and the sweep
  //     re-enqueues. Nothing surviving could have committed inv-10, so the token rotates.
  //  4. The void is reversed and a payment for inv-9 is enqueued again.
  //
  // Under round 8's rule step 3 recycled log-a (its NULL stamp read as "never sent"), erasing the
  // £100/inv-9 attempt. Step 4 then found no attempt against inv-9, rotated a fresh token, and
  // `ledgerClearsFollowUpRevival` never probed — inv-9 paid twice.
  type Row = { id: string; payload: FollowUpPayload; remoteAttemptedAt: Date | null; attemptStampingCustodyAt: Date | null }
  const rows: Row[] = [{
    id: 'log-a',
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-06-30' },
    remoteAttemptedAt: null,
    attemptStampingCustodyAt: OUTSIDE_CUSTODY,
  }]
  const asFailedRow = (row: Row): FailedFollowUpRow => ({
    id: row.id,
    payload: row.payload,
    effectiveToken: readFollowUpIdempotencyKey(row.payload) ?? row.id,
    remoteAttemptedAt: row.remoteAttemptedAt,
    attemptStampingCustodyAt: row.attemptStampingCustodyAt,
  })
  const apply = (plan: ReturnType<typeof planFollowUpEnqueue>, newId: string) => {
    if (plan.action === 'reuse') rows.find((row) => row.id === plan.syncLogId)!.payload = plan.payload
    else if (plan.action === 'create') {
      rows.unshift({ id: newId, payload: plan.payload, remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY })
    } else assert.fail(`unexpected plan ${plan.action}`)
  }

  apply(planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-09-01' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  }), 'log-b')

  const stillThere = rows.find((row) => row.id === 'log-a')!
  assert.equal(stillThere.payload.accountingInvoiceId, 'inv-9', 'the old binary\'s attempt must survive step 3')
  assert.equal(stillThere.payload.amount, 100)
  assert.equal(readFollowUpIdempotencyKey(stillThere.payload), undefined, 'and must not be given a new token')

  const back = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 105, paymentDate: '2026-09-02' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  })

  assert.equal(back.action, 'reuse')
  assert.equal(back.action === 'reuse' ? back.syncLogId : undefined, 'log-a')
  assert.equal(back.action === 'reuse' ? back.tokenDisposition : undefined, 'pinned',
    'a rotated disposition would skip the ledger probe, which is the second payment')
  assert.equal(back.action === 'reuse' ? back.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-a',
    'the token must be the one the committed £100 payment carries the mark of')
  assert.equal(back.action === 'reuse' ? back.payload.amount : undefined, 100,
    'and the body stays pinned, so the recomputed 105 cannot record a settlement never made')
})

test('the ROLLBACK double post, played out end to end (o3d-0m56 r10)', () => {
  // FINDING 3, as the connector would live it — and the one round 9's deploy order could not help
  // with, because a rollback is a SEQUENTIAL deploy: the old process is fully stopped before the
  // older binary starts, so the documented "no overlap" rule is satisfied at every moment.
  //
  //  1. This binary queues log-a for inv-9 IN CUSTODY. Under round 9 that was a row created after
  //     the epoch, so its NULL stamp counted as proof no call ever left it.
  //  2. The release is rolled back. The older binary claims log-a and posts £100. Xero commits it
  //     and the response is lost; log-a ends FAILED and UNSTAMPED, because that binary has no
  //     `authoriseMoneyPost` to claim the stamp. What it DOES leave behind is the claim itself: the
  //     database's forfeit trigger sees a claim that did not re-assert custody and nulls the column.
  //  3. The fix is rolled forward. inv-9 is voided and re-raised as inv-10 and the sweep
  //     re-enqueues; nothing surviving could have committed inv-10, so the token rotates.
  //  4. The void is reversed and a payment for inv-9 is enqueued once more.
  //
  // Under round 9's rule step 3 recycled log-a — its createdAt still sat after the epoch, and the
  // epoch is established once, so nothing about the rollback was visible to it. Step 4 then found
  // no attempt against inv-9, rotated a fresh token, skipped the probe, and paid inv-9 twice.
  type Row = { id: string; payload: FollowUpPayload; remoteAttemptedAt: Date | null; attemptStampingCustodyAt: Date | null }
  const rows: Row[] = [{
    id: 'log-a',
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-08-02' },
    remoteAttemptedAt: null,
    // Step 1: created by a binary that stamps.
    attemptStampingCustodyAt: IN_CUSTODY,
  }]
  // Step 2, as the DATABASE performs it. `accounting_sync_logs_forfeit_stamping_custody` fires on
  // an UPDATE that starts a claim without re-asserting custody in the same statement — which is
  // every claim made by a binary that has never heard of the column. The trigger's own text is
  // pinned by tests/prisma/attempt-stamping-custody-migration.test.ts.
  const rolledBackBinaryClaims = (id: string) => {
    const row = rows.find((candidate) => candidate.id === id)!
    row.attemptStampingCustodyAt = null
  }
  rolledBackBinaryClaims('log-a')

  const asFailedRow = (row: Row): FailedFollowUpRow => ({
    id: row.id,
    payload: row.payload,
    effectiveToken: readFollowUpIdempotencyKey(row.payload) ?? row.id,
    remoteAttemptedAt: row.remoteAttemptedAt,
    attemptStampingCustodyAt: row.attemptStampingCustodyAt,
  })
  const apply = (plan: ReturnType<typeof planFollowUpEnqueue>, newId: string) => {
    if (plan.action === 'reuse') rows.find((row) => row.id === plan.syncLogId)!.payload = plan.payload
    else if (plan.action === 'create') {
      rows.unshift({ id: newId, payload: plan.payload, remoteAttemptedAt: null, attemptStampingCustodyAt: IN_CUSTODY })
    } else assert.fail(`unexpected plan ${plan.action}`)
  }

  // Step 3.
  apply(planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-10', bankAccountId: 'bank-1', amount: 100, paymentDate: '2026-09-01' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  }), 'log-b')

  const stillThere = rows.find((row) => row.id === 'log-a')!
  assert.equal(stillThere.payload.accountingInvoiceId, 'inv-9',
    'the attempt the rolled-back binary made must survive step 3')
  assert.equal(stillThere.payload.amount, 100)
  assert.equal(readFollowUpIdempotencyKey(stillThere.payload), undefined, 'and must not be given a new token')

  // Step 4.
  const back = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 105, paymentDate: '2026-09-02' },
    liveRowExists: false,
    failedRows: rows.map(asFailedRow),
  })

  assert.equal(back.action, 'reuse')
  assert.equal(back.action === 'reuse' ? back.syncLogId : undefined, 'log-a')
  assert.equal(back.action === 'reuse' ? back.tokenDisposition : undefined, 'pinned',
    'a rotated disposition would skip the ledger probe, which is the second payment')
  assert.equal(back.action === 'reuse' ? back.payload[FOLLOW_UP_IDEMPOTENCY_KEY] : undefined, 'log-a',
    'the token must be the one the committed £100 payment carries the mark of')
  assert.equal(back.action === 'reuse' ? back.payload.amount : undefined, 100,
    'and the body stays pinned, so the recomputed 105 cannot record a settlement never made')
})
