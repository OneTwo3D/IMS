import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * o3d-dzip — THE ORIGIN RECORD HAS TO SURVIVE RETENTION.
 *
 * o3d-s36z put `_connectionProvenance` in the payload, which is the one column retention is
 * DESIGNED to destroy: `backReferenceEvidenceTombstone` compacts an expired-but-unresolved row to
 * `payload: {}` and KEEPS its `externalTransactionId`, so precisely the rows whose realm is least
 * knowable — old, unresolved, still naming a live document in somebody's ledger — are the ones with
 * nothing left to read.
 *
 * These tests are about the states a row can now be in and the ones that must refuse:
 *   • compacted, column present            → decides from the column. This is the point.
 *   • pre-migration, payload present       → decides from the payload. No rollout cliff.
 *   • both present and DISAGREEING         → decides NOTHING. "I cannot tell" is not "the same".
 *   • column present, payload REWRITTEN    → decides NOTHING either (Codex r1 finding 1). A payload
 *                                            that merely lacks the stamp is not a compacted one, and
 *                                            the column may not vouch for content it never saw.
 */

const ACTIVE = 'xero:tenant-A'
const OTHER = 'xero:tenant-B'

/** What retention's `backReferenceEvidenceTombstone` stamps beside `payload: {}`. */
const COMPACTED_AT = new Date('2026-02-01T00:00:00.000Z')

const WHAT = { type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', referenceId: 'po-1' }

async function mod() {
  return import('@/lib/connectors/accounting-connection-provenance')
}

test('o3d-dzip: a RETENTION-COMPACTED row still names the organisation it was raised against', async () => {
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()

  // Exactly what `backReferenceEvidenceTombstone` leaves behind: `payload: {}` and the compaction
  // instant, everything else kept. BOTH are needed — see the rewritten-payload test below.
  const compacted = { payload: {}, connectionProvenance: ACTIVE, backReferenceEvidenceCompactedAt: COMPACTED_AT }

  const stamp = readAccountingOriginRecord(compacted)
  assert.equal(stamp.state, 'stamped')
  assert.equal(stamp.state === 'stamped' ? stamp.provenance : null, ACTIVE)

  const verdict = accountingPayloadConnectionVerdict({
    payload: compacted.payload,
    connectionProvenance: compacted.connectionProvenance,
    backReferenceEvidenceCompactedAt: compacted.backReferenceEvidenceCompactedAt,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  // Before the column existed this was `no-origin-recorded`, refused, and unresolvable — the payload
  // it would have been checked from had been deliberately deleted.
  assert.equal(verdict.decision, 'match')
  assert.equal(verdict.mayPost, true)
  assert.equal(verdict.refusal, null)
})

test('o3d-dzip: a compacted row raised against ANOTHER organisation is still caught', async () => {
  const { accountingPayloadConnectionVerdict } = await mod()
  const verdict = accountingPayloadConnectionVerdict({
    payload: {},
    connectionProvenance: OTHER,
    backReferenceEvidenceCompactedAt: COMPACTED_AT,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'mismatch')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /queued for accounting connection xero:tenant-B/)
  assert.match(verdict.refusal ?? '', /now connected to xero:tenant-A/)
})

test('o3d-dzip: a row queued BEFORE the column existed still decides from its payload', async () => {
  // The rollout half. Reading the column alone would refuse every row already in the queue at the
  // moment of the deploy, and the only remedy for `no-origin-recorded` is to cancel and re-queue it
  // by hand — a queue's worth of manual work manufactured by the fix.
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()
  const legacy = { payload: { _connectionProvenance: ACTIVE, amount: 10 }, connectionProvenance: null }

  assert.equal(readAccountingOriginRecord(legacy).state, 'stamped')
  const verdict = accountingPayloadConnectionVerdict({
    payload: legacy.payload,
    connectionProvenance: legacy.connectionProvenance,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'match')
  assert.equal(verdict.mayPost, true)
})

test('o3d-dzip: a column and a payload that DISAGREE decide NOTHING — no majority, no newest-wins', async () => {
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()

  const conflicted = { payload: { _connectionProvenance: OTHER }, connectionProvenance: ACTIVE }
  const stamp = readAccountingOriginRecord(conflicted)
  assert.equal(stamp.state, 'unreadable')
  assert.match(stamp.state === 'unreadable' ? stamp.detail : '', /durable column says xero:tenant-A/)
  assert.match(stamp.state === 'unreadable' ? stamp.detail : '', /payload says xero:tenant-B/)

  // And it must refuse EVEN WHEN THE COLUMN AGREES WITH THE LIVE CONNECTION, which is the tempting
  // wrong answer: "the durable one is authoritative, and it matches, so post". One of the two records
  // was rewritten by a writer that did not know about the other, and nothing here can say which.
  const verdict = accountingPayloadConnectionVerdict({
    payload: conflicted.payload,
    connectionProvenance: conflicted.connectionProvenance,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'unreadable')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /Nothing was sent/)
})

test('o3d-dzip: "raised while disconnected" survives compaction as ITSELF, not as silence', async () => {
  // The three states o3d-s36z separated must stay three after retention. A `!disconnected` row that
  // compacted to `absent` would swap a refusal that says "we KNOW nothing vouched for these ids" for
  // one that says "we know nothing at all" — same verdict today, different fact, and the second is
  // the one an operator cannot act on.
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()
  assert.equal(
    readAccountingOriginRecord({
      payload: {},
      connectionProvenance: '!disconnected',
      backReferenceEvidenceCompactedAt: COMPACTED_AT,
    }).state,
    'raised-disconnected',
  )

  const verdict = accountingPayloadConnectionVerdict({
    payload: {},
    connectionProvenance: '!disconnected',
    backReferenceEvidenceCompactedAt: COMPACTED_AT,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'raised-disconnected')
  assert.equal(verdict.mayPost, false)
})

test('o3d-dzip: a row that records nothing ANYWHERE still refuses, and an unreadable half still refuses', async () => {
  const { readAccountingOriginRecord } = await mod()
  assert.equal(readAccountingOriginRecord({ payload: { amount: 1 }, connectionProvenance: null }).state, 'absent')
  assert.equal(readAccountingOriginRecord({ payload: {}, connectionProvenance: undefined }).state, 'absent')

  // A blank column is not an absent one: something wrote it.
  assert.equal(readAccountingOriginRecord({ payload: {}, connectionProvenance: '   ' }).state, 'unreadable')
  // An unreadable PAYLOAD poisons the row even when the column is perfectly readable — the column
  // describes the INSERT, and this payload is no longer the one the INSERT wrote.
  assert.equal(readAccountingOriginRecord({ payload: 'not an object', connectionProvenance: ACTIVE }).state, 'unreadable')
  assert.equal(readAccountingOriginRecord({ payload: [], connectionProvenance: ACTIVE }).state, 'unreadable')
})

test('o3d-dzip: the column is MINTED from the stamp, and mints nothing an unstamped payload does not say', async () => {
  const { mintAccountingConnectionProvenanceColumn, stampAccountingPayloadConnection } = await mod()

  assert.equal(mintAccountingConnectionProvenanceColumn(stampAccountingPayloadConnection({ a: 1 }, ACTIVE)), ACTIVE)
  assert.equal(mintAccountingConnectionProvenanceColumn(stampAccountingPayloadConnection({ a: 1 }, null)), '!disconnected')
  // A repair that inherited nothing must mint nothing: a column filled in from the live connection is
  // the forgery this whole record exists to make impossible.
  assert.equal(mintAccountingConnectionProvenanceColumn({ a: 1 }), null)
  assert.equal(mintAccountingConnectionProvenanceColumn({ _connectionProvenance: 42 }), null)
  assert.equal(mintAccountingConnectionProvenanceColumn(null), null)
})

test('o3d-dzip: the posting intent carries the column to the socket, so a compacted row is CHECKED', async () => {
  // The wiring, not the rule: the verdict is only reached from `accountingPostingIntentRefusal`, and
  // an intent that carried the payload alone would narrow every one of the tests above back to the
  // defect while still looking checked.
  const { withAccountingPostingIntent, accountingPostingIntentRefusal } =
    await import('@/lib/connectors/accounting-posting-intent')

  const compactedIntent = {
    connector: 'xero',
    payload: {},
    connectionProvenance: ACTIVE,
    backReferenceEvidenceCompactedAt: COMPACTED_AT,
    type: 'COGS_JOURNAL',
    referenceType: 'PurchaseOrder',
    referenceId: 'po-1',
  }

  await withAccountingPostingIntent(compactedIntent, async () => {
    assert.equal(accountingPostingIntentRefusal('xero', 'tenant-A'), null, 'the ledger it was raised for')
    assert.match(
      accountingPostingIntentRefusal('xero', 'tenant-B') ?? '',
      /queued for accounting connection xero:tenant-A/,
      'and a different one is still refused at the socket',
    )
  })
})

test('o3d-dzip r1#1: a POST-MIGRATION row whose payload was REWRITTEN is refused, not authorised by the column', async () => {
  // THE FINDING, MODELLED EXACTLY. This is not a compacted row and not a pre-migration row: the column
  // was minted by the INSERT (so this row is post-migration), and the payload has since been REWRITTEN
  // by something that never heard of `_connectionProvenance` — a repair rebuilding the document, a
  // seed, a psql fix, an older release still rolling. The payload read is `absent` in both cases, and
  // the first cut of the fallback returned the untouched column as authoritative for both: a payload
  // nothing vouched for, authorised by a column that had never seen it.
  //
  // What separates them is not the payload — it is retention's own record of having emptied it.
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()

  const rewritten = {
    // A rebuilt document: real content, no stamp. NOT the `{}` a tombstone leaves.
    payload: { amount: 10, accountCode: '500' },
    connectionProvenance: ACTIVE,
    // NEVER COMPACTED. This is the whole difference.
    backReferenceEvidenceCompactedAt: null,
  }

  const stamp = readAccountingOriginRecord(rewritten)
  assert.equal(stamp.state, 'unreadable', 'a rewritten payload beside a minted column is undecidable')
  assert.match(stamp.state === 'unreadable' ? stamp.detail : '', /no record of having been compacted/)
  assert.match(stamp.state === 'unreadable' ? stamp.detail : '', /REWRITTEN after the insert/)

  // And it must refuse EVEN THOUGH THE COLUMN AGREES WITH THE LIVE CONNECTION — the same tempting
  // wrong answer the disagreement test names, reached by a different route.
  const verdict = accountingPayloadConnectionVerdict({
    payload: rewritten.payload,
    connectionProvenance: rewritten.connectionProvenance,
    backReferenceEvidenceCompactedAt: rewritten.backReferenceEvidenceCompactedAt,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'unreadable')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /Nothing was sent/)

  // An EMPTIED payload with no compaction record is the same row: somebody wrote `{}` over it. The
  // emptiness is not the evidence; the compaction stamp is.
  assert.equal(
    readAccountingOriginRecord({ payload: {}, connectionProvenance: ACTIVE, backReferenceEvidenceCompactedAt: null }).state,
    'unreadable',
  )
  // Nor is the compaction stamp alone enough: retention writes `payload: {}` in the SAME statement, so
  // a compaction record sitting beside a payload that still has content describes two different rows.
  assert.equal(
    readAccountingOriginRecord({
      payload: { amount: 10 },
      connectionProvenance: ACTIVE,
      backReferenceEvidenceCompactedAt: COMPACTED_AT,
    }).state,
    'unreadable',
  )
})

test('o3d-dzip r1#1: the refusal does NOT reach a genuine pre-migration row, which still decides from its payload', async () => {
  // The over-refusal this precondition must not cause. A pre-migration row has NO column, so it never
  // reaches the column-only line at all — it is decided from its payload exactly as it was before the
  // column shipped, compaction record or not.
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()

  const preMigration = {
    payload: { _connectionProvenance: ACTIVE, amount: 10 },
    connectionProvenance: null,
    backReferenceEvidenceCompactedAt: null,
  }
  assert.equal(readAccountingOriginRecord(preMigration).state, 'stamped')
  assert.equal(
    accountingPayloadConnectionVerdict({ ...preMigration, activeProvenance: ACTIVE, ...WHAT }).mayPost,
    true,
  )

  // And a row with NEITHER half is still `no-origin-recorded` rather than `unreadable`: the population
  // stays countable, which is the reason that decision keeps its own name.
  const verdict = accountingPayloadConnectionVerdict({
    payload: { amount: 10 },
    connectionProvenance: null,
    backReferenceEvidenceCompactedAt: null,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'no-origin-recorded')
  assert.equal(verdict.mayPost, false)
})

test('o3d-dzip r1#1: the compaction instant is read from the SAME statement as the payload and the column', async () => {
  // The wiring. A reader that fetched the compaction record separately could be handed a compaction
  // that happened after the payload it is vouching for was read — which is the disagreement this
  // module refuses on, manufactured by the reader itself.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/domain/accounting/claimed-sync-payload.ts', 'utf8')
  assert.match(
    source,
    /select: \{ payload: true, connectionProvenance: true, backReferenceEvidenceCompactedAt: true \},/,
    'one findUnique selects all three halves of the record',
  )
  assert.equal(
    (source.match(/await client\.accountingSyncLog\.findUnique\(/g) ?? []).length,
    1,
    'and there is only one read',
  )
})

// ---------------------------------------------------------------------------
// o3d-bqw7 r2 (Codex HIGH) — AND THE FOLLOW-UP A TOMBSTONE RAISES MUST BE ABLE TO POST.
//
// `compacted-followup-loss.ts` classifies a tombstone's invoice PDF as REBUILT: it is assembled from
// `externalTransactionId` and `referenceId`, both of which compaction keeps. The processor duly
// enqueued one — and handed the enqueue the COMPACTED PAYLOAD as its origin evidence, so the row it
// created carried no origin at all and was refused at post time as `no-origin-recorded`. The
// classification was a claim the pipeline did not honour.
// ---------------------------------------------------------------------------

test('[o3d-bqw7 r2] a follow-up inherited from a TOMBSTONE can actually post', async () => {
  const { carryAccountingOriginRecordFrom, accountingPayloadConnectionVerdict } = await mod()

  // The source row exactly as retention leaves it.
  const tombstone = { payload: {}, connectionProvenance: ACTIVE, backReferenceEvidenceCompactedAt: COMPACTED_AT }

  const followUp = carryAccountingOriginRecordFrom({ accountingInvoiceId: 'XINV-1', referenceId: 'so-1' }, tombstone)

  // The follow-up is a NEW row: it has no column of its own yet, so everything the guard will read
  // has to be in the payload it was born with.
  const verdict = accountingPayloadConnectionVerdict({
    payload: followUp,
    connectionProvenance: null,
    activeProvenance: ACTIVE,
    ...WHAT,
  })
  assert.equal(verdict.decision, 'match')
  assert.equal(verdict.mayPost, true, 'the PDF the table calls REBUILT must be raisable, not merely enqueueable')
})

test('[o3d-bqw7 r2] and it is still caught when the organisation has changed underneath it', async () => {
  const { carryAccountingOriginRecordFrom, accountingPayloadConnectionVerdict } = await mod()
  const tombstone = { payload: {}, connectionProvenance: OTHER, backReferenceEvidenceCompactedAt: COMPACTED_AT }

  const followUp = carryAccountingOriginRecordFrom({ accountingInvoiceId: 'XINV-1' }, tombstone)
  const verdict = accountingPayloadConnectionVerdict({
    payload: followUp, connectionProvenance: null, activeProvenance: ACTIVE, ...WHAT,
  })
  assert.equal(verdict.decision, 'mismatch')
  assert.equal(verdict.mayPost, false, 'inheriting must not become a way of being permitted')
})

test('[o3d-bqw7 r2] an ORDINARY row is carried verbatim, exactly as before', async () => {
  const { carryAccountingOriginRecord, carryAccountingOriginRecordFrom } = await mod()
  const ordinary = { payload: { _connectionProvenance: ACTIVE, amount: 12 }, connectionProvenance: null }

  assert.deepEqual(
    carryAccountingOriginRecordFrom({ accountingInvoiceId: 'XINV-1' }, ordinary),
    carryAccountingOriginRecord({ accountingInvoiceId: 'XINV-1' }, ordinary.payload),
    'where the payload speaks, nothing about the answer changes',
  )
})

test('[o3d-bqw7 r2] a payload REWRITTEN after the insert inherits NOTHING, column or no column', async () => {
  const { carryAccountingOriginRecordFrom, accountingPayloadConnectionVerdict } = await mod()
  // Not a tombstone: the payload has keys and no stamp, so it was rewritten by a writer the column
  // never saw. `readAccountingOriginRecord` calls that unreadable, and unreadable inherits nothing.
  const rewritten = { payload: { amount: 12 }, connectionProvenance: ACTIVE, backReferenceEvidenceCompactedAt: null }

  const followUp = carryAccountingOriginRecordFrom({ accountingInvoiceId: 'XINV-1' }, rewritten)
  assert.equal('_connectionProvenance' in followUp, false)
  const verdict = accountingPayloadConnectionVerdict({
    payload: followUp, connectionProvenance: null, activeProvenance: ACTIVE, ...WHAT,
  })
  assert.equal(verdict.mayPost, false, 'the column must not vouch, one step out, for content it never saw')
})

test('[o3d-bqw7 r2] a caller-stamped origin on the BODY is discarded, not merged', async () => {
  const { carryAccountingOriginRecordFrom } = await mod()
  const tombstone = { payload: {}, connectionProvenance: ACTIVE, backReferenceEvidenceCompactedAt: COMPACTED_AT }

  const followUp = carryAccountingOriginRecordFrom(
    { accountingInvoiceId: 'XINV-1', _connectionProvenance: OTHER },
    tombstone,
  )
  assert.equal(followUp._connectionProvenance, ACTIVE, 'a marker may only be written by the row that took the action')
})
