import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  buildFollowUpIdempotencySource,
  planFollowUpEnqueue,
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

test('withFollowUpIdempotencyKey stamps the key but never overwrites an existing one (o3d-h2wx)', () => {
  const stamped = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } })
  assert.equal(stamped._idempotencyKey, buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } }))

  const preserved = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', _idempotencyKey: 'already-set' } })
  assert.equal(preserved._idempotencyKey, 'already-set')

  // Blank is not a key — both connectors' builders treat it as absent, so it must be replaced.
  const blank = withFollowUpIdempotencyKey({ ...ORDER, payload: { accountingInvoiceId: 'inv-9', _idempotencyKey: '   ' } })
  assert.notEqual(blank._idempotencyKey, '   ')
})

test('a live follow-up row short-circuits the enqueue (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' }, liveRowExists: true, failedRow: null })
  assert.equal(plan.action, 'skip')
})

test('with no prior row the enqueue creates one carrying the stable key (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' }, liveRowExists: false, failedRow: null })
  assert.equal(plan.action, 'create')
  assert.equal(
    plan.action === 'create' ? plan.payload._idempotencyKey : undefined,
    buildFollowUpIdempotencySource({ ...ORDER, payload: { accountingInvoiceId: 'inv-9' } }),
  )
})

test('a FAILED follow-up is REUSED, not replaced, so its row id survives (o3d-h2wx)', () => {
  // Reuse is the stronger half of the fix: preserving the row id preserves EVERY token
  // derived from it, including ones stamped before this change existed.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRow: { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', amount: 120 } },
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.syncLogId : undefined, 'log-old')
})

test('reusing a LEGACY FAILED row must NOT stamp a key — that would rotate its token (o3d-h2wx)', () => {
  // A row enqueued before this change has no _idempotencyKey, so its token comes from the
  // row id. Reuse keeps that row id, so the token is already stable. Stamping a key now
  // would CHANGE it and re-create the double-pay window the fix closes.
  const plan = planFollowUpEnqueue({
    ...ORDER,
    payload: { accountingInvoiceId: 'inv-9', amount: 120 },
    liveRowExists: false,
    failedRow: { id: 'log-legacy', payload: { accountingInvoiceId: 'inv-9', amount: 120 } },
  })
  assert.equal(plan.action, 'reuse')
  assert.ok(
    plan.action === 'reuse' && !('_idempotencyKey' in plan.payload),
    'a legacy FAILED row must be retried under the token it already used',
  )
})

test('reuse carries the FAILED row\'s original key forward, not a freshly derived one (o3d-h2wx)', () => {
  const plan = planFollowUpEnqueue({
    ...ORDER,
    // The re-enqueue resolved a DIFFERENT invoice id, which would derive a different key.
    payload: { accountingInvoiceId: 'inv-10', amount: 120 },
    liveRowExists: false,
    failedRow: { id: 'log-old', payload: { accountingInvoiceId: 'inv-9', _idempotencyKey: 'original-key' } },
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.action === 'reuse' ? plan.payload._idempotencyKey : undefined, 'original-key')
  // The rest of the payload is the fresh one — only the token is pinned.
  assert.equal(plan.action === 'reuse' ? plan.payload.accountingInvoiceId : undefined, 'inv-10')
})

test('a non-object payload on the FAILED row does not crash or forge a key (o3d-h2wx)', () => {
  for (const stored of [null, undefined, 'nope', 42]) {
    const plan = planFollowUpEnqueue({
      ...ORDER,
      payload: { accountingInvoiceId: 'inv-9' },
      liveRowExists: false,
      failedRow: { id: 'log-old', payload: stored },
    })
    assert.equal(plan.action, 'reuse')
    assert.ok(
      plan.action === 'reuse' && !('_idempotencyKey' in plan.payload),
      'an unreadable stored payload means "no key was recorded" — fall back to the preserved row id',
    )
  }
})

/**
 * Xero's two payment branches call buildXeroIdempotencyKey(entryId, op) WITHOUT the
 * payload argument, so the builder's `payload._idempotencyKey` preference never fires and
 * a stamped key would be silently ignored — leaving Xero exposed to exactly the hazard
 * this issue describes. Asserted against the source because the invariant has to hold for
 * every money-moving call site in the file, including ones added later.
 */
const XERO_PROCESSOR = path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts')

test('every Xero money-moving idempotency key is built WITH the payload (o3d-h2wx)', async () => {
  const source = await readFile(XERO_PROCESSOR, 'utf8')
  const moneyMovingOps = ['invoice-payment', 'bill-payment', 'purchase-credit-note-allocation']

  for (const op of moneyMovingOps) {
    const calls = source.match(new RegExp(String.raw`buildXeroIdempotencyKey\([^)]*'${op}'[^)]*\)`, 'g')) ?? []
    assert.ok(calls.length > 0, `expected a '${op}' idempotency key to be built`)
    for (const call of calls) {
      assert.match(
        call,
        /,\s*payload\s*\)/,
        `${call} must pass the payload, or a stamped _idempotencyKey is ignored and a `
          + 'regenerated follow-up posts a duplicate',
      )
    }
  }
})
