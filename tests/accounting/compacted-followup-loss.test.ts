import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountingSyncType } from '@/app/generated/prisma/enums'
import { BACK_REFERENCE_TYPES } from '@/lib/domain/accounting/back-reference'
import {
  COMPACTION_FOLLOW_UP_LOSS,
  buildCompactedFollowUpLossActivity,
  compactionDiscardedFollowUps,
  compactionFollowUpVerdict,
  compactionRebuildableFollowUps,
  classifyCompactedFollowUpLoss,
  followUpObligationsOwedBy,
  isCompactedFollowUpEvidence,
  isCompactedFollowUpLoss,
} from '@/lib/domain/accounting/compacted-followup-loss'

// ---------------------------------------------------------------------------
// o3d-bqw7 / o3d-kemx — THE TABLE THAT SEPARATES "THE PAYLOAD IS GONE" FROM "SOMETHING WAS LOST".
//
// The discard warning used to fire on the compaction STAMP, which is set on every expired unresolved
// back-reference row whatever its type. The warning's claim is narrower: that this row's outstanding
// follow-ups can no longer be enqueued. These tests pin the difference, and pin the two directions
// the table is allowed to be wrong in — never silently under-reporting, and never inheriting an
// answer for a type nobody considered.
// ---------------------------------------------------------------------------

const COMPACTED = new Date('2026-01-05T00:00:00Z')

function row(type: string, compactedAt: Date | null = COMPACTED) {
  return {
    id: 'log-1',
    type: type as AccountingSyncType,
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: 'XINV-1',
    backReferenceEvidenceCompactedAt: compactedAt,
  }
}

test('[o3d-bqw7] every AccountingSyncType has a stated verdict — none inherits another type\'s', () => {
  // The Record type already forces this at compile time. This is the RUNTIME half: a member added to
  // the Prisma enum by a schema change that has not reached this file would resolve to `undefined`
  // here, and `undefined.discarded` would throw inside a warning path rather than fail a build.
  const enumMembers = Object.values(AccountingSyncType).sort()
  const tableKeys = Object.keys(COMPACTION_FOLLOW_UP_LOSS).sort()
  assert.deepEqual(tableKeys, enumMembers)
})

test('[o3d-bqw7] only the four back-reference types can ever carry the stamp, and each is answered deliberately', () => {
  // Read from the SHARED constant, not restated: `UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE` — the one
  // predicate that both the retention delete and the compaction pass are built from — filters on
  // `type in BACK_REFERENCE_TYPES`, so no other type can reach a tombstone today. That is why the
  // remaining entries are defensive rather than dead: they answer for a predicate in another file
  // that could widen.
  assert.deepEqual([...BACK_REFERENCE_TYPES].sort(), ['CREDIT_NOTE', 'PURCHASE_CREDIT_NOTE', 'PURCHASE_INVOICE', 'SALES_INVOICE'])
  assert.deepEqual(compactionFollowUpVerdict('SALES_INVOICE'), {
    discarded: ['the payment registration'],
    rebuilt: ['the invoice PDF'],
  })
  assert.deepEqual(compactionFollowUpVerdict('PURCHASE_INVOICE'), { discarded: ['the supplier invoice attachment'], rebuilt: [] })
  assert.deepEqual(compactionFollowUpVerdict('PURCHASE_CREDIT_NOTE'), { discarded: ['the supplier credit-note allocation'], rebuilt: [] })
  // The whole of the live false-alarm population: a sales credit note IS compacted and owes nothing.
  assert.deepEqual(compactionFollowUpVerdict('CREDIT_NOTE'), { discarded: [], rebuilt: [] })
})

test('[o3d-bqw7] a type the table does not recognise WARNS — the error direction is deliberate', () => {
  // Under-reporting loses a payment in silence; over-reporting is noise. A row carrying an enum
  // member this file has never seen is the "unsure" case, and it must land on the noisy side.
  const unknown = compactionFollowUpVerdict('SOMETHING_MERGED_LATER' as AccountingSyncType)
  assert.ok(unknown.discarded.length > 0, 'an unrecognised type must not read as "nothing was lost"')
  assert.ok(isCompactedFollowUpLoss(row('SOMETHING_MERGED_LATER')))
})

test('[o3d-bqw7] the loss still requires the STAMP — an intact row of a losing type lost nothing', () => {
  // The r3 property, unchanged by the narrowing: `payload: {}` and a compacted payload are the same
  // JSON, so the stamp is what decides whether anything was thrown away at all. The type only
  // decides whether what was thrown away mattered.
  assert.equal(isCompactedFollowUpEvidence(row('SALES_INVOICE', null)), false)
  assert.deepEqual(compactionDiscardedFollowUps(row('SALES_INVOICE', null)), [])
  assert.deepEqual(compactionDiscardedFollowUps(row('SALES_INVOICE')), ['the payment registration'])
})

test('[o3d-kemx] a tombstone that lost nothing is not a discard, so nothing gates its settle', () => {
  // Stated as the predicate the callers actually branch on. Both the processors and the sweep
  // release/settle only once the discard warning is persisted; if this answered true for a
  // CREDIT_NOTE, a failing activity log would hold an already-posted row for ever.
  assert.equal(isCompactedFollowUpLoss(row('CREDIT_NOTE')), false)
  assert.equal(isCompactedFollowUpLoss(row('PURCHASE_INVOICE')), true)
})

test('[o3d-bqw7] the warning quotes the table instead of listing everything a tombstone might owe', () => {
  const activity = buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    row: { ...row('SALES_INVOICE'), type: 'SALES_INVOICE' },
    phase: 'repaired',
  })
  assert.equal(activity.level, 'WARNING')
  assert.match(activity.description, /the payment registration can no longer be enqueued/)
  assert.match(activity.description, /The invoice PDF is built from columns compaction keeps/)
  assert.deepEqual(activity.metadata.discardedFollowUps, ['the payment registration'])
  assert.deepEqual(activity.metadata.rebuiltFollowUps, ['the invoice PDF'])
})

// ---------------------------------------------------------------------------
// o3d-bqw7 ROUND 2 (Codex HIGH) — A TYPE IS STILL COARSER THAN THE TRUTH.
//
// A SALES_INVOICE does not inherently owe a payment registration: both connectors gate that enqueue
// on `payload._registerPayment`, and the ordinary sales path composes payloads without it. So the
// round-1 type table went on warning about tombstones that lost nothing — and because the warning
// GATES the obligation release, a false one that is also unwritable holds an already-posted row at
// PENDING for ever, which is the o3d-kemx shape the narrowing existed to end.
//
// The answer is a per-ROW record, derived from the payload at the one moment it can be: the
// compaction that erases it.
// ---------------------------------------------------------------------------

function recordedRow(type: string, followUpObligations: unknown) {
  return { ...row(type), followUpObligations }
}

test('[o3d-bqw7 r2] the ORDINARY sales invoice owes only a PDF — the payment gate is a payload flag', () => {
  // The population the type table was wrong about. An order invoiced with no receipt recorded
  // against it never reaches the payment branch, so a tombstone of it lost nothing recoverable.
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'SALES_INVOICE' as AccountingSyncType,
      referenceType: 'SalesOrder',
      externalTransactionId: 'XINV-1',
      payload: { invoiceNumber: 'INV-1', currency: 'GBP' },
    }),
    ['invoice-pdf'],
  )
  // ...and the paid-at-import order, which does.
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'SALES_INVOICE' as AccountingSyncType,
      referenceType: 'SalesOrder',
      externalTransactionId: 'XINV-1',
      payload: { _registerPayment: true, _paymentAmount: 120 },
    }),
    ['payment-registration', 'invoice-pdf'],
  )
})

test('[o3d-bqw7 r2] a row with NO document id owes nothing — every enqueue branch returns before it', () => {
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'SALES_INVOICE' as AccountingSyncType,
      referenceType: 'SalesOrder',
      externalTransactionId: null,
      payload: { _registerPayment: true },
    }),
    [],
  )
})

test('[o3d-bqw7 r2] the two purchase obligations are read from their own payload gates', () => {
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'PURCHASE_INVOICE' as AccountingSyncType,
      referenceType: 'PurchaseOrder',
      externalTransactionId: 'XBILL-1',
      payload: { supplierInvoicePath: '/files/bill.pdf' },
    }),
    ['supplier-invoice-attachment'],
  )
  // No stored path, so `enqueuePurchaseInvoiceFollowUps` returns before it enqueues: nothing owed.
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'PURCHASE_INVOICE' as AccountingSyncType,
      referenceType: 'PurchaseOrder',
      externalTransactionId: 'XBILL-1',
      payload: {},
    }),
    [],
  )
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'PURCHASE_CREDIT_NOTE' as AccountingSyncType,
      referenceType: 'SupplierCreditNote',
      externalTransactionId: 'XCN-1',
      payload: { allocateToInvoiceId: 'XBILL-1', allocateAmount: 12 },
    }),
    ['supplier-credit-note-allocation'],
  )
  // Allocation amount of zero: the enqueue refuses it, so nothing is owed and nothing is lost.
  assert.deepEqual(
    followUpObligationsOwedBy({
      type: 'PURCHASE_CREDIT_NOTE' as AccountingSyncType,
      referenceType: 'SupplierCreditNote',
      externalTransactionId: 'XCN-1',
      payload: { allocateToInvoiceId: 'XBILL-1', allocateAmount: 0 },
    }),
    [],
  )
})

test('[o3d-bqw7 r2] a SALES_INVOICE tombstone that recorded no payment obligation discards NOTHING', () => {
  // THE FALSE WARNING, GONE. Under the type table this row was told it had lost "the payment
  // registration" — a payment nothing ever owed.
  const recorded = recordedRow('SALES_INVOICE', ['invoice-pdf'])
  assert.deepEqual(classifyCompactedFollowUpLoss(recorded), {
    discarded: [],
    rebuilt: ['the invoice PDF'],
    basis: 'row-record',
  })
  assert.equal(isCompactedFollowUpLoss(recorded), false, 'and so there is no warning to gate the release on')

  // ...while the row that DID owe one still says so, in full.
  const owed = recordedRow('SALES_INVOICE', ['payment-registration', 'invoice-pdf'])
  assert.deepEqual(compactionDiscardedFollowUps(owed), ['the payment registration'])
  assert.deepEqual(compactionRebuildableFollowUps(owed), ['the invoice PDF'])
  assert.equal(isCompactedFollowUpLoss(owed), true)
})

test('[o3d-bqw7 r2] a row compacted BEFORE the record existed keeps the over-broad type answer, for ever', () => {
  // Not a stopgap: the payload its obligations would have to be derived from is exactly what
  // retention already threw away, so no backfill can ever give it one. Over-reporting is the safe
  // direction — an over-broad warning is noise, an under-broad one loses a payment in silence.
  for (const noRecord of [undefined, null, 'not-an-array', [1, 2], { invoice: true }]) {
    const legacy = recordedRow('SALES_INVOICE', noRecord)
    assert.deepEqual(
      classifyCompactedFollowUpLoss(legacy),
      { discarded: ['the payment registration'], rebuilt: ['the invoice PDF'], basis: 'type-table' },
      `a ${JSON.stringify(noRecord) ?? 'undefined'} record must not be read as "nothing was owed"`,
    )
  }
})

test('[o3d-bqw7 r2] an EMPTY record is an answer, and a missing one is not', () => {
  // The distinction the whole column rests on. `[]` is a row that answered "nothing"; `null` is a row
  // that cannot answer at all.
  assert.deepEqual(classifyCompactedFollowUpLoss(recordedRow('PURCHASE_INVOICE', [])), {
    discarded: [], rebuilt: [], basis: 'row-record',
  })
  assert.deepEqual(classifyCompactedFollowUpLoss(recordedRow('PURCHASE_INVOICE', null)), {
    discarded: ['the supplier invoice attachment'], rebuilt: [], basis: 'type-table',
  })
})

test('[o3d-bqw7 r2] an obligation key this release does not recognise still WARNS', () => {
  // Same rule as the unrecognised TYPE, one level down: the record was written by a release that knew
  // about an obligation this one does not, and under-reporting loses a payment in silence.
  const future = recordedRow('SALES_INVOICE', ['invoice-pdf', 'some-obligation-added-later'])
  const verdict = classifyCompactedFollowUpLoss(future)
  assert.equal(verdict.discarded.length, 1)
  assert.match(verdict.discarded[0], /some-obligation-added-later/)
  assert.deepEqual(verdict.rebuilt, ['the invoice PDF'])
  assert.equal(isCompactedFollowUpLoss(future), true)
})

test('[o3d-bqw7 r2] the warning names what the ROW recorded, and says which basis it used', () => {
  const activity = buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    row: recordedRow('SALES_INVOICE', ['payment-registration', 'invoice-pdf']),
    phase: 'processor-short-circuit',
  })
  assert.match(activity.description, /the payment registration can no longer be/)
  assert.match(activity.description, /invoice PDF is built from columns compaction keeps/)
  assert.equal(activity.metadata.classificationBasis, 'row-record')

  const legacy = buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    row: recordedRow('SALES_INVOICE', null),
    phase: 'processor-short-circuit',
  })
  assert.equal(legacy.metadata.classificationBasis, 'type-table',
    'a reader must be able to tell an answer from a fallback without guessing')
})
