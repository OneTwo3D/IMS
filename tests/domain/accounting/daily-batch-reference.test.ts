import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dailyBatchLiveRefs,
  dailyBatchReferenceDate,
  dailyBatchStampKey,
  foldDailyBatchRow,
  parseDailyBatchReference,
  type DailyBatchRecreateBucket,
} from '@/lib/domain/accounting/daily-batch-reference'

// o3d-0qoo: a daily batch's identity is the referenceId it was staged under, NOT a key
// re-derived from the stage stamp. A run crossing UTC midnight stamps rows on the day
// after the batch's own date, so every consumer that re-derives looks for a batch that
// does not exist. These pin the parser's refusals, because the parsed date becomes a
// posted journal's date and a posted journal's identity.

test('parseDailyBatchReference accepts both shapes in the wild (o3d-0qoo)', () => {
  assert.deepEqual(parseDailyBatchReference('A2-2026-07-20-1a2b3c4d'), {
    group: 'A2',
    date: '2026-07-20',
    digest: '1a2b3c4d',
  })
  assert.deepEqual(parseDailyBatchReference('A1-2026-07-20'), {
    group: 'A1',
    date: '2026-07-20',
    digest: null,
  })
  assert.deepEqual(parseDailyBatchReference('B-2026-07-20-00000000'), {
    group: 'B',
    date: '2026-07-20',
    digest: '00000000',
  })
})

test('parseDailyBatchReference REFUSES anything off-shape rather than slicing (o3d-0qoo)', () => {
  // Each of these would yield a plausible-looking substring under a naive slice(3, 13).
  for (const bad of [
    null,
    undefined,
    '',
    'A2-2026-07-20-',            // trailing separator, no digest
    'A2-2026-07-20-1a2b3c4',     // 7 hex — not the digest shape
    'A2-2026-07-20-1a2b3c4d5',   // 9 hex
    'A2-2026-07-20-1A2B3C4D',    // uppercase digest is not what we write
    'A2-2026-07-20-1a2b3c4d-x',  // trailing junk
    'A2-2026-7-20',              // unpadded
    'A2-26-07-20',               // short year
    'A3-2026-07-20',             // unknown group
    'INVRECON-2026-07-20',       // a reconciliation reference, not a group batch
    'A2 2026-07-20',
    ' A2-2026-07-20',
    'A2-2026-02-30',             // impossible calendar date
    'A2-2026-13-01',             // impossible month
  ]) {
    assert.equal(parseDailyBatchReference(bad), null, `expected refusal for ${String(bad)}`)
    assert.equal(dailyBatchReferenceDate(bad), null, `expected null date for ${String(bad)}`)
  }
})

test('parseDailyBatchReference refuses a reference from another group (o3d-0qoo)', () => {
  assert.equal(parseDailyBatchReference('B-2026-07-20-1a2b3c4d', 'A2'), null)
  assert.ok(parseDailyBatchReference('A2-2026-07-20-1a2b3c4d', 'A2'))
  assert.equal(dailyBatchReferenceDate('A1-2026-07-20', 'A2'), null)
})

test('dailyBatchStampKey mirrors the legacy derive-from-stamp key (o3d-0qoo)', () => {
  assert.equal(dailyBatchStampKey(new Date('2026-07-21T00:04:11.000Z')), '2026-07-21')
  assert.equal(dailyBatchStampKey(null), null)
  assert.equal(dailyBatchStampKey(new Date('nope')), null)
})

test('foldDailyBatchRow buckets a midnight-crossing row by its BATCH, not its stamp (o3d-0qoo)', () => {
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  const summary = foldDailyBatchRow(
    buckets,
    'A2',
    { stagedAt: new Date('2026-07-21T00:04:11.000Z'), persistedRef: 'A2-2026-07-20-1a2b3c4d' },
    () => ({ n: 0 }),
  )
  assert.ok(summary)
  summary.n += 1

  const bucket = buckets.get('A2-2026-07-20-1a2b3c4d')
  assert.ok(bucket, 'bucketed under the persisted reference')
  assert.equal(bucket.referenceId, 'A2-2026-07-20-1a2b3c4d', 'recreates under the SAME identity')
  assert.equal(bucket.date, '2026-07-20', 'journal date is the batch date, not the stamp date')
  assert.equal(bucket.identity, 'persisted')
  assert.deepEqual(dailyBatchLiveRefs(bucket), {
    exact: ['A2-2026-07-20-1a2b3c4d'],
    derived: [],
  }, 'a KNOWN identity probes itself and nothing else — the derived key names a different batch')
})

test('foldDailyBatchRow keeps legacy (unpersisted) rows on the derived key (o3d-0qoo)', () => {
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  foldDailyBatchRow(
    buckets,
    'A1',
    { stagedAt: new Date('2026-07-21T00:04:11.000Z'), persistedRef: null },
    () => ({ n: 0 }),
  )

  const bucket = buckets.get('A1-2026-07-21')
  assert.ok(bucket, 'pre-migration rows behave exactly as before')
  assert.equal(bucket.referenceId, 'A1-2026-07-21')
  assert.equal(bucket.date, '2026-07-21')
  assert.equal(bucket.identity, 'derived')
  assert.deepEqual(dailyBatchLiveRefs(bucket), { exact: [], derived: ['A1-2026-07-21'] })
})

test('foldDailyBatchRow falls back for an UNPARSEABLE ref but still widens the probe (o3d-0qoo)', () => {
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  foldDailyBatchRow(
    buckets,
    'A1',
    { stagedAt: new Date('2026-07-21T00:04:11.000Z'), persistedRef: 'garbage' },
    () => ({ n: 0 }),
  )

  const bucket = buckets.get('A1-2026-07-21')
  assert.ok(bucket, 'a ref we cannot understand must not become a journal date')
  assert.equal(bucket.date, '2026-07-21')
  assert.equal(bucket.identity, 'derived', 'a ref we cannot parse is not an identity we know')
  assert.deepEqual(dailyBatchLiveRefs(bucket), {
    exact: ['garbage'],
    derived: ['A1-2026-07-21'],
  }, 'still probed for, because over-matching only costs a skipped recreate')
})

test('foldDailyBatchRow merges rows of one batch and separates split batches (o3d-0qoo)', () => {
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  const rows = [
    // Same batch, two rows, stamped either side of midnight.
    { stagedAt: new Date('2026-07-20T23:59:50.000Z'), persistedRef: 'B-2026-07-20-aaaaaaaa' },
    { stagedAt: new Date('2026-07-21T00:00:10.000Z'), persistedRef: 'B-2026-07-20-aaaaaaaa' },
    // A DIFFERENT batch for the same date (a split run) — its own identity.
    { stagedAt: new Date('2026-07-20T23:00:00.000Z'), persistedRef: 'B-2026-07-20-bbbbbbbb' },
  ]
  for (const row of rows) {
    const summary = foldDailyBatchRow(buckets, 'B', row, () => ({ n: 0 }))
    assert.ok(summary)
    summary.n += 1
  }

  assert.deepEqual([...buckets.keys()], ['B-2026-07-20-aaaaaaaa', 'B-2026-07-20-bbbbbbbb'])
  const first = buckets.get('B-2026-07-20-aaaaaaaa')!
  const second = buckets.get('B-2026-07-20-bbbbbbbb')!
  assert.equal(first.summary.n, 2, 'both rows of the batch land in one journal')
  assert.equal(first.date, '2026-07-20')

  // What actually protects the split is that neither half's probe can see the other's
  // log. Both halves share the derived key `B-2026-07-20` (and on Xero the probe widens
  // that to the `B-2026-07-20-` prefix, which matches BOTH digests), so as long as the
  // derived key is in either probe a live aaaaaaaa suppresses a missing bbbbbbbb.
  const firstRefs = dailyBatchLiveRefs(first)
  const secondRefs = dailyBatchLiveRefs(second)
  assert.deepEqual(firstRefs, { exact: ['B-2026-07-20-aaaaaaaa'], derived: [] })
  assert.deepEqual(secondRefs, { exact: ['B-2026-07-20-bbbbbbbb'], derived: [] })
  const allFirst = [...firstRefs.exact, ...firstRefs.derived]
  const allSecond = [...secondRefs.exact, ...secondRefs.derived]
  assert.deepEqual(
    allFirst.filter((ref) => allSecond.includes(ref)),
    [],
    'no probe candidate is shared, so neither split can vouch for the other',
  )
  // Stronger than set-disjointness, because the Xero probe also matches `<derived>-`
  // as a PREFIX: no candidate of one split may prefix-match the other split's identity.
  for (const candidate of allFirst) {
    assert.ok(
      !second.referenceId.startsWith(`${candidate}-`),
      `${candidate} would prefix-match ${second.referenceId} and silently suppress its recreate`,
    )
  }
  for (const candidate of allSecond) {
    assert.ok(
      !first.referenceId.startsWith(`${candidate}-`),
      `${candidate} would prefix-match ${first.referenceId} and silently suppress its recreate`,
    )
  }
})

test('dailyBatchLiveRefs drops the derived probe for a PERSISTED identity only (o3d-0qoo r1)', () => {
  // The whole asymmetry in one place. A persisted reference IS the id the log was created
  // under, so an exact match already sees every log the batch could have; adding the
  // derived key can only pull in ANOTHER batch's log and suppress a real recreate. A
  // derived identity has no such guarantee, so it keeps the wide probe — over-matching
  // there costs a skipped recreate, under-matching costs a double-posted journal.
  assert.deepEqual(
    dailyBatchLiveRefs({
      identity: 'persisted',
      exactRefs: new Set(['A1-2026-07-20-aaaaaaaa']),
      derivedRefs: new Set(['A1-2026-07-20', 'A1-2026-07-21']),
    }),
    { exact: ['A1-2026-07-20-aaaaaaaa'], derived: [] },
  )
  assert.deepEqual(
    dailyBatchLiveRefs({
      identity: 'derived',
      exactRefs: new Set(),
      derivedRefs: new Set(['A1-2026-07-20', 'A1-2026-07-21']),
    }),
    { exact: [], derived: ['A1-2026-07-20', 'A1-2026-07-21'] },
    'the scjz.37 derived/digest-prefix double-post guard must survive for unknown identities',
  )
  assert.deepEqual(
    dailyBatchLiveRefs({
      identity: 'derived',
      exactRefs: new Set(['INVRECON-2026-07-20']),
      derivedRefs: new Set(['A1-2026-07-20']),
    }),
    { exact: ['INVRECON-2026-07-20'], derived: ['A1-2026-07-20'] },
    'an unparseable persisted ref only ever WIDENS a derived bucket',
  )
})

test('foldDailyBatchRow gives two same-date split batches non-overlapping probes (o3d-0qoo r1)', () => {
  // Two batches, same group, same date, same stamp day — they differ only by digest.
  // Before the identity split, both probed the shared derived key `A1-2026-07-20`, so a
  // live aaaaaaaa log made the MISSING bbbbbbbb look live and its value was never rebuilt.
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  const stagedAt = new Date('2026-07-20T18:00:00.000Z')
  for (const persistedRef of ['A1-2026-07-20-aaaaaaaa', 'A1-2026-07-20-bbbbbbbb']) {
    foldDailyBatchRow(buckets, 'A1', { stagedAt, persistedRef }, () => ({ n: 0 }))
  }

  assert.equal(buckets.size, 2, 'a split is two batches, not one')
  for (const bucket of buckets.values()) {
    assert.equal(bucket.identity, 'persisted')
    assert.deepEqual(dailyBatchLiveRefs(bucket), { exact: [bucket.referenceId], derived: [] })
    assert.ok(
      !dailyBatchLiveRefs(bucket).derived.includes('A1-2026-07-20'),
      'the shared derived key is exactly what let one split vouch for the other',
    )
  }
})

test('foldDailyBatchRow skips a row with no usable stage stamp (o3d-0qoo)', () => {
  const buckets = new Map<string, DailyBatchRecreateBucket<{ n: number }>>()
  assert.equal(
    foldDailyBatchRow(buckets, 'A1', { stagedAt: null, persistedRef: 'A1-2026-07-20' }, () => ({ n: 0 })),
    null,
  )
  assert.equal(buckets.size, 0)
})
