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
 * These tests are about the three states a row can now be in and the one that must refuse:
 *   • compacted, column present            → decides from the column. This is the point.
 *   • pre-migration, payload present       → decides from the payload. No rollout cliff.
 *   • both present and DISAGREEING         → decides NOTHING. "I cannot tell" is not "the same".
 */

const ACTIVE = 'xero:tenant-A'
const OTHER = 'xero:tenant-B'

const WHAT = { type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', referenceId: 'po-1' }

async function mod() {
  return import('@/lib/connectors/accounting-connection-provenance')
}

test('o3d-dzip: a RETENTION-COMPACTED row still names the organisation it was raised against', async () => {
  const { readAccountingOriginRecord, accountingPayloadConnectionVerdict } = await mod()

  // Exactly what `backReferenceEvidenceTombstone` leaves behind: `payload: {}`, everything else kept.
  const compacted = { payload: {}, connectionProvenance: ACTIVE }

  const stamp = readAccountingOriginRecord(compacted)
  assert.equal(stamp.state, 'stamped')
  assert.equal(stamp.state === 'stamped' ? stamp.provenance : null, ACTIVE)

  const verdict = accountingPayloadConnectionVerdict({
    payload: compacted.payload,
    connectionProvenance: compacted.connectionProvenance,
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
  assert.equal(readAccountingOriginRecord({ payload: {}, connectionProvenance: '!disconnected' }).state, 'raised-disconnected')

  const verdict = accountingPayloadConnectionVerdict({
    payload: {},
    connectionProvenance: '!disconnected',
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
