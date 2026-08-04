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
    { id: 'log-a', effectiveToken: 'log-a', payload: { accountingInvoiceId: 'inv-9' } },
    { id: 'log-b', effectiveToken: 'log-b', payload: { accountingInvoiceId: 'inv-9' } },
  ]
  const plan = planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows })
  assert.equal(plan.action, 'refuse')
  assert.equal(plan.action === 'refuse' ? plan.tokenCount : 0, 2)
  assert.match(plan.action === 'refuse' ? plan.reason : '', /could duplicate a payment/)
  assert.match(plan.action === 'refuse' ? plan.reason : '', /SalesOrder so-1/, 'the refusal must name the reference')
})

test('attempts against a DIFFERENT document do not trigger a refusal (o3d-0m56)', () => {
  // Refusing on row count alone permanently strands a legitimate payment against a replacement
  // invoice — an attempt on inv-old cannot have committed the payment for inv-new.
  const rows = [
    { id: 'log-new', effectiveToken: 'log-new', payload: { accountingInvoiceId: 'inv-new' } },
    { id: 'log-old', effectiveToken: 'log-old', payload: { accountingInvoiceId: 'inv-old' } },
  ]
  assert.deepEqual(planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }), { action: 'allow' })
})

test('an anchorless row counts as possibly-this-one (o3d-0m56)', () => {
  // "Unknown target" has to read as "possibly this one" where money is concerned.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: { accountingInvoiceId: 'inv-9' } },
    { id: 'log-b', effectiveToken: 'log-b', payload: { amount: 10 } },
  ]
  assert.equal(planManualRetry({ ...scopeArgs, target: rows[0]!, siblings: rows }).action, 'refuse')
})

test('non-money-moving types never refuse (o3d-0m56)', () => {
  // A duplicate PDF or email is not a financial error.
  const rows = [
    { id: 'log-a', effectiveToken: 'log-a', payload: { accountingInvoiceId: 'inv-9' } },
    { id: 'log-b', effectiveToken: 'log-b', payload: { accountingInvoiceId: 'inv-9' } },
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

  // Blank or absent falls back to the row id.
  assert.equal(effectiveTokenFor('quickbooks', { id: 'log-3', payload: { _idempotencyKey: '  ' } }), 'log-3')
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
