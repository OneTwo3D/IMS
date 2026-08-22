import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import {
  CREATE_DISPATCH_UNSETTLED_MEANING,
  decideCreateDispatch,
  describeCreateDispatchNotSent,
} from '@/lib/domain/accounting/create-dispatch-record'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'

/**
 * o3d-jit6 ROUND 3 (Codex HIGH) — A PRE-EGRESS TRANSPORT REFUSAL LEFT A FALSE, PERMANENT MARKER.
 *
 * Rounds 1 and 2 moved the mint into the claim fence and hoisted the journal's own validation above
 * it, and both were real. The marker is still written when nothing leaves, because THE TRANSPORT
 * ITSELF CAN REFUSE AFTER THE FENCE: no usable connection, `accountingPostingIntentRefusal`, the
 * egress authorisations, the rate budget.
 *
 * NONE OF THOSE MAY BE HOISTED — r3's reasons stand and are not being thrown away. Each is evaluated
 * once, immediately before the socket, against the very auth the request was built from; one may
 * read AND write the database and one takes an exclusive slot; and a merged branch deleted exactly
 * such a pre-check because a refusal from a stale read is as wrong as a permission from one.
 *
 * AND MINTING INSIDE THE TRANSPORT IS NOT THE ANSWER EITHER. `waitForBudget` sleeps up to a minute
 * between this fence and that statement, so the claim proof could no longer be adjacent to the mint
 * (the o3d-xl63 r5 #1 rule, which a structural test already enforces) unless the shared HTTP client
 * — every Xero GET, PDF download and attachment upload goes through it — carried a sync-row lease.
 * And it would not even be true: `noteRequest` runs BEFORE `connectorFetch`, so a refused
 * connection sent nothing and would still be minted over.
 *
 * SO THE MARKER STANDS, AND WHAT THIS FILE PINS IS THAT THE FAILURE IS HONEST INSTEAD:
 *
 *   1. the post REPORTS whether it reached the wire, measured from the transport's own attempt
 *      counter — not parsed from a status code or an error string;
 *   2. an attempt that provably sent nothing is `notPosted`, so the row is handed back intact and a
 *      NAMED activity row records that IMS refused to send;
 *   3. the refusal a later attempt makes names BOTH producers of the state instead of asserting the
 *      commit-failure story, and points at that activity row.
 *
 * The residual — the marker itself cannot be cleared without a durable column of its own, because
 * the trigger deliberately forbids clearing the pair — is o3d-gvzu and is asserted here as a known
 * behaviour rather than left to be rediscovered.
 */

/* ------------------------------------------------------------------------------------------------
 * THE TRANSPORT, REAL, WITH ONLY ITS EDGES DOUBLED.
 * ---------------------------------------------------------------------------------------------- */

/** Whether a Xero connection resolves at all. */
let auth: { accessToken: string; tenantId: string } | null = { accessToken: 'tok', tenantId: 'tenant-1' }
/** `accountingPostingIntentRefusal`'s answer — a refusal string, or null to allow. */
let intentRefusal: string | null = null
/** `accountingEgressRefusal`'s answer — a refusal string, or null to allow. */
let egressRefusal: string | null = null
/** What `connectorFetch` answers when it is actually reached. */
let fetchAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { ManualJournals: [{ ManualJournalID: 'MJ-1', Narration: 'COGS', Status: 'POSTED' }] },
}
/** Every call that reached `connectorFetch`. The number that decides `reachedTheWire`. */
const wireCalls: string[] = []

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => auth,
    getStoredTenantBlockReason: async () => null,
  },
})

mock.module('@/lib/connectors/accounting-posting-intent', {
  namedExports: { accountingPostingIntentRefusal: () => intentRefusal },
})

mock.module('@/lib/connectors/accounting-egress-authorization', {
  namedExports: { accountingEgressRefusal: async () => egressRefusal },
})

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      wireCalls.push(url)
      return {
        ok: fetchAnswer.status >= 200 && fetchAnswer.status < 300,
        status: fetchAnswer.status,
        headers: { get: () => null },
        json: async () => fetchAnswer.body,
        text: async () => JSON.stringify(fetchAnswer.body),
      } as unknown as Response
    },
  },
})

type JournalsModule = typeof import('../../lib/connectors/xero/journals.ts')

async function journals(): Promise<JournalsModule> {
  return await import('@/lib/connectors/xero/journals')
}

const LINES = [
  { accountCode: '310', description: 'COGS', debit: 40 },
  { accountCode: '630', description: 'Inventory', credit: 40 },
]

async function postOne() {
  const { prepareManualJournal, postPreparedManualJournal } = await journals()
  const prepared = prepareManualJournal({
    date: '2026-08-22', reference: 'COGS 2026-08-22', narration: 'COGS', lines: LINES,
  })
  assert.ok(prepared.ok, 'the journal itself is valid — every gate above the fence has passed')
  return postPreparedManualJournal(prepared.prepared, { idempotencyKey: 'ims-manual-journal-log-1' })
}

function reset() {
  wireCalls.length = 0
  auth = { accessToken: 'tok', tenantId: `tenant-${Math.random()}` }
  intentRefusal = null
  egressRefusal = null
  fetchAnswer = {
    status: 200,
    body: { ManualJournals: [{ ManualJournalID: 'MJ-1', Narration: 'COGS', Status: 'POSTED' }] },
  }
}

test('o3d-jit6 r3: every pre-egress transport refusal reports that NOTHING reached the wire', async () => {
  // The three refusals that sit BELOW the fence and can be driven without spending a day's rate
  // budget. Each of them used to be indistinguishable, at the call site, from a post Xero rejected.
  const refusals: Array<[string, () => void]> = [
    ['no usable connection', () => { auth = null }],
    ['posting intent refused', () => { intentRefusal = 'Xero posting is paused for this organisation' }],
    ['egress authorisation refused', () => { egressRefusal = 'This connection is not authorised to write' }],
  ]

  for (const [name, arrange] of refusals) {
    reset()
    arrange()

    const result = await postOne()

    assert.equal(result.success, false, `${name}: the post fails`)
    assert.deepEqual(wireCalls, [], `${name}: and provably nothing left the process`)
    assert.equal(result.reachedTheWire, false, `THE POINT (${name}): and the caller is told so`)
  }
})

test('o3d-jit6 r3: a post XERO REJECTED reports that it DID reach the wire', async () => {
  // THE CONTROL, and the one that stops the fix being "call everything unsent". A 400 from Xero is
  // a real request that a real ledger answered; the document may not exist, but the create was
  // dispatched and the marker standing over it is TRUE. Classifying this as not-sent would hand the
  // row back for ever and, far worse, tell an operator the ledger should be empty when it may not be.
  reset()
  fetchAnswer = { status: 400, body: { Message: 'Account code 800 is not valid for this document' } }

  const result = await postOne()

  assert.equal(result.success, false)
  assert.equal(wireCalls.length, 1, 'a request really was made')
  assert.equal(result.reachedTheWire, true, 'so nothing about it is provably unsent')
})

test('o3d-jit6 r3: a successful post reaches the wire and returns the journal id', async () => {
  reset()

  const result = await postOne()

  assert.equal(result.success, true)
  assert.equal(result.journalId, 'MJ-1')
  assert.equal(result.reachedTheWire, true)
  assert.equal(wireCalls.length, 1)
})

test('o3d-jit6 r3: the attempt counter is the statement immediately before the socket', async () => {
  // `reachedTheWire` is a DELTA OF `xeroHttpAttemptCount()`, so it is only worth anything while that
  // counter is bumped on the last statement before `connectorFetch`, on the one path that reaches
  // Xero's API. If a future edit puts an early return, a guard or an await between them, the counter
  // would say "sent" for a request that was not, or vice versa — and this is the only place that can
  // see it, because no unit test can observe a statement that is not there.
  const source = readFileSync('lib/connectors/xero/api.ts', 'utf8')
  const note = source.indexOf('noteRequest(auth.tenantId)')
  const send = source.indexOf('await connectorFetch(url, init, ')
  assert.ok(note > -1 && send > note, 'noteRequest must precede the send')
  const between = source.slice(note, send)
  assert.ok(!between.includes('return'), 'nothing may return between counting an attempt and making it')
  assert.ok(!between.includes('await'), 'and nothing awaitable may sit between them either')
  // Exactly one call site each, so "the counter did not move" cannot be true of a send made
  // elsewhere in this module, and no send can be made without being counted.
  assert.equal(source.split('connectorFetch(').length - 1, 1, 'exactly one Xero API send in this module')
  assert.equal(
    source.split('noteRequest(').length - 1,
    2,
    'exactly one definition and one call of the counter',
  )
})

/* ------------------------------------------------------------------------------------------------
 * THE MEDIUM: `PreparedManualJournal` IS OPAQUE, SO THE GATES CANNOT BE WALKED PAST.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r3 (MEDIUM): an external caller CANNOT construct a PreparedManualJournal', async () => {
  const { postPreparedManualJournal } = await journals()
  reset()

  // THE WHOLE ASSERTION IS THE DIRECTIVE BELOW, and it is checked by `npx tsc --noEmit`, not at run
  // time. While the type is branded this line does not compile, so `@ts-expect-error` is used and
  // the build is green. Delete the brand and the type becomes structural again: the line compiles,
  // the directive becomes UNUSED, and tsc fails with "Unused '@ts-expect-error' directive" — which
  // is the test failing, in the only place a type-level guarantee can be tested from.
  //
  // Every gate the r2 split moved into `prepareManualJournal` — a journal with no non-zero lines,
  // one whose debits and credits disagree — is walked straight past by this call. That is why the
  // type has to refuse it rather than a comment claiming it does.
  // @ts-expect-error a body that never cleared prepareManualJournal is not a PreparedManualJournal
  const refused = postPreparedManualJournal({ journal: { Narration: 'anything at all' } })
  await refused.catch(() => undefined)

  // And the brand cannot be obtained from the module either: it is `declare const`, never exported,
  // so no caller can even name the property it would have to supply.
  const source = readFileSync('lib/connectors/xero/journals.ts', 'utf8')
  assert.match(source, /declare const PREPARED_MANUAL_JOURNAL_BRAND: unique symbol/)
  assert.ok(!/export .*PREPARED_MANUAL_JOURNAL_BRAND/.test(source), 'the brand must never be exported')
  // ONE mint. A second `as PreparedManualJournal` anywhere would be a second door into the type.
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('*')).join('\n')
  assert.equal(
    code.split('as PreparedManualJournal').length - 1,
    1,
    'prepareManualJournal must be the only place that asserts the brand',
  )
})

/* ------------------------------------------------------------------------------------------------
 * THE REFUSAL THAT FOLLOWS: HONEST ABOUT WHAT IT DOES NOT KNOW.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r3: the refusal names BOTH producers of the state, not just the commit failure', async () => {
  const dispatchedAt = new Date('2026-08-22T09:00:00.000Z')
  const decision = decideCreateDispatch({
    type: 'COGS_JOURNAL',
    idempotencyKey: 'ims-manual-journal-log-1',
    recorded: { dispatchedAt, idempotencyKey: 'ims-manual-journal-log-1' },
    now: new Date(dispatchedAt.getTime() + XERO_IDEMPOTENCY_KEY_RETENTION_MS + 60_000),
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
  })

  assert.equal(decision.dispatch, false)
  const error = decision.dispatch === false ? decision.error : ''
  // THE DEFECT IN THE PROSE. It used to say the state "is what happens when the post succeeds and
  // the transaction that would have written the id fails at COMMIT" — one producer, stated as the
  // explanation. An operator acting on that hunts for a document that may never have existed, and on
  // a DAILY_BATCH row the remedy it leads to is hand-posting a journal to replace one IMS never sent.
  assert.ok(
    !/never recorded a document id for it — which is what/.test(error),
    'the commit-failure story must not be presented as THE explanation',
  )
  assert.match(error, /TWO THINGS PRODUCE THAT STATE/, 'both producers are named')
  assert.match(error, /transport then refused before anything left the process/)
  assert.match(error, /in which case NO document exists/)
  // And it points at the thing an operator can actually look up, before the ledger.
  assert.match(error, /xero_sync_transport_refused_before_post/)
  // The parts that must survive: the key/window reasoning, and a remedy chosen by type.
  assert.match(error, /idempotency key after 6 minutes/)
  assert.match(error, /REMEDY:/)
})

test('o3d-jit6 r3: the not-sent message says the marker STANDS, rather than implying it was cleared', async () => {
  const message = describeCreateDispatchNotSent({
    label: 'COGS_JOURNAL for PurchaseOrder po-1',
    error: 'Xero day budget exhausted for this tenant',
  })

  assert.match(message, /NOTHING WAS SENT/)
  assert.match(message, /Xero day budget exhausted/, 'the transport\'s own reason travels')
  // THE RESIDUAL, SAID OUT LOUD. o3d-gvzu is the column that would let the marker be released; until
  // it exists, a message that implied recovery had happened would be the laundering this branch is
  // about, pointing the other way.
  assert.match(message, /dispatch record STANDS/)
  assert.match(message, /never cleared/)
  assert.ok(CREATE_DISPATCH_UNSETTLED_MEANING.includes('xero_sync_transport_refused_before_post'))
})

/* ------------------------------------------------------------------------------------------------
 * THE WIRING, WHICH NO UNIT ABOVE CAN PROVE.
 * ---------------------------------------------------------------------------------------------- */

test('o3d-jit6 r3: the journal branch classifies an unsent post as notPosted, and the runner logs it', async () => {
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const branch = source.slice(
    source.indexOf("const idempotencySource = typeof payload._idempotencyKey === 'string'"),
    source.indexOf("case 'TAX_RATE_SYNC': {"),
  )
  assert.ok(branch.length > 0, 'the manual-journal branch must be locatable')

  // The classification is on the MEASURED fact, and only on a post that failed: a successful post
  // is never reclassified, whatever the counter did.
  assert.match(
    branch,
    /if \(!posted\.success && !posted\.reachedTheWire\) \{/,
    'the branch must classify on what the transport did, not on the error text',
  )
  assert.match(branch, /notPosted: \{ reason: 'transport-refused', operation: 'manual-journal', message \}/)
  // No status code and no error-string test anywhere in the branch — a shape test is not evidence.
  assert.ok(!/status === 0|res\.status|\.error\?\.includes|match\(/.test(branch),
    'the branch must not infer "nothing was sent" from a status code or from prose')

  // And the runner turns that reason into its own named activity row, on BOTH paths — the sweep and
  // the outbox — because the refusal tells operators to look for exactly that action.
  assert.equal(
    source.split("'xero_sync_transport_refused_before_post'").length - 1,
    2,
    'both runner paths must name the action',
  )
  assert.equal(
    source.split("reason === 'transport-refused'").length - 1,
    2,
    'and both must select it from the reason rather than falling through to claim-lost',
  )
})
