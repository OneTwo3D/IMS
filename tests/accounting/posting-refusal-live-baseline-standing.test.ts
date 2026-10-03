import assert from 'node:assert/strict'
import test from 'node:test'

import { ledgerStanding, type LedgerStanding } from '@/lib/domain/accounting/ledger-standing'
import { readEveryPostingRowForKey, readLiveQueuedPostings } from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-1e7sl (G6, slice 1c of o3d-f709) - THE INBOX'S "LIVE" BASELINE IS DECIDED BY STANDING, NOT BY `status != CANCELLED`.
 *
 * `readLiveQueuedPostings` answers "which postings are queued or posted for this key right now?" - the set a
 * refusal compares its baseline against to tell a NEW enqueue from an old one. It used to ask the database
 * `status: { not: 'CANCELLED' }`; it now reads every row and keeps the ones that can still post or hold the work
 * slot (`accountingSyncRowCanPostOrHasPosted`, postable-sync-statuses.ts). The EVERY read (the baseline itself)
 * is unchanged: a retired row is part of a baseline because it can be put back in front of the connector.
 *
 * One row per standing, the standing asserted first; the decision is which of the two reads names the row.
 */
type Row = {
  id: string; payload: unknown; status: string; settlementBasis: string | null
  externalTransactionId: string | null; abandonedBeforeRemoteCall: boolean | null
}

const KEY = { type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-1', scope: '' }

function clientOver(rows: Row[]) {
  const seen: Array<Record<string, unknown>> = []
  return {
    seen,
    client: {
      accountingSyncLog: {
        findMany: async (args: { where: Record<string, unknown>; select: Record<string, true> }) => {
          seen.push(args.select)
          // The double ignores `where` apart from the key: the subject is what the code does with the ROWS.
          assert.equal(args.where.type, KEY.type)
          assert.equal(args.where.referenceId, KEY.referenceId)
          assert.equal('status' in args.where, false, 'the read no longer excludes CANCELLED in the database')
          return rows
        },
      },
    },
  }
}

const CASES: Array<{ name: string; standing: LedgerStanding; row: Partial<Row>; live: boolean }> = [
  { name: 'CONFIRMED_POSTED (SYNCED, connector id)', standing: 'CONFIRMED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'D-1' }, live: true },
  { name: 'ASSERTED_POSTED (SYNCED, typed id)', standing: 'ASSERTED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'D-2', settlementBasis: 'OPERATOR_ASSERTION' }, live: true },
  { name: 'LIVE_WORK (PENDING)', standing: 'LIVE_WORK', row: { status: 'PENDING' }, live: true },
  { name: 'LIVE_WORK (PROCESSING)', standing: 'LIVE_WORK', row: { status: 'PROCESSING' }, live: true },
  { name: 'UNKNOWN (FAILED can still be retried)', standing: 'UNKNOWN', row: { status: 'FAILED' }, live: true },
  { name: 'ASSERTED_NOT_POSTED (retired)', standing: 'ASSERTED_NOT_POSTED', row: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }, live: false },
  { name: 'PROVEN_NOT_POSTED (retired, pre-call proof)', standing: 'PROVEN_NOT_POSTED', row: { status: 'CANCELLED', abandonedBeforeRemoteCall: true }, live: false },
  { name: 'UNKNOWN (retired, no proof)', standing: 'UNKNOWN', row: { status: 'CANCELLED' }, live: false },
]

test('[o3d-1e7sl G6] the live baseline names a row iff it can still post or holds the slot - one row per standing; the every-read names all of them', async () => {
  let live = 0
  for (const [i, c] of CASES.entries()) {
    const row: Row = { id: `row-${i}`, payload: {}, status: 'PENDING', settlementBasis: null, externalTransactionId: null, abandonedBeforeRemoteCall: null, ...c.row }
    const standing = ledgerStanding(row)
    console.log(`# G6 precondition: ${c.name}: standing ${standing}`)
    assert.equal(standing, c.standing, `fixture is not the standing it names: ${c.name}`)
    const { client } = clientOver([row])
    const liveIds = await readLiveQueuedPostings(client as never, KEY)
    const everyIds = await readEveryPostingRowForKey(client as never, KEY)
    assert.deepEqual(liveIds, c.live ? [row.id] : [], c.name)
    assert.deepEqual(everyIds, [row.id], `${c.name}: a baseline always knows every row`)
    if (c.live) live += 1
  }
  console.log(`# G6 cases: ${CASES.length}; live ${live}; retired ${CASES.length - live}`)
  assert.ok(live > 0 && live < CASES.length)
})

test('[o3d-1e7sl G6] the read SELECTS the standing columns - a double that omits them cannot make a retired row look live', async () => {
  const { seen, client } = clientOver([])
  await readLiveQueuedPostings(client as never, KEY)
  assert.deepEqual(
    Object.keys(seen[0]!).sort(),
    ['abandonedBeforeRemoteCall', 'externalTransactionId', 'id', 'payload', 'settlementBasis', 'status'],
  )
})
