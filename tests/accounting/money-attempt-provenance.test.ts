import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MONEY_ATTEMPT_STAMPING_SINCE_KEY,
  STAMPED_MONEY_TYPES,
  moneyAttemptStampingSinceOrNull,
  resolveMoneyAttemptStampingSince,
  type StampingEpochStore,
} from '@/lib/domain/accounting/money-attempt-provenance'
import { MONEY_MOVING_SYNC_TYPES } from '@/lib/domain/accounting/followup-retry-guard'

/**
 * o3d-0m56 round 9 (Codex HIGH) — "unstamped" has to mean "no call ever left this row" ACROSS A
 * DEPLOYMENT, and the migration's backfill cannot make it mean that.
 *
 * `scripts/deploy.sh` runs `prisma migrate deploy`, then BUILDS, then swaps the process. The
 * backfill commits at step one and the stamping binary arrives minutes later, so everything the
 * OLD binary posts in between lands unstamped on the far side of the backfill — indistinguishable,
 * to the round-8 recycle rule and to `authoriseMoneyPost`'s rival query, from a row nothing was
 * ever sent from.
 *
 * The epoch closes it: the first stamping process to need the premise re-runs the backfill over
 * everything that already exists and records WHEN it did, once per database. Afterwards the money
 * rows are exactly two populations — stamped, or created by a binary that stamps.
 */

const EPOCH = new Date('2026-08-18T12:00:00Z')

/** A store that records what was asked of it, so ordering and write-avoidance can be asserted. */
function storeDouble(existing: Date | null, options: { establishedBy?: Date } = {}) {
  const calls: string[] = []
  let stored = existing
  const store: StampingEpochStore = {
    read: async () => {
      calls.push('read')
      return stored
    },
    establish: async (epoch) => {
      calls.push(`establish:${epoch.toISOString()}`)
      // A lost race: another process recorded its own epoch first, and THAT is what is now true
      // of the rows.
      stored = options.establishedBy ?? epoch
      return stored
    },
  }
  return { store, calls, current: () => stored }
}

test('an epoch already recorded is used as it stands, and nothing is re-stamped (o3d-0m56 r9)', async () => {
  // The backfill must not run again on every process start: it would stamp rows the RUNNING binary
  // has queued but not yet posted, which costs a ledger read on each of them for ever.
  const { store, calls } = storeDouble(EPOCH)

  assert.deepEqual(await resolveMoneyAttemptStampingSince(store), EPOCH)
  assert.deepEqual(calls, ['read'], 'a recorded epoch must not be re-established')
})

test('a database that has never stamped establishes the epoch once (o3d-0m56 r9)', async () => {
  const { store, calls, current } = storeDouble(null)
  const now = new Date('2026-08-18T13:30:00Z')

  assert.deepEqual(await resolveMoneyAttemptStampingSince(store, () => now), now)
  assert.deepEqual(calls, ['read', `establish:${now.toISOString()}`])
  assert.deepEqual(current(), now)
})

test('losing the race returns the WINNER\'s epoch, not our own (o3d-0m56 r9)', async () => {
  // Two processes can both find no epoch. The loser's transaction rolls back, so the rows were
  // backfilled against the WINNER's instant — reporting our own would trust rows created between
  // the two, which the winner's backfill has already judged untrustworthy.
  const winner = new Date('2026-08-18T11:00:00Z')
  const { store } = storeDouble(null, { establishedBy: winner })

  assert.deepEqual(await resolveMoneyAttemptStampingSince(store, () => new Date('2026-08-18T13:00:00Z')), winner)
})

test('an epoch that cannot be established reads as UNKNOWN, never as an instant (o3d-0m56 r9)', async () => {
  // The follow-up enqueue runs after its invoice has already posted, so it must not throw — but it
  // must not invent a value either. `planFollowUpEnqueue` treats null as "nothing is proof" and
  // recycles nothing, which costs one extra sync row and never a duplicate payment.
  const store: StampingEpochStore = {
    read: async () => { throw new Error('database unreachable') },
    establish: async () => { throw new Error('database unreachable') },
  }

  assert.equal(await moneyAttemptStampingSinceOrNull(store), null)
})

test('the backfilled types are exactly the ones the fence stamps (o3d-0m56 r9)', async () => {
  // A money type in the fence but not in this list is a type the epoch never repairs: its
  // deploy-window rows stay unstamped for ever and stay invisible to both readers.
  assert.deepEqual([...STAMPED_MONEY_TYPES].sort(), [...MONEY_MOVING_SYNC_TYPES].sort())
})

test('the epoch is recorded BEFORE the rows are stamped, in one transaction (o3d-0m56 r9)', async () => {
  // Ordering is what makes a lost race safe: the unique key on `settings.key` rejects the second
  // writer while the transaction is still empty of row writes, so it rolls back having changed
  // nothing. Stamping first would leave the loser's backfill applied under the winner's epoch.
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/money-attempt-provenance.ts'),
    'utf8',
  )
  const tx = source.indexOf('db.$transaction(')
  assert.notEqual(tx, -1, 'the record and the backfill must share a transaction')

  const create = source.indexOf('tx.setting.create(', tx)
  const update = source.indexOf('UPDATE "accounting_sync_logs"', tx)
  assert.ok(create !== -1 && update !== -1, 'both writes must be inside it')
  assert.ok(create < update, 'the epoch must be claimed before any row is stamped')

  const backfill = source.slice(update, source.indexOf('`', update))
  assert.match(backfill, /"remoteAttemptedAt" IS NULL/,
    'only unstamped rows may be touched — a stamp already claimed by a real call must never move')
  assert.match(backfill, /"createdAt" < \$\{epoch\}/,
    'and only rows OLDER than the epoch, or it would stamp what this binary is about to post')
  assert.match(backfill, /COALESCE\("syncedAt", "processingStartedAt", "createdAt"\)/,
    'the value is the row\'s own lower bound, never now(), exactly as the migration\'s backfill')
})

test('the settings key an operator has to know is the one the module writes (o3d-0m56 r9)', () => {
  // The documented recovery for an overlapping deploy is to DELETE this key so the epoch
  // re-establishes. A key that drifts from the documentation makes that recovery a no-op.
  assert.equal(MONEY_ATTEMPT_STAMPING_SINCE_KEY, 'accounting.money-attempt-stamping-since')
})

test('the deploy order the epoch depends on is written where a deployer will see it (o3d-0m56 r9)', async () => {
  // The epoch is only true if no binary that does NOT stamp is running when it is recorded. That
  // is a property of how this is deployed, so it is part of the fix — and a fix that lives only in
  // a source comment is one the person doing the deploy never reads.
  for (const file of ['scripts/deploy.sh', 'docs/installation.md', 'CLAUDE.md']) {
    const text = await readFile(path.join(process.cwd(), file), 'utf8')
    assert.match(text, /money-attempt-stamping-since/,
      `${file} must name the setting an operator may have to clear`)
    assert.match(text, /stopped before|never run two|no overlap/i,
      `${file} must state that the old process is stopped before the new one starts`)
  }
})
