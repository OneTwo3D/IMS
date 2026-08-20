import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyMainSyncFailureRetry,
  heldClaimWhere,
  recordPostedSyncResult,
} from '@/lib/connectors/xero/sync-processor'

// ---------------------------------------------------------------------------
// o3d-550x — the accounting processor wrote its result BY ROW ID, unfenced.
//
// TWO DIFFERENT WRITES, TWO DIFFERENT ANSWERS, and conflating them is the reason this issue could not
// simply be "fence everything":
//
//  • A RELEASE OF THE CLAIM (failure retry, rate-limit backoff, ordering deferral) asserts a state the
//    row can be talked out of. It must land ONLY while this worker still holds the claim it took —
//    otherwise a worker whose claim went stale comes back, drops the row to PENDING over the
//    replacement's live claim, and the row is re-claimed a third time while a request is on the wire.
//    The old `{ id, retryCount }` guard could not stop it: A RE-CLAIM DOES NOT ADVANCE retryCount.
//
//  • A RECORD OF A POSTED DOCUMENT states a fact about the external ledger that has already happened.
//    Fencing THAT on claim ownership is the failure mode the settled rule forbids — the worker that
//    actually posted would write nothing and the document would exist in Xero with nothing in IMS
//    naming it. Its only precondition is the fact it protects: the row must not already name a
//    DIFFERENT document. Whichever worker gets there first wins, and no race decides it.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  status: string
  processingStartedAt: Date | null
  retryCount: number
  externalTransactionId: string | null
  syncedAt: Date | null
  errorMessage: string | null
}

/**
 * A one-row store that HONOURS its where clause, including the `OR` the evidence write uses.
 *
 * This matters more than usual here: the entire property under test is WHICH writes match and which do
 * not. A double that ignored `where` would report the fix as working and the defect as working equally
 * well — which is exactly what the canned-count double in main-sync-failure-retry-concurrency.test.ts
 * does, and why the behavioural assertions live in this file instead.
 */
function makeRowStore(row: Partial<Row> & { id: string }) {
  const state: Row = {
    status: 'PROCESSING',
    processingStartedAt: null,
    retryCount: 0,
    externalTransactionId: null,
    syncedAt: null,
    errorMessage: null,
    ...row,
  }
  const mirrorWrites: unknown[] = []

  const leafMatches = (where: Record<string, unknown>): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'OR') continue
      const actual = (state as unknown as Record<string, unknown>)[key]
      if (expected instanceof Date) {
        if ((actual as Date | null)?.valueOf() !== expected.valueOf()) return false
      } else if (actual !== expected) return false
    }
    if (Array.isArray(where.OR)) {
      if (!(where.OR as Array<Record<string, unknown>>).some((clause) => leafMatches(clause))) return false
    }
    return true
  }

  const accountingSyncLog = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!leafMatches(where)) return { count: 0 }
      Object.assign(state, data)
      return { count: 1 }
    },
    findUnique: async () => ({ ...state }),
  }

  const tx = new Proxy({ accountingSyncLog }, {
    get(_target, prop: string) {
      if (prop === 'accountingSyncLog') return accountingSyncLog
      // Mirror-table delegates: record the call so "the mirror was NOT written" is assertable.
      // They answer NOTHING FOUND (null / []), which is the mirror's own "no event to update" path —
      // this file is about the sync row, and a half-built mirror event would only add noise.
      return new Proxy({}, {
        get: (_t, method: string) => async (args: unknown) => {
          mirrorWrites.push({ delegate: prop, method, args })
          return method === 'findMany' ? [] : null
        },
      })
    },
  })
  return { tx: tx as never, state, mirrorWrites }
}

const T_DISPLACED_CLAIM = new Date('2026-03-01T09:00:00.000Z')
const T_REPLACEMENT_CLAIM = new Date('2026-03-01T09:20:00.000Z')

const ENTRY = {
  id: 'log-1',
  retryCount: 2,
  type: 'SALES_INVOICE' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
}

test('o3d-550x: heldClaimWhere names the claim INSTANT, not merely that the row is claimed', () => {
  // The replacement's row is PROCESSING too, so `status: PROCESSING` alone identifies nothing.
  assert.deepEqual(heldClaimWhere('log-1', T_DISPLACED_CLAIM), {
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_DISPLACED_CLAIM,
  })
})

test('o3d-550x: a displaced owner cannot release the replacement\'s claim', async () => {
  // The row was re-taken at 09:20 after the 09:00 claim aged out. The 09:00 worker is still alive — a
  // timeout cannot recall a request already on the wire — and now reports its failure.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  await applyMainSyncFailureRetry(tx, ENTRY, 'connection reset', {}, T_DISPLACED_CLAIM)

  assert.equal(state.status, 'PROCESSING', 'the replacement still holds the row')
  assert.equal(state.processingStartedAt?.valueOf(), T_REPLACEMENT_CLAIM.valueOf())
  assert.equal(state.retryCount, 2, 'and its attempt budget was not spent by a worker that no longer owns it')
  assert.equal(state.errorMessage, null, 'nor was the replacement\'s row annotated with a stranger\'s error')
})

test('o3d-550x: the worker that DOES hold the claim still records its failure', async () => {
  // The counter-guard: fencing must not freeze the row. Without this, the fix would be indistinguishable
  // from "the failure write never lands", which would strand every genuinely failing row in PROCESSING.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  const result = await applyMainSyncFailureRetry(tx, ENTRY, 'connection reset', {}, T_REPLACEMENT_CLAIM)

  assert.equal(state.status, 'PENDING')
  assert.equal(state.retryCount, 3)
  assert.equal(state.processingStartedAt, null, 'the claim is given back, so the row can be re-taken')
  assert.equal(result.finalFailure, false)
})

test('o3d-550x: a posted document is recorded even by a worker whose claim has been taken away', async () => {
  // THE RULE THIS PINS: evidence of a posted document must NEVER be conditional on winning a race. The
  // row is PROCESSING under a claim stamped 20 minutes after this worker's, i.e. this worker is
  // displaced — and it still records, because the fact it is recording already happened in Xero.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: null,
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true)
  assert.equal(state.externalTransactionId, 'INV-XERO-1', 'the document id is on the row, not only in a log')
  assert.equal(state.status, 'SYNCED')
  assert.equal(state.processingStartedAt, null)
})

test('o3d-550x: a posted document is recorded even when the row is no longer claimed at all', async () => {
  // The shape that catches ANY claim-shaped precondition, including `status: 'PROCESSING'`. It is also
  // the likelier one: this worker's claim aged out, a replacement took the row, FAILED, and released it
  // to PENDING — and only then did this worker's request come back carrying a real Xero invoice. If the
  // record were conditional on the claim, that invoice would exist in the ledger with nothing naming it.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PENDING',
    processingStartedAt: null,
    retryCount: 3,
    externalTransactionId: null,
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true, 'the fact that a document exists does not depend on holding a claim')
  assert.equal(state.externalTransactionId, 'INV-XERO-1')
  assert.equal(state.status, 'SYNCED')
})

test('o3d-550x: recording a posted document REFUSES to overwrite a different one, and names both', async () => {
  // A newer claim posted its own invoice while this attempt was on the wire. Both exist in Xero.
  // Overwriting would destroy the only local record of the one already on the row.
  const { tx, state, mirrorWrites } = makeRowStore({
    id: 'log-1',
    status: 'SYNCED',
    processingStartedAt: null,
    externalTransactionId: 'INV-XERO-FIRST',
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-SECOND', payload: {} })

  assert.equal(record.recorded, false)
  assert.equal(record.recorded === false && record.reason, 'ANOTHER_DOCUMENT_NAMED')
  assert.equal(
    record.recorded === false && record.reason === 'ANOTHER_DOCUMENT_NAMED' && record.namedExternalId,
    'INV-XERO-FIRST',
    'the caller is told WHICH document the row keeps, so it can escalate with both ids',
  )
  assert.equal(state.externalTransactionId, 'INV-XERO-FIRST', 'the first document is still the one IMS names')
  assert.deepEqual(mirrorWrites, [], 'and no POSTED mirror event is written for a record that did not land')
})

test('o3d-550x: re-recording the SAME document is idempotent, not a refusal', async () => {
  // The crash-after-post replay: the row already carries this exact id (the runner\'s
  // `entry.externalTransactionId` branch). Refusing here would strand a recoverable row forever.
  const { tx, state } = makeRowStore({
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    externalTransactionId: 'INV-XERO-1',
  })

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })

  assert.equal(record.recorded, true)
  assert.equal(state.status, 'SYNCED')
  assert.equal(state.externalTransactionId, 'INV-XERO-1')
})

test('o3d-550x: a vanished row is reported as ROW_MISSING, not as a silent success', async () => {
  const accountingSyncLog = {
    updateMany: async () => ({ count: 0 }),
    findUnique: async () => null,
  }
  const tx = new Proxy({ accountingSyncLog }, {
    get(_t, prop: string) {
      if (prop === 'accountingSyncLog') return accountingSyncLog
      return new Proxy({}, { get: () => async () => undefined })
    },
  }) as never

  const record = await recordPostedSyncResult(tx, { entry: ENTRY, externalId: 'INV-XERO-1', payload: {} })
  assert.equal(record.recorded, false)
  assert.equal(record.recorded === false && record.reason, 'ROW_MISSING')
})

test('o3d-550x: neither runner releases a claim with an unfenced write', () => {
  // Structural, and paired with the behavioural tests above: the fence is only worth anything if EVERY
  // release carries it. `update({ where: { id } })` cannot express "only while I still hold it" —
  // Prisma's unique-where update takes no extra predicate — so a release must go through updateMany.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const direct = src.slice(
    src.indexOf('async function processPendingXeroSyncDirect('),
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
  )
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )
  for (const [name, block] of [['direct', direct], ['outbox', outbox]] as const) {
    assert.ok(block.length > 0, `the ${name} runner block must be found`)
    for (const [index, chunk] of block.split('accountingSyncLog.update(').slice(1).entries()) {
      const data = chunk.slice(0, chunk.indexOf('})'))
      assert.ok(
        !data.includes("status: 'PENDING'"),
        `the ${name} runner must not hand a claimed row back to PENDING with an unfenced update (site ${index + 1})`,
      )
    }
    assert.ok(
      block.includes('heldClaimWhere(entry.id, claimedAt)'),
      `the ${name} runner must release the claim it holds under its own fence`,
    )
    assert.ok(
      block.includes('recordPostedSyncResult(tx, {'),
      `the ${name} runner must record a posted document through the unfenced evidence write`,
    )
    assert.ok(
      !block.includes("status: 'SYNCED'"),
      `the ${name} runner must not write SYNCED inline — that is how an unfenced clobber gets back in`,
    )
  }
})
