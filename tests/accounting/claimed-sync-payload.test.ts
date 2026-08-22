import assert from 'node:assert/strict'
import test from 'node:test'

import { readClaimedSyncLogPayload } from '@/lib/domain/accounting/claimed-sync-payload'

/**
 * o3d-5ct, the processor half. Both connector processors listed claimable rows, then looped and
 * conditionally claimed each one — but bound `entry.payload` from the PRE-CLAIM snapshot and posted
 * from that. A corrective writer could therefore rewrite the row, see it still PENDING, and be
 * overtaken by a worker that had already taken the old payload into memory. The bad document reaches
 * the ledger and the corrected order says nothing is wrong.
 *
 * No predicate the writer adds closes that: a database cannot invalidate a value already read into
 * another process. It closes HERE, by making the claim the moment the payload is read — after the
 * claim the row's status forbids anyone else claiming it, so this read is the last word. The same
 * payload is what the processors mirror into the AccountingEvent, so it also stops the audit mirror
 * and the ledger being built from two different versions of the document.
 */

/** A double that resolves by id — a fixed return value could not tell a re-read from a snapshot. */
function makeClient(rows: Record<string, { payload: unknown; connectionProvenance?: string | null } | undefined>) {
  const reads: string[] = []
  const client = {
    accountingSyncLog: {
      findUnique: async (
        { where, select }: { where: { id: string }; select: { payload: true; connectionProvenance: true } },
      ) => {
        reads.push(where.id)
        // o3d-dzip: both halves of the origin record come out of THIS read. Selecting them separately
        // would let a caller hold a payload from one moment and a column from another, which is how a
        // disagreement — the state that must refuse — gets manufactured out of two honest reads.
        assert.deepEqual(select, { payload: true, connectionProvenance: true }, 'the payload and its durable origin, together')
        return rows[where.id] ?? null
      },
    },
  }
  return { client, reads }
}

test('the payload comes from the row, not from the caller\'s pre-claim snapshot (o3d-5ct)', async () => {
  // The stale snapshot says 10 (the duplicated coupon); the row now says 0 (corrected). Posting must
  // use 0.
  const { client, reads } = makeClient({ 'log-1': { payload: { discountAmount: 0, invoiceNumber: 'INV-1' } } })

  const payload = await readClaimedSyncLogPayload(client, 'log-1')

  assert.deepEqual(payload, { discountAmount: 0, invoiceNumber: 'INV-1' })
  assert.deepEqual(reads, ['log-1'], 'read by the claimed row\'s own id')
})

test('a different claimed row gets ITS own payload (o3d-5ct)', async () => {
  // Guards against a double — or an implementation — that returns the same thing regardless of input.
  const { client } = makeClient({
    'log-1': { payload: { discountAmount: 0 } },
    'log-2': { payload: { discountAmount: 6 } },
  })

  assert.deepEqual(await readClaimedSyncLogPayload(client, 'log-1'), { discountAmount: 0 })
  assert.deepEqual(await readClaimedSyncLogPayload(client, 'log-2'), { discountAmount: 6 })
})

test('a NULL payload reads as an empty object, not as null (o3d-5ct)', async () => {
  const { client } = makeClient({ 'log-1': { payload: null } })
  assert.deepEqual(await readClaimedSyncLogPayload(client, 'log-1'), {})
})

test('a non-object payload is not passed through as a document (o3d-5ct)', async () => {
  const { client } = makeClient({ 'log-1': { payload: ['not', 'a', 'document'] } })
  assert.deepEqual(await readClaimedSyncLogPayload(client, 'log-1'), {})
})

test('a row that vanished after the claim THROWS rather than posting the snapshot (o3d-5ct)', async () => {
  // Falling back to the pre-claim snapshot here would reintroduce exactly the behaviour being
  // removed. The processors' per-entry catch turns this into an ordinary retryable failure.
  const { client } = makeClient({})

  await assert.rejects(
    () => readClaimedSyncLogPayload(client, 'log-1'),
    /disappeared between the claim and the payload read/,
  )
})

// ---------------------------------------------------------------------------
// The processors actually use it
// ---------------------------------------------------------------------------

/**
 * Asserted against the source. Driving processPendingXeroSync / processPendingQuickBooksSync would
 * need the whole connector stack — settings, auth, HTTP, the outbox — and would end up testing those
 * mocks rather than the one line that matters: which variable the posted payload comes from.
 */
const PROCESSORS = [
  { path: 'lib/connectors/xero/sync-processor.ts', claimSites: 2 },
  { path: 'lib/connectors/quickbooks/sync-processor.ts', claimSites: 1 },
]

for (const processor of PROCESSORS) {
  test(`${processor.path} re-reads the payload after claiming, at every claim site (o3d-5ct)`, async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), processor.path), 'utf8')

    // o3d-dzip: the Xero processor reads the origin record (payload + durable column) in one call;
    // QuickBooks still reads the payload alone, because it has no connection guard to feed yet.
    const reReads = src.match(/await readClaimedSyncLog(Payload|OriginRecord)\(db, entry\.id\)/g) ?? []
    assert.equal(
      reReads.length,
      processor.claimSites,
      'every path that claims a sync row must re-read its payload before posting',
    )

    assert.doesNotMatch(
      src,
      /const payload = \(entry\.payload \?\? \{\}\) as SyncPayload/,
      'binding the PRE-CLAIM snapshot as the payload to post IS the o3d-5ct bug',
    )
    // `let payload = ...` is the SEED, and it is a different statement: it exists only so the failure
    // path can describe the row when the re-read itself throws, and every claim site overwrites it
    // from the re-read above before anything is posted. `const` is what makes it the posted value.
  })
}
