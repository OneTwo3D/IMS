import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r2 finding 2 — retention deletes accounting_sync_logs by AGE, on its own schedule,
// while the back-reference sweep reads its candidate page outside the transaction that later
// acts on it. Deleting an UNRESOLVED row in that window does not merely lose an audit trail:
//
//   • deleting the row being repaired leaves the sweep holding an external id whose evidence is
//     gone (the resolver now refuses that — "exactly one live sync row");
//   • deleting a COMPETING SIBLING is worse, because it is undetectable. One unlinked bill and
//     one surviving claimant is genuinely indistinguishable from an unambiguous attribution, so
//     the sweep stops refusing and stamps a bill whose competitor no longer exists.
//
// The predicate is therefore asserted BEHAVIOURALLY — the where clause is evaluated against rows
// — rather than by comparing its shape, so a version of production that kept the constant but
// stopped applying it, or applied it with the wrong polarity, fails here.
// ---------------------------------------------------------------------------

type DeleteArgs = { where: Record<string, unknown> }
type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> }

const capture: {
  settingRows: Array<{ key: string; value: string }>
  accountingDelete?: DeleteArgs
  accountingCompact?: UpdateArgs
} = {
  settingRows: [],
  accountingDelete: undefined,
  accountingCompact: undefined,
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityPersisted: async () => true } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      // o3d-xnwu r15: the WooCommerce sync-log delete is a raw statement now — the recovery-witness
      // exemption is a fact in another table and Prisma cannot express it. Nothing here asserts
      // about it (tests/wc-refund-park-recovery-witness-retention.test.ts does), but it must
      // EXIST or purgeExpiredData dies before reaching anything this file measures.
      $queryRaw: async () => [{ count: 0 }],
      accountingSyncLog: {
        ...noopDelegate(),
        deleteMany: async (args: DeleteArgs) => {
          capture.accountingDelete = args
          return { count: 0 }
        },
        updateMany: async (args: UpdateArgs) => {
          capture.accountingCompact = args
          return { count: 0 }
        },
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      // q66in.7.4: the WMS retention passes added to purgeExpiredData run unconditionally on
      // their own defaults, so this harness has to answer for their delegates too. Inert here —
      // their behaviour is asserted in tests/data-retention-wms-events.test.ts.
      wmsInboundReceiptEvent: noopDelegate(),
      wmsWebhookEvent: noopDelegate(),
      wmsSyncJob: noopDelegate(),
      externalWmsBinding: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
    },
  },
})

type Row = Record<string, unknown>

/** Enough of Prisma's where semantics for this predicate — including NOT(AND(...)). */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
      continue
    }
    const value = row[key] ?? null
    if (condition === null) {
      if (value !== null) return false
      continue
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>
      const unsupported = Object.keys(operators).filter((op) => !['in', 'notIn', 'not', 'lt'].includes(op))
      if (unsupported.length > 0) throw new Error(`unsupported operator(s) ${unsupported.join(', ')} on "${key}"`)
      if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false
      // o3d-y14 added `status: { notIn: POSTABLE }` to the SAME predicate. The throw above is what
      // surfaced it rather than letting the clause be silently ignored — which would have made every
      // assertion in this file describe a predicate the code no longer has.
      if ('notIn' in operators && (operators.notIn as unknown[]).includes(value)) return false
      if ('not' in operators) {
        if (operators.not === null) { if (value === null) return false } else if (value === operators.not) return false
      }
      if ('lt' in operators) {
        if (!(value instanceof Date) || !(operators.lt instanceof Date) || value.getTime() >= operators.lt.getTime()) return false
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

const OLD = new Date('2020-01-01T00:00:00Z')
const NOW = new Date()

function row(overrides: Row = {}): Row {
  return {
    id: 'log-1',
    createdAt: OLD,
    type: 'PURCHASE_INVOICE',
    status: 'SYNCED',
    externalTransactionId: 'XBILL-1',
    backReferenceCheckedAt: null,
    backReferenceEvidenceCompactedAt: null,
    ...overrides,
  }
}

/** Out of line so the assignment does not narrow the captures to `undefined`. */
function resetCaptures(): void {
  capture.accountingDelete = undefined
  capture.accountingCompact = undefined
}

async function runRetention(): Promise<{ deleteWhere: Record<string, unknown>; compact: UpdateArgs }> {
  const { purgeExpiredData } = await import('@/lib/data-retention')
  capture.settingRows = [{ key: 'retention_sync_logs_months', value: '6' }]
  resetCaptures()
  await purgeExpiredData()
  assert.ok(capture.accountingDelete, 'retention must still delete expired accounting sync logs')
  assert.ok(capture.accountingCompact, 'retention must COMPACT the rows it refuses to delete — an exemption alone is unbounded')
  return { deleteWhere: capture.accountingDelete.where, compact: capture.accountingCompact }
}

async function captureDeletePredicate(): Promise<Record<string, unknown>> {
  return (await runRetention()).deleteWhere
}

test('[o3d-9kek r2 f2] retention keeps UNRESOLVED back-reference evidence past the cutoff', async () => {
  const where = await captureDeletePredicate()

  // The row under repair, and — the case that actually corrupts data — its competing sibling.
  // Deleting either one silently converts a refusal into a confident wrong answer.
  assert.equal(matches(row({ id: 'legacy' }), where), false)
  assert.equal(matches(row({ id: 'sibling', externalTransactionId: 'XBILL-2' }), where), false)
  // FAILED rows are candidates too (they may still owe their follow-ups).
  assert.equal(matches(row({ status: 'FAILED' }), where), false)
  // ...and so are the sales-side types the sweep repairs.
  assert.equal(matches(row({ type: 'SALES_INVOICE' }), where), false)
  assert.equal(matches(row({ type: 'CREDIT_NOTE' }), where), false)
  // r6 finding 2: AND supplier credit notes. This type was missing from the shared list, so the
  // only row that knew an external ACCPAYCREDIT existed with no local link was DELETED by age —
  // taking the evidence with it, and with nothing to repair from afterwards.
  assert.equal(matches(row({ type: 'PURCHASE_CREDIT_NOTE', externalTransactionId: 'XCN-1' }), where), false)
})

test('[o3d-9kek r2 f2] retention still deletes everything the sweep has SETTLED or never owned', async () => {
  const where = await captureDeletePredicate()

  // The exemption is bounded by the sweep's own verdict marker: once a row is settled, the
  // attribution lives on the document (which is never retention-deleted, and now unique), so the
  // log is free to expire. Without this the exemption would grow without limit.
  assert.equal(matches(row({ backReferenceCheckedAt: new Date('2021-01-01') }), where), true)
  // Never posted — it is not evidence of anything in the ledger.
  assert.equal(matches(row({ externalTransactionId: null }), where), true)
  // Deliberately abandoned (audit-46ry), and types that carry no back-reference at all.
  assert.equal(matches(row({ status: 'CANCELLED' }), where), true)
  assert.equal(matches(row({ type: 'COGS_JOURNAL' }), where), true)
  // Age is still the primary rule: nothing inside the retention window is deleted.
  assert.equal(matches(row({ createdAt: NOW }), where), false)
})

test('[o3d-y14] unfinished work is kept by the OTHER clause on the same predicate', async () => {
  // The two rules meet here and neither subsumes the other. A PENDING invoice job has no external
  // id, so this file's predicate is structurally incapable of seeing it — `externalTransactionId:
  // { not: null }` excludes it from the evidence set, and it would be deleted by age. What keeps it
  // is o3d-y14's `status: { notIn: POSTABLE }`: the row IS the work a worker will post from, and
  // the coupon backfill counts these rows under the order lock to decide it is safe to correct.
  const where = await captureDeletePredicate()

  assert.equal(matches(row({ status: 'PENDING', externalTransactionId: null }), where), false)
  assert.equal(matches(row({ status: 'PROCESSING', externalTransactionId: null }), where), false)
  // And conversely, the evidence clause still covers what the status clause cannot: a SYNCED row is
  // not postable work, so only `NOT: UNRESOLVED_…` keeps it.
  assert.equal(matches(row({ status: 'SYNCED' }), where), false)
})

// ---------------------------------------------------------------------------
// o3d-9kek r3 finding 3 — the exemption above was called "bounded" because the sweep stamps every
// row it settles. It is not: a permanently ambiguous row is never stamped BY DESIGN, a
// disconnected connector's rows are never swept at all, and no QuickBooks sweep runs (deliberately
// — r6 finding 1), so every QuickBooks invoice/bill row stays unstamped forever. Full payloads — customer
// names, emails, addresses, financial lines — could therefore outlive the configured retention
// period without limit. A retention policy that silently fails to delete is worse than one that
// deletes too much.
//
// The row is now COMPACTED rather than exempted: attribution kept, content dropped.
// ---------------------------------------------------------------------------

test('[o3d-9kek r3 f3] expired unresolved evidence is COMPACTED, not kept whole forever', async () => {
  const { compact } = await runRetention()

  // Exactly the rows the delete refuses — the same predicate, so the two can never disagree about
  // a row and leave it both undeleted and uncompacted.
  assert.equal(matches(row({ id: 'legacy' }), compact.where), true)
  assert.equal(matches(row({ id: 'sibling', externalTransactionId: 'XBILL-2' }), compact.where), true)
  assert.equal(matches(row({ status: 'FAILED' }), compact.where), true)
  assert.equal(matches(row({ type: 'SALES_INVOICE' }), compact.where), true)
  // r6 finding 2: a supplier credit note is compacted like any other unresolved row. Before it was
  // added to the shared type list this row was DELETED here instead — the one case where "not
  // compacted" and "not exempt" coincide, which is exactly how it went unnoticed.
  assert.equal(matches(row({ type: 'PURCHASE_CREDIT_NOTE', externalTransactionId: 'XCN-1' }), compact.where), true)

  // Not inside the retention window — content is retained until the period the settings UI promises.
  assert.equal(matches(row({ createdAt: NOW }), compact.where), false)
  // Not a settled row: that one is DELETED, not compacted.
  assert.equal(matches(row({ backReferenceCheckedAt: new Date('2021-01-01') }), compact.where), false)
  // Not an already-compacted row: without this the daily pass would rewrite the whole tombstone
  // set every day, and the marker would keep moving forward for rows nothing had changed.
  assert.equal(matches(row({ backReferenceEvidenceCompactedAt: new Date('2021-01-01') }), compact.where), false)
})

test('[o3d-9kek r3 f3] the tombstone keeps the attribution and drops the personal data', async () => {
  const { compact } = await runRetention()

  // WHAT IS DROPPED. payload is the document as sent — customer and supplier names, email and
  // delivery addresses, line descriptions and amounts. errorMessage echoes connector responses,
  // which quote the same. These are the reason an open-ended exemption was not acceptable.
  assert.deepEqual(compact.data.payload, {})
  assert.equal(compact.data.errorMessage, null)
  assert.ok(compact.data.backReferenceEvidenceCompactedAt instanceof Date)

  // WHAT IS KEPT, asserted by exclusion: the write touches NOTHING else, so connector, type,
  // referenceType, referenceId, externalTransactionId and status all survive.
  // Those are exactly what the PurchaseOrder resolver counts, which is what stops retention
  // turning "two claimants, refuse" into "one claimant, confidently wrong".
  assert.deepEqual(Object.keys(compact.data).sort(), ['backReferenceEvidenceCompactedAt', 'errorMessage', 'payload'])
  // In particular it must not settle the row behind the operator's back: a compacted row is
  // evidence, not a verdict, and stamping it checked would also make it deletable next run.
  assert.equal('backReferenceCheckedAt' in compact.data, false)
  assert.equal('status' in compact.data, false)
})

// ---------------------------------------------------------------------------
// o3d-nepa — retention must not delete the row that is the only local guard against moving the
// same money twice.
//
// The back-reference exemption above is about DOCUMENTS: rows carrying an external id whose local
// link is missing. It requires `externalTransactionId IS NOT NULL` and one of four document types,
// so it says nothing about the follow-up rows whose bare EXISTENCE is what suppresses a second
// remote call:
//
//   • hasExistingSyncLog counts PENDING/PROCESSING/SYNCED for the scope — a SYNCED INVOICE_PAYMENT
//     is the entire suppression, and for an imported order it is the only record anywhere that the
//     ledger was told (decideInvoicePaymentRegistration says so in as many words);
//   • reenqueueMissingCreditNoteAllocations treats a PURCHASE_CREDIT_NOTE_ALLOCATION row of ANY
//     status, terminal ones included, as ownership evidence and skips the credit note;
//   • latestBillPaymentSyncRows derives a bill's settlement status from its newest BILL_PAYMENT row.
//
// None of those guards FAILS when its row is deleted. Each answers "nothing has been sent" and
// means it — and Xero's idempotency key expired six minutes after the original call, so nothing
// remote catches the second one.
// ---------------------------------------------------------------------------

test('[o3d-nepa] a SETTLED payment registration is never deleted by age', async () => {
  const where = await captureDeletePredicate()

  // SYNCED with no external id is the ordinary shape for these — and the back-reference exemption
  // above cannot see it, because that one requires an external id.
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT', status: 'SYNCED', externalTransactionId: null }), where), false)
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT', status: 'SYNCED', externalTransactionId: 'XPAY-1' }), where), false)
  // ...and CANCELLED, which every status-based exemption releases the moment the row terminalises.
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT', status: 'CANCELLED', externalTransactionId: null }), where), false)
  // A stamped verdict does not release it either: backReferenceCheckedAt is about a LINK, and these
  // rows are not evidence of a link — they are evidence that a call was made.
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT', status: 'SYNCED', externalTransactionId: null, backReferenceCheckedAt: OLD }), where), false)
})

test('[o3d-nepa] an applied credit-note allocation is never deleted by age, at ANY status', async () => {
  const where = await captureDeletePredicate()

  // The re-enqueue sweep reads CANCELLED rows as ownership too, so a status-scoped exemption would
  // miss the case that duplicates an allocation (o3d-nepa round 1 finding 4).
  for (const status of ['SYNCED', 'CANCELLED', 'FAILED']) {
    assert.equal(
      matches(row({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', status, externalTransactionId: null }), where),
      false,
      `a ${status} allocation row still keeps its credit note out of the re-enqueue sweep`,
    )
  }
})

test('[o3d-nepa] a sent bill payment is never deleted by age', async () => {
  const where = await captureDeletePredicate()
  assert.equal(matches(row({ type: 'BILL_PAYMENT', status: 'SYNCED', externalTransactionId: 'XPAY-2' }), where), false)
})

test('[o3d-nepa] the exemption is scoped to money, not applied to every follow-up', async () => {
  const where = await captureDeletePredicate()

  // A duplicate PDF, email or WooCommerce note is not a financial error, and a retention policy that
  // never deletes anything is not a retention policy. These still expire.
  for (const type of ['INVOICE_PDF', 'INVOICE_EMAIL', 'WC_INVOICE_NOTE', 'BILL_ATTACHMENT', 'COGS_JOURNAL']) {
    assert.equal(matches(row({ type, status: 'SYNCED', externalTransactionId: null }), where), true, `${type} expires normally`)
  }
})

test('[o3d-nepa] money-evidence rows are NOT compacted either — a blanked payload cannot be pinned', async () => {
  const { compact } = await runRetention()

  // The compaction pass is scoped to the back-reference document types, and it must stay that way:
  // compaction writes `payload: {}`, and the follow-up planner would then have a money row whose
  // stored body can neither prove anything nor be re-sent. That exact shape made money-moving
  // retries permanently unusable in o3d-nepa's own parked attempt (round 1 finding 2).
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT', status: 'SYNCED', externalTransactionId: 'XPAY-1' }), compact.where), false)
  assert.equal(matches(row({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', status: 'SYNCED', externalTransactionId: 'XALLOC-1' }), compact.where), false)
})

// ---------------------------------------------------------------------------
// o3d-nepa, THE P1 ITSELF (Codex r10 #2) — retention must not delete accounting work that can
// STILL BE POSTED.
//
// An earlier revision of this branch left this to PR #618 and shipped only the money-type
// exemption, calling it "a sibling key that merges cleanly". Both halves were wrong: the P1
// behaviour was simply absent (a PENDING SALES_INVOICE was deleted by age, payload and all), and
// the change conflicts with #618 in this very file. The status list is now the SAME shared
// constant #618 introduces, byte for byte, so whichever lands first the other is an identical add
// and the two readers cannot drift.
//
// Asserted behaviourally against the captured predicate for the same reason as everything above: a
// production version that imported the constant and stopped applying it would still pass a
// shape comparison.
// ---------------------------------------------------------------------------

test('[o3d-nepa] a PENDING accounting job is never deleted by age', async () => {
  const where = await captureDeletePredicate()

  // PENDING carries no external id at all, so the back-reference exemption cannot see it and the
  // money-type exemption does not cover a document type. Nothing retained this row before.
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'PENDING', externalTransactionId: null }), where), false)
  assert.equal(matches(row({ type: 'PURCHASE_INVOICE', status: 'PENDING', externalTransactionId: null }), where), false)
  assert.equal(matches(row({ type: 'COGS_JOURNAL', status: 'PENDING', externalTransactionId: null }), where), false)
})

test('[o3d-nepa] a claimed PROCESSING row is never deleted underneath its worker', async () => {
  const where = await captureDeletePredicate()

  // Both processors read the row and its payload BEFORE the conditional claim, so a worker can be
  // holding this payload while retention removes the row; the remote call still happens and the
  // status write-back then fails against a row that is gone.
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'PROCESSING', externalTransactionId: null }), where), false)
})

test('[o3d-nepa] a FAILED row that never posted is never deleted by age', async () => {
  const where = await captureDeletePredicate()

  // o3d-ju8t: FAILED does NOT prove nothing was posted. With no external id the back-reference
  // exemption does not apply, so before the status clause this row expired silently — and it is
  // the hard-delete guard's only evidence that a document may exist in the ledger.
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'FAILED', externalTransactionId: null }), where), false)
  assert.equal(matches(row({ type: 'COGS_JOURNAL', status: 'FAILED', externalTransactionId: null }), where), false)
})

test('[o3d-nepa] the exemption RELEASES the moment the row terminalises', async () => {
  const where = await captureDeletePredicate()

  // The bound on unbounded growth: what is retained is the outstanding-work backlog, not history.
  // SYNCED and CANCELLED rows that are neither money evidence nor unresolved back-reference
  // evidence expire by age exactly as before.
  assert.equal(matches(row({ type: 'COGS_JOURNAL', status: 'SYNCED', externalTransactionId: null }), where), true)
  assert.equal(matches(row({ type: 'COGS_JOURNAL', status: 'CANCELLED', externalTransactionId: null }), where), true)
  // ...and age is still the primary rule for a postable row: nothing inside the window was ever
  // eligible, so the exemption must not be read as the only thing protecting it.
  assert.equal(matches(row({ type: 'COGS_JOURNAL', status: 'PENDING', createdAt: NOW }), where), false)
})

test('[o3d-nepa] an unfinished job keeps its PAYLOAD — it is not compacted either', async () => {
  const { compact } = await runRetention()

  // Compaction writes `payload: {}`. For a row a worker will still post from, that destroys the
  // request while leaving the row claiming the work is owed — the delete's exemption would then be
  // protecting an empty shell. PENDING/PROCESSING are in NEITHER pass, deliberately.
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'PENDING', externalTransactionId: null }), compact.where), false)
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'PROCESSING', externalTransactionId: null }), compact.where), false)
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'FAILED', externalTransactionId: null }), compact.where), false)

  // A FAILED row that DID post is the deliberate overlap: retained by the status clause and
  // compacted by this pass, because its document already exists and both processors short-circuit
  // to the follow-ups instead of re-posting when externalTransactionId is set.
  assert.equal(matches(row({ type: 'SALES_INVOICE', status: 'FAILED', externalTransactionId: 'XINV-1' }), compact.where), true)
})
