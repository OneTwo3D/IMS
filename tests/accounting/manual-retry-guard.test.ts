import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { effectiveTokenFor, planManualRetry } from '@/lib/domain/accounting/followup-retry-guard'

/**
 * o3d-0m56: the manual retry must refuse what the automatic enqueue refuses.
 *
 * o3d-h2wx routed every automatic follow-up enqueue through a planner that refuses when several
 * FAILED rows for one reference posted under DIFFERENT idempotency tokens — any of them may
 * have committed remotely, so re-posting picks a token the ledger may never have seen. The sync
 * UI's retry flipped a chosen row straight to PENDING and bypassed all of it; "Retry All
 * Failed" dropped the id filter entirely and re-queued every ambiguous scope at once.
 *
 * The refusal has to stay NARROW. Most retries are already safe and must keep working, and the
 * automatic path has already had to be corrected once for refusing on row count alone.
 */

const scopeArgs = { type: 'INVOICE_PAYMENT', reference: 'SalesOrder so-1' }

/** A body complete enough that the connector would actually attempt the remote call. */
const postable = (accountingInvoiceId: string) => ({ accountingInvoiceId, bankAccountId: 'bank-1', amount: 10 })

test('a single failed row retries freely — its token is preserved (o3d-0m56)', () => {
  // The row id and payload survive the retry, so the token is bit-identical to the one the
  // failed attempt used and the remote deduplicates.
  const row = { id: 'log-1', effectiveToken: 'log-1', payload: { accountingInvoiceId: 'inv-9' } }
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: row, siblings: [row] }), { action: 'allow' })
})

test('rows SHARING one token retry freely (o3d-0m56)', () => {
  // The ordinary QuickBooks shape: repeated receipts all carry invoice-payment:payment:<id>.
  // Whichever committed, committed under that token. Refusing these is the mistake the
  // automatic path already had to correct.
  const shared = 'invoice-payment:payment:p1'
  const rows = [
    { id: 'log-1', effectiveToken: shared, payload: { accountingInvoiceId: 'inv-9' } },
    { id: 'log-2', effectiveToken: shared, payload: { accountingInvoiceId: 'inv-9' } },
  ]
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }), { action: 'allow' })
})

test('DISTINCT tokens for the same document refuse (o3d-0m56)', () => {
  // The only unsafe case: row A may have committed under token A, and retrying B posts under a
  // token the ledger has never seen.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9') },
    { id: 'log-b', effectiveToken: 'log-b', payload: postable('inv-9') },
  ]
  const plan = planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows })
  assert.equal(plan.action, 'refuse')
  assert.equal(plan.action === 'refuse' ? plan.tokenCount : 0, 2)
  assert.match(plan.action === 'refuse' ? plan.reason : '', /could post a second payment/)
  assert.match(plan.action === 'refuse' ? plan.reason : '', /SalesOrder so-1/, 'the refusal must name the reference')
})

test('attempts against a DIFFERENT document do not trigger a refusal (o3d-0m56)', () => {
  // Refusing on row count alone permanently strands a legitimate payment against a replacement
  // invoice — an attempt on inv-old cannot have committed the payment for inv-new.
  const rows = [
    { id: 'log-new', effectiveToken: 'log-new', payload: postable('inv-new') },
    { id: 'log-old', effectiveToken: 'log-old', payload: postable('inv-old') },
  ]
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }), { action: 'allow' })
})

test('an anchorless money row is UNPOSTABLE, so it neither counts nor strands (o3d-0m56)', () => {
  // Two rules meet here and the structural one wins, correctly. "Unknown target" would say
  // count it conservatively — but for a payment the anchor IS a required field, so a row
  // without one was rejected before any HTTP call and provably never posted. Counting it would
  // strand the valid payment for no reason.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9') },
    { id: 'log-b', effectiveToken: 'log-b', payload: { amount: 10 } },
  ]
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }), { action: 'allow' })

  // The conservative anchor rule still governs rows that ARE postable: a complete sibling whose
  // anchors cannot be read is treated as possibly-this-one. (Reachable for types with no
  // required-field entry, where anchors are the only evidence available.)
  const notes = [
    { id: 'log-a', effectiveToken: 'log-a', payload: { accountingInvoiceId: 'inv-9' } },
    { id: 'log-b', effectiveToken: 'log-b', payload: {} },
  ]
  assert.equal(
    planManualRetry({ type: 'INVOICE_PDF', reference: 'SalesOrder so-1', target: notes[0]!, siblings: notes }).action,
    'allow',
    'and a non-money type never refuses regardless',
  )
})

test('non-money-moving types never refuse (o3d-0m56)', () => {
  // A duplicate PDF or email is not a financial error.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9') },
    { id: 'log-b', effectiveToken: 'log-b', payload: postable('inv-9') },
  ]
  for (const type of ['INVOICE_PDF', 'INVOICE_EMAIL', 'WC_INVOICE_NOTE', 'BILL_ATTACHMENT']) {
    assert.deepEqual(
      planManualRetry({ type, reference: 'SalesOrder so-1', target: rows[0]!, siblings: rows }),
      { action: 'allow' },
      `${type} must never be refused`,
    )
  }
})

test('the effective token is derived PER CONNECTOR (o3d-0m56)', () => {
  // QuickBooks has always honoured the generic queue's _idempotencyKey; Xero's payment branches
  // have always ignored it and derived from the row id. Folding them together would misreport
  // one connector's history and could allow the wrong retries.
  const row = { id: 'log-1', payload: { _idempotencyKey: 'invoice-payment:payment:p1' } }
  assert.equal(effectiveTokenFor('quickbooks', row), 'invoice-payment:payment:p1')
  assert.equal(effectiveTokenFor('xero', row), 'log-1', 'Xero payment branches ignore the generic key')

  // A stamped follow-up key wins for both.
  const stamped = { id: 'log-2', payload: { _followUpIdempotencyKey: 'stable', _idempotencyKey: 'generic' } }
  assert.equal(effectiveTokenFor('quickbooks', stamped), 'stable')
  assert.equal(effectiveTokenFor('xero', stamped), 'stable')

  // A whitespace generic key is still a STRING, and getIdempotencySource returns it verbatim —
  // so the guard must too. This assertion previously encoded my own non-blank check and would
  // have kept the divergence alive.
  assert.equal(effectiveTokenFor('quickbooks', { id: 'log-3', payload: { _idempotencyKey: '  ' } }), '  ')
  // Absent (or a non-string) falls back to the row id, for both.
  assert.equal(effectiveTokenFor('quickbooks', { id: 'log-3b', payload: { _idempotencyKey: 42 } }), 'log-3b')
  assert.equal(effectiveTokenFor('xero', { id: 'log-4', payload: null }), 'log-4')
})

// --- Both actions must actually consult the guard ---

const ACTIONS = [
  { name: 'xero', file: 'app/actions/xero-sync.ts' },
  { name: 'quickbooks', file: 'app/actions/quickbooks-sync.ts' },
]

for (const action of ACTIONS) {
  test(`${action.name}: the retry action consults the guard before resetting (o3d-0m56)`, async () => {
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('retryFailed')
    const body = source.slice(at, source.indexOf('\n}\n', at))

    assert.match(body, /planManualRetry\(/, 'the action must consult the guard')
    const planAt = body.indexOf('planManualRetry')
    const updateAt = body.indexOf('updateMany')
    assert.ok(planAt !== -1 && updateAt !== -1, 'it must both plan and update')
    assert.ok(planAt < updateAt, 'the guard must run BEFORE the reset, or it guards nothing')

    // The bulk path is the dangerous one — it must refuse per scope and still reset the rest,
    // not refuse everything or reset everything.
    // The UPDATE itself must be restricted — merely mentioning allowedIds elsewhere is not
    // enough, and a mutation that reset every candidate slipped past the looser assertion.
    assert.match(
      body,
      /updateMany\(\{\s*where: \{ id: \{ in: allowedIds \}/,
      'the reset must be restricted to the ALLOWED rows, not every candidate',
    )
    assert.match(body, /refused/, 'the caller must be told how many were refused')
  })

  test(`${action.name}: siblings are loaded for the whole scope, not just the selected row (o3d-0m56)`, async () => {
    // A single-row retry is only ambiguous relative to its SIBLINGS, which the id filter
    // excludes — querying only the selected row would make every retry look unambiguous.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('retryFailed')
    const body = source.slice(at, source.indexOf('\n}\n', at))
    assert.match(body, /siblingRows/, 'the scope siblings must be loaded')
    const siblingAt = body.indexOf('siblingRows')
    const planAt = body.indexOf('planManualRetry')
    assert.ok(siblingAt < planAt, 'siblings must be loaded before the guard runs')
  })
}

test('the token derivation mirrors each processor EXACTLY, empty string included (o3d-0m56)', async () => {
  // A guard that reasons about a token the connector will not actually send is worse than no
  // guard. QuickBooks' getIdempotencySource accepts `typeof payload._idempotencyKey === 'string'`
  // — an EMPTY string included — so two rows carrying '' post under the same token. Requiring a
  // non-blank value here handed them their row ids instead: two distinct tokens, and a refused
  // retry that was actually safe.
  assert.equal(effectiveTokenFor('quickbooks', { id: 'log-1', payload: { _idempotencyKey: '' } }), '')
  assert.equal(effectiveTokenFor('quickbooks', { id: 'log-2', payload: { _idempotencyKey: '' } }), '')

  // ...so a pair of them is unambiguous and must NOT refuse.
  const rows = [
    { id: 'log-1', effectiveToken: effectiveTokenFor('quickbooks', { id: 'log-1', payload: { _idempotencyKey: '' } }), payload: postable('inv-9') },
    { id: 'log-2', effectiveToken: effectiveTokenFor('quickbooks', { id: 'log-2', payload: { _idempotencyKey: '' } }), payload: postable('inv-9') },
  ]
  assert.deepEqual(
    planManualRetry({ type: 'INVOICE_PAYMENT', reference: 'SalesOrder so-1', target: rows[0]!, siblings: rows }),
    { action: 'allow' },
  )

  // Xero's followUpIdempotencySource is `readFollowUpIdempotencyKey(payload) ?? entryId` and
  // never consults the generic key, so the same payload derives the row id there.
  assert.equal(effectiveTokenFor('xero', { id: 'log-1', payload: { _idempotencyKey: '' } }), 'log-1')
})

test('the guard\'s derivation matches the processors in source (o3d-0m56)', async () => {
  // Pinned against the real definitions, so a change to either processor's precedence breaks
  // here rather than silently desynchronising the guard.
  const [xero, qbo] = await Promise.all([
    readFile(path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8'),
  ])
  assert.match(
    xero,
    /function followUpIdempotencySource\([^)]*\)[^{]*\{\s*return readFollowUpIdempotencyKey\(payload\) \?\? entryId/,
    'Xero must still derive follow-up token then row id, and never the generic key',
  )
  assert.match(
    qbo,
    /const followUpKey = readFollowUpIdempotencyKey\(payload\)\s*\n\s*if \(followUpKey\) return followUpKey\s*\n\s*if \(typeof payload\._idempotencyKey === 'string'\) return payload\._idempotencyKey/,
    'QuickBooks must still accept ANY string generic key, empty included',
  )
})

test('BILL_PAYMENT is money-moving too (o3d-0m56)', async () => {
  // isMoneyMovingFollowUp was scoped to the types o3d-h2wx's ENQUEUE helper produces.
  // BILL_PAYMENT is queued elsewhere, but both processors post a real supplier payment for it,
  // and this guard sees every FAILED row an operator can click. Using the narrower set let two
  // failed bill payments with distinct tokens through, and "Retry All" re-queue both.
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    assert.equal(isMoneyMovingSyncType(type), true, `${type} moves money`)
  }
  for (const type of ['INVOICE_PDF', 'INVOICE_EMAIL', 'WC_INVOICE_NOTE', 'BILL_ATTACHMENT', 'SALES_INVOICE']) {
    assert.equal(isMoneyMovingSyncType(type), false, `${type} does not`)
  }

  const body = { accountingInvoiceId: 'bill-1', bankAccountId: 'bank-1', amount: 10 }
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: body },
    { id: 'log-b', effectiveToken: 'log-b', payload: body },
  ]
  assert.equal(
    planManualRetry({ type: 'BILL_PAYMENT', reference: 'PurchaseInvoice pi-1', target: rows[0]!, siblings: rows }).action,
    'refuse',
    'two bill payments under distinct tokens must refuse, exactly as invoice payments do',
  )
})

test('a sibling that provably never posted cannot strand a valid payment (o3d-0m56)', async () => {
  // A row missing a field its connector requires was rejected BEFORE any HTTP call, so it has
  // no token worth defending. Counting it stranded the good payment through the only manual
  // route available. Structure is the sound signal here — o3d-h2wx established that the error
  // MESSAGE is not, since both connectors overwrite it with the remote system's own text.
  const good = { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 10 }
  const rows = [
    { id: 'log-good', effectiveToken: 'log-good', payload: good },
    // No bankAccountId: the connector refuses this before building a request.
    { id: 'log-broken', effectiveToken: 'log-broken', payload: { accountingInvoiceId: 'inv-9', amount: 10 } },
  ]
  assert.deepEqual(
    planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }),
    { action: 'allow' },
    'a structurally unpostable sibling must not make the valid row un-retryable',
  )

  // An amount of ZERO is a real request, not a missing field — the connectors reject an amount
  // only when null/undefined, so a zero-amount sibling still counts.
  const zero = [
    { id: 'log-good', effectiveToken: 'log-good', payload: good },
    { id: 'log-zero', effectiveToken: 'log-zero', payload: { accountingInvoiceId: 'inv-9', bankAccountId: 'bank-1', amount: 0 } },
  ]
  assert.equal(planManualRetry({ ...scopeArgs, target: zero[0]!, siblings: zero }).action, 'refuse')
})

for (const action of ACTIONS) {
  test(`${action.name}: each candidate is planned against its OWN siblings (o3d-0m56)`, async () => {
    // Planning once per scope from an arbitrary rows[0] and refusing every sibling made the
    // outcome depend on array order: one safe row targeting a replacement invoice plus two
    // ambiguous rows targeting the old one either let the pair through or refused the safe row
    // along with them, depending which came first.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('const refusedIds')
    const body = source.slice(at, source.indexOf('const allowedIds', at))

    assert.match(body, /for \(const candidate of candidates\)/, 'the plan must be per candidate')
    assert.match(body, /refusedIds\.add\(candidate\.id\)/, 'only the judged candidate may be refused')
    assert.ok(
      !/for \(const row of rows\) refusedIds\.add/.test(body),
      'refusing every sibling makes a safe row un-retryable because of its neighbours',
    )
    assert.match(body, /target: \{\s*id: candidate\.id/, 'the candidate must be the plan target, not an arbitrary sibling')
  })
}

for (const action of ACTIONS) {
  test(`${action.name}: the sibling snapshot reads EVERY status, not just FAILED (o3d-0m56)`, async () => {
    // Restricting it to FAILED made the guard blind in both directions:
    //   - a PENDING/PROCESSING sibling under a different token has not failed YET; it can post
    //     and land in FAILED after the read but before the reset, so the retry proceeds against
    //     a snapshot that never showed it;
    //   - a SYNCED sibling under a different token is the strongest evidence available -- that
    //     token demonstrably reached the ledger.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('const siblingRows = await db.accountingSyncLog.findMany')
    assert.notEqual(at, -1, 'the sibling snapshot must still exist')
    const query = source.slice(at, source.indexOf('})', source.indexOf('select:', at)))

    assert.ok(
      !/status:\s*'FAILED'/.test(query),
      'the sibling snapshot must NOT filter on status — an in-flight or already-synced sibling counts',
    )
    assert.match(query, /connector: '(xero|quickbooks)'/, 'it must still be scoped to the connector')

    // The reset itself must stay narrow: only FAILED rows may be re-queued.
    const update = source.slice(source.indexOf('await db.accountingSyncLog.updateMany'))
    assert.match(update.slice(0, 400), /status: 'FAILED'/, 'the UPDATE must still only touch FAILED rows')
  })

  test(`${action.name}: the scope filter is deduplicated (o3d-0m56)`, async () => {
    // "Retry All" over hundreds of rows in a handful of scopes built one OR arm per candidate.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('const siblingRows = await db.accountingSyncLog.findMany')
    const query = source.slice(at, at + 700)
    assert.match(query, /OR: \[\.\.\.scopes\.values\(\)\]\.map/, 'the OR must be built from deduplicated scopes')
    assert.ok(!/OR: candidates\.map/.test(query), 'not one arm per candidate')
  })

  test(`${action.name}: refusals are logged once per scope, not once per row (o3d-0m56)`, async () => {
    // One sequential activityLog.create per refused candidate produced N near-duplicate
    // warnings before any allowed row was reset.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('const refusedIds')
    const body = source.slice(at, source.indexOf('const allowedIds', at))
    assert.match(body, /for \(const \[key, entry\] of refusedByScope\)/, 'the log must be emitted per scope')
    const loopAt = body.indexOf('for (const candidate of candidates)')
    const logAt = body.indexOf('await logActivity')
    assert.ok(loopAt !== -1 && logAt !== -1 && logAt > body.indexOf('for (const [key, entry]'),
      'no logActivity inside the per-candidate loop')
  })

  test(`${action.name}: the surfaced reason does not depend on candidate order (o3d-0m56)`, async () => {
    // The DECISION never did, but refusals[0] made the displayed MESSAGE order-dependent when
    // several scopes were all refused.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    assert.match(source, /\[\.\.\.refusals\]\.sort\(\)\[0\]/, 'the reason must be chosen deterministically')
    assert.ok(!/error: refusals\[0\]/.test(source), 'not the arbitrary first refusal')
  })
}

test('a partial refusal is not reported as plain success (o3d-0m56)', async () => {
  // The guard can allow SOME rows and refuse others in one call. Every wrapper between the
  // action and the UI dropped `refused`, so "Retry All" rendered "Reset N" while the refused
  // rows silently stayed FAILED.
  const files = {
    'lib/connectors/accounting-registry.ts': /retryFailedSync\(entryId\?: string\): Promise<\{[^}]*refused\?: number/,
    'app/actions/accounting-sync.ts': /retryFailedAccountingSync\([^)]*\): Promise<\{[^}]*refused\?: number/,
  }
  for (const [file, pattern] of Object.entries(files)) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    assert.match(source, pattern, `${file} must carry refused through`)
  }
  for (const file of ['app/(dashboard)/sync/xero-client.tsx', 'app/(dashboard)/sync/failed-sync-banner.tsx']) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    assert.match(source, /result\.refused|res\.refused/, `${file} must render the refused count`)
    assert.match(source, /could post a second payment/, `${file} must say WHY they were not re-queued`)
  }
})

test('a SETTLED sibling still counts, because settled does not mean unposted (o3d-0m56)', () => {
  // Two attempts to narrow this were both wrong in the dangerous direction.
  //
  // SYNCED: I argued its outcome is known, and that retrying re-posts under the failed row's
  // OWN token which the remote deduplicates. The second half is FALSE for Xero -- it retains an
  // Idempotency-Key only for a short documented window, and a MANUAL retry is minutes to days
  // later, so essentially never inside it. And the cross-token case (A never landed, its
  // replacement B is SYNCED, retrying A posts a second payment beside B) is unprotected on both
  // connectors regardless.
  //
  // CANCELLED: I argued it proves the row never posted. It does not -- a row whose call
  // COMMITTED but whose response was lost returns to PENDING, and deleting the local receipt
  // then cancels it. That row can represent money already in the ledger.
  for (const status of ['SYNCED', 'CANCELLED', 'PENDING', 'PROCESSING', 'FAILED']) {
    const settled = { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9'), status }
    const target = { id: 'log-b', effectiveToken: 'log-b', payload: postable('inv-9'), status: 'FAILED' }
    assert.equal(
      planManualRetry({ ...scopeArgs, target, siblings: [settled, target] }).action,
      'refuse',
      `a ${status} sibling under a different token may be money already posted`,
    )
  }
})

test('the refusal says the remote will NOT save us (o3d-0m56)', () => {
  // The message used to imply the duplicate risk was speculative. It is not: by the time an
  // operator clicks retry, any remote idempotency window has long closed.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9'), status: 'SYNCED' },
    { id: 'log-b', effectiveToken: 'log-b', payload: postable('inv-9'), status: 'FAILED' },
  ]
  const plan = planManualRetry({ ...scopeArgs, target: rows[1]!, siblings: rows })
  assert.ok(plan.action === 'refuse')
  assert.match(plan.reason, /too late for the remote to deduplicate/)
  assert.match(plan.reason, /Check the ledger/)
})

test('a single row in its scope is still allowed (o3d-0m56)', () => {
  // The narrowness that matters most: one row, one token, nothing to be ambiguous with.
  const only = { id: 'log-a', effectiveToken: 'log-a', payload: postable('inv-9'), status: 'FAILED' }
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: only, siblings: [only] }), { action: 'allow' })

  // And rows SHARING a token stay allowed however many there are.
  const shared = ['a', 'b', 'c'].map((id) => ({
    id: `log-${id}`, effectiveToken: 'shared-token', payload: postable('inv-9'), status: 'FAILED',
  }))
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: shared[0]!, siblings: shared }), { action: 'allow' })
})

for (const action of ACTIONS) {
  test(`${action.name}: sibling status is threaded to the planner (o3d-0m56)`, async () => {
    // It was selected and then discarded, which is how CANCELLED and SYNCED rows came to strand
    // legitimate payments.
    const source = await readFile(path.join(process.cwd(), action.file), 'utf8')
    const at = source.indexOf('const planned: RetryCandidateRow')
    assert.notEqual(at, -1, 'sibling rows must be mapped once into planner rows')
    assert.match(source.slice(at, at + 600), /status: row\.status/, 'status must reach the planner')
    // And no status may be used to DROP a row from the token set.
    // Scoped to the FILTER CHAIN, not the file: the surrounding note explains the discarded
    // rule by name, and a file-wide assertion fails on its own documentation. (Same trap as the
    // <> ANY / <> ALL assertion in the o3d-z82a work.)
    const guard = await readFile(path.join(process.cwd(), 'lib/domain/accounting/followup-retry-guard.ts'), 'utf8')
    const chainAt = guard.indexOf('const contenders = siblings')
    const chain = guard.slice(chainAt, guard.indexOf('const tokens =', chainAt))
    assert.ok(!/\.filter\(\(row\) => outcomeIsUnknown/.test(chain), 'no status-based exclusion may return')
    assert.match(chain, /couldHaveReachedTheLedger\(type, row\.payload\)/, 'structural filtering stays')
    assert.match(source, /payload: true, status: true/, 'and be selected in the first place')
  })
}
