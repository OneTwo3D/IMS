import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractPayloadNetMovement,
  isJournalPayloadSyncType,
  JOURNAL_PAYLOAD_SYNC_TYPES,
  journalNetMovement,
  journalNetsReadable,
  readAccountNets,
  summariseAccountNets,
} from '@/lib/domain/accounting/journal-account-nets'
import {
  proveAllocationDebitPosting,
  proveJournalPosting,
  type JournalProofRow,
} from '@/lib/domain/accounting/allocation-debit-posting-proof'

/**
 * COMPACTION KEEPS THE PER-ACCOUNT NET THE A2 POSTING PROOF NEEDS.
 *
 * A compacted journal row (payload dropped) used to be unprovable and the proof failed closed. It now
 * carries `payloadAccountNets`, and the proof reads it when the lines are gone. These tests pin that the
 * summary is the SAME NUMBER the payload would give, that a row without one still fails closed, and that
 * nothing about an unreadable row was loosened.
 */

// A small deterministic PRNG so a failure reproduces from its seed.
function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const CODES = ['631', '632', '200', '4000', '12345', 'ABC']
const PROBES = [...CODES, '999', '']

function randomAmount(rand: () => number): unknown {
  const kind = Math.floor(rand() * 8)
  // Pence-denominated values give the sums real floating-point error to carry.
  const value = Math.round(rand() * 1_000_000) / 100 + (rand() < 0.3 ? 0.1 : 0)
  if (kind === 0) return undefined
  if (kind === 1) return null
  if (kind === 2) return String(value)
  if (kind === 3) return { toString: () => String(value) } // a Decimal-like value at the boundary
  if (kind === 4) return 'not a number'
  return value
}

function randomJournal(rand: () => number) {
  const lineCount = Math.floor(rand() * 12)
  const lines = Array.from({ length: lineCount }, () => ({
    accountCode: rand() < 0.08 ? '' : CODES[Math.floor(rand() * CODES.length)],
    description: 'secret customer name',
    debit: randomAmount(rand),
    credit: randomAmount(rand),
  }))
  return { narration: 'x', lines }
}

test('PROPERTY: the summary equals extractPayloadNetMovement for every account and direction (through a JSON round trip)', () => {
  const rand = prng(20261117)
  for (let n = 0; n < 2000; n += 1) {
    const payload = randomJournal(rand)
    const summary = summariseAccountNets(payload)
    assert.ok(summary, `journal ${n} is legible, so it summarises`)
    // What the database hands back: the summary as JSON, parsed again.
    const stored = JSON.parse(JSON.stringify(summary))
    for (const code of PROBES) {
      for (const side of ['credit', 'debit'] as const) {
        const fromPayload = extractPayloadNetMovement(payload, code, side)
        const fromSummary = journalNetMovement({ payload: {}, payloadAccountNets: stored }, code, side)
        assert.ok(fromSummary !== null, 'a stored summary is readable')
        assert.ok(
          fromSummary === fromPayload,
          `journal ${n} account '${code}' ${side}: summary ${fromSummary} !== payload ${fromPayload}`,
        )
      }
    }
  }
})

test('the summary holds account codes and two totals each, and nothing else', () => {
  const summary = summariseAccountNets({
    lines: [
      { accountCode: '631', description: 'Jane Doe, 1 High St', debit: 20, credit: 0, reference: 'SO-1' },
      { accountCode: '631', debit: 0, credit: 5 },
      { accountCode: '200', debit: 0, credit: 15 },
    ],
  })
  assert.deepEqual(summary, {
    version: 1,
    accounts: { '631': { credit: -15, debit: 15 }, '200': { credit: 15, debit: -15 } },
  })
  assert.doesNotMatch(JSON.stringify(summary), /Jane|High St|SO-1/)
})

test('an unreadable payload has no summary (null), so the caller must not drop it', () => {
  for (const payload of [{}, null, undefined, 'x', 7, [], { lines: 'nope' }, { lines: {} }, { lines: [null] }, { lines: [1] }, { lines: [[]] }]) {
    assert.equal(summariseAccountNets(payload), null, `payload ${JSON.stringify(payload)}`)
  }
  assert.deepEqual(summariseAccountNets({ lines: [] }), { version: 1, accounts: {} }, 'a legible journal with no lines is a real, empty journal')
})

test('readAccountNets is strict: any damaged or foreign value is unreadable, never a smaller or a zero movement', () => {
  const good = { version: 1, accounts: { '631': { credit: 1, debit: 2 } } }
  assert.deepEqual(readAccountNets(good), good)
  const bad: unknown[] = [
    null, undefined, 'x', 3, [], {},
    { version: 2, accounts: {} },
    { version: 1 },
    { version: 1, accounts: [] },
    { version: 1, accounts: null },
    { version: 1, accounts: { '631': null } },
    { version: 1, accounts: { '631': { credit: 1 } } },
    { version: 1, accounts: { '631': { credit: '1', debit: 2 } } },
    { version: 1, accounts: { '631': { credit: Number.NaN, debit: 2 } } },
    { version: 1, accounts: { '631': { credit: 1, debit: Number.POSITIVE_INFINITY } } },
    { version: 1, accounts: { '': { credit: 1, debit: 2 } } },
  ]
  for (const value of bad) assert.equal(readAccountNets(value), null, JSON.stringify(value))
})

test('the payload stays the authority while it exists: a stale summary beside live lines is ignored', () => {
  const payload = { lines: [{ accountCode: '631', debit: 20, credit: 0 }] }
  const stale = { version: 1, accounts: { '631': { credit: 0, debit: 999 } } }
  assert.equal(journalNetMovement({ payload, payloadAccountNets: stale }, '631', 'debit'), 20)
})

test('no payload and no (or a malformed) summary: not readable', () => {
  assert.equal(journalNetsReadable({ payload: {} }), false)
  assert.equal(journalNetsReadable({ payload: {}, payloadAccountNets: null }), false)
  assert.equal(journalNetsReadable({ payload: {}, payloadAccountNets: { version: 9 } }), false)
  assert.equal(journalNetMovement({ payload: {}, payloadAccountNets: { version: 9 } }, '631', 'debit'), null)
  assert.equal(journalNetsReadable({ payload: {}, payloadAccountNets: { version: 1, accounts: {} } }), true)
})

test('journal types cover everything the refund relief arithmetic and the A2 proof read', () => {
  for (const type of ['DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B', 'ALLOCATION_REVERSAL', 'COGS_REVERSAL', 'UNEARNED_REV_REVERSAL']) {
    assert.ok(isJournalPayloadSyncType(type), type)
  }
  for (const type of ['SALES_INVOICE', 'PURCHASE_BILL', 'CREDIT_NOTE', 'INVOICE_PAYMENT']) {
    assert.equal(isJournalPayloadSyncType(type), false, `${type} is not a journal`)
  }
  assert.equal(new Set(JOURNAL_PAYLOAD_SYNC_TYPES).size, JOURNAL_PAYLOAD_SYNC_TYPES.length, 'no duplicates')
})

// ---------------------------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------------------------

const FULL = { lines: [
  { accountCode: '631', debit: 120.1, credit: 0 },
  { accountCode: '631', debit: 0, credit: 20.05 },
  { accountCode: '200', debit: 0, credit: 100.05 },
] }

function settledRow(over: Partial<JournalProofRow> = {}): JournalProofRow {
  return { status: 'SYNCED', externalTransactionId: 'JNL-1', abandonedBeforeRemoteCall: null, settlementBasis: null, payload: FULL, ...over }
}
function compacted(payload: unknown): JournalProofRow {
  return settledRow({ payload: {}, payloadAccountNets: JSON.parse(JSON.stringify(summariseAccountNets(payload))) })
}

test('a compacted row WITH a summary proves exactly the amount the uncompacted row proves, both directions', () => {
  for (const side of ['debit', 'credit'] as const) {
    for (const code of ['631', '200', '999']) {
      assert.deepEqual(
        proveJournalPosting([compacted(FULL)], code, side),
        proveJournalPosting([settledRow()], code, side),
        `${code} ${side}`,
      )
    }
  }
  assert.deepEqual(proveJournalPosting([compacted(FULL)], '631', 'debit'), { kind: 'proved', amount: 100.05 })
})

test('a compacted row WITHOUT a summary fails closed (illegible), exactly as before', () => {
  assert.deepEqual(proveJournalPosting([settledRow({ payload: {} })], '631', 'debit'), { kind: 'illegible' })
  assert.deepEqual(proveJournalPosting([settledRow({ payload: {}, payloadAccountNets: null })], '631', 'debit'), { kind: 'illegible' })
  assert.deepEqual(proveJournalPosting([settledRow({ payload: {}, payloadAccountNets: { version: 1 } })], '631', 'debit'), { kind: 'illegible' })
})

test('a summary does not lower the bar: an unsettled or asserted compacted row still proves nothing', () => {
  assert.equal(proveJournalPosting([{ ...compacted(FULL), status: 'PENDING' }], '631', 'debit').kind, 'unproved')
  assert.equal(proveJournalPosting([{ ...compacted(FULL), settlementBasis: 'OPERATOR_ASSERTION' }], '631', 'debit').kind, 'unproved')
})

test('one illegible row among compacted-with-summary rows still makes the set illegible', () => {
  assert.deepEqual(
    proveJournalPosting([compacted(FULL), settledRow({ payload: {} })], '631', 'debit'),
    { kind: 'illegible' },
  )
})

const PASS = { amount: 60, syncLogId: 'j-1', connector: 'xero', accountCode: '631', batchRef: 'A2-1', at: '2026-07-20T00:00:00.000Z' }
const ORDER = {
  inventoryAllocatedDate: new Date('2026-07-20T00:00:00.000Z'),
  allocationBatchAmount: 60,
  allocationBatchPasses: [PASS],
  allocationBatchSyncLogId: 'j-1',
  allocationBatchConnector: 'xero',
  allocationBatchAccountCode: '631',
}
async function a2(journal: JournalProofRow) {
  const client = { accountingSyncLog: { findUnique: async () => ({ connector: 'xero', ...journal }) } }
  return proveAllocationDebitPosting(client as never, ORDER, { activeConnector: 'xero' as const, allocatedInventoryAccount: '631' })
}

test('A2 proof: the compacted journal with a summary is `posted`, the same verdict as the full payload', async () => {
  const full = await a2(settledRow())
  const compactedVerdict = await a2(compacted(FULL))
  assert.equal(full.kind, 'posted')
  assert.deepEqual(compactedVerdict, full)
})

test('A2 proof: a compacted journal WITHOUT a summary is refused (lines no longer readable)', async () => {
  const verdict = await a2(settledRow({ payload: {} }))
  assert.equal(verdict.kind, 'refused')
  assert.match(verdict.kind === 'refused' ? verdict.reason : '', /no longer readable/)
})

test('A2 proof: the summary is checked, not trusted: a share larger than the summarised debit, a zero debit and a wrong account all refuse', async () => {
  const small = { lines: [{ accountCode: '631', debit: 10, credit: 0 }] }
  const tooSmall = await a2(compacted(small))
  assert.equal(tooSmall.kind, 'refused')
  assert.match(tooSmall.kind === 'refused' ? tooSmall.reason : '', /cannot exceed its batch/)

  const zero = await a2(compacted({ lines: [{ accountCode: '631', debit: 5, credit: 5 }] }))
  assert.equal(zero.kind, 'refused')
  assert.match(zero.kind === 'refused' ? zero.reason : '', /debit nothing/)

  const wrongAccount = await a2(compacted({ lines: [{ accountCode: '200', debit: 500, credit: 0 }] }))
  assert.equal(wrongAccount.kind, 'refused')
  assert.match(wrongAccount.kind === 'refused' ? wrongAccount.reason : '', /debit nothing/)
})
