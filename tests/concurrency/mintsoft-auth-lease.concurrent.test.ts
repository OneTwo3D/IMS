import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The Mintsoft auth lease (o3d-092 / o3d-8u7) serializes `POST /api/Auth`
 * against auth-mode transitions.
 *
 * Why it has to be proven under real concurrency: `/api/Auth` does not issue a
 * session token, it MINTS A NEW TENANT API KEY and invalidates the previous
 * one. Three systems share that key, so a login that overlaps a switch to
 * fixed-key mode invalidates the key the switch just verified — and no local
 * check can undo it, because the rotation happens at Mintsoft the instant the
 * request lands. The lease is the only thing standing between those two, and a
 * lease that looks right in unit tests but is not actually mutually exclusive
 * across processes would be worse than none: it would look safe.
 *
 * These run against a real Postgres because the mutual exclusion IS the
 * database write — a mocked db proves nothing here. Gated behind
 * RUN_DB_CONCURRENCY_TESTS=1.
 *
 * Imports are RELATIVE, not via the `@/` alias: `node --test` runs these
 * outside Next's resolver, where the alias does not resolve (the pre-existing
 * payment-write-lock test hits the same wall). The unit tests in tests/ use
 * relative paths for the same reason.
 */

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

const LOCK_KEY = 'mintsoft_auth_lock'

async function clearLease() {
  const { db } = await import('../../lib/db/index.ts')
  await db.setting.deleteMany({ where: { key: LOCK_KEY } })
}

test('auth lease: mutually exclusive under concurrency', { skip }, async () => {
  loadEnv()
  await clearLease()
  const { withMintsoftAuthLock } = await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  let concurrent = 0
  let maxConcurrent = 0
  const hold = (label: string) =>
    withMintsoftAuthLock(label, async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // Long enough that the two genuinely overlap if the lease is broken.
      await new Promise((r) => setTimeout(r, 400))
      concurrent--
      return label
    })

  const results = await Promise.all([hold('a'), hold('b'), hold('c')])

  assert.deepEqual(results.sort(), ['a', 'b', 'c'], 'every caller must eventually run')
  assert.equal(maxConcurrent, 1, 'the lease must never let two holders overlap')
  await clearLease()
})

test('auth lease: released cleanly when the body throws', { skip }, async () => {
  loadEnv()
  await clearLease()
  const { withMintsoftAuthLock } = await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  await assert.rejects(
    withMintsoftAuthLock('boom', async () => { throw new Error('boom') }),
    /boom/,
  )

  // A leaked lease would wedge every future login and every mode switch, so
  // this must not depend on the happy path.
  let ran = false
  await withMintsoftAuthLock('after', async () => { ran = true })
  assert.ok(ran, 'the lease must be released even when the body throws')
  await clearLease()
})

test('auth lease: a stale lease is reclaimed, not deadlocked', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { withMintsoftAuthLock } = await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  // Simulate a holder that died without releasing: an already-expired lease.
  await db.setting.deleteMany({ where: { key: LOCK_KEY } })
  await db.setting.create({
    data: { key: LOCK_KEY, value: `${new Date(Date.now() - 60_000).toISOString()}|dead-holder` },
  })

  let ran = false
  await withMintsoftAuthLock('reclaim', async () => { ran = true }, { waitMs: 5_000 })
  assert.ok(ran, 'an expired lease must be reclaimable — a crashed process must not wedge auth')
  await clearLease()
})

test('auth lease: a live lease is NOT stolen', { skip }, async () => {
  loadEnv()
  await clearLease()
  const { withMintsoftAuthLock, MintsoftAuthLockTimeout } =
    await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  let holderStarted: () => void = () => {}
  const started = new Promise<void>((r) => { holderStarted = r })

  const holder = withMintsoftAuthLock('holder', async () => {
    holderStarted()
    await new Promise((r) => setTimeout(r, 3_000))
    return 'held'
  })

  await started
  // A second caller with a short wait must TIME OUT rather than barge in.
  await assert.rejects(
    withMintsoftAuthLock('impatient', async () => 'stolen', { waitMs: 800 }),
    (e: unknown) => e instanceof MintsoftAuthLockTimeout,
    'a live lease must not be stealable',
  )

  assert.equal(await holder, 'held')
  await clearLease()
})

test('auth lease: assertHeld fences a holder whose lease was taken', { skip }, async () => {
  loadEnv()
  await clearLease()
  const { db } = await import('../../lib/db/index.ts')
  const { withMintsoftAuthLock, MintsoftAuthLockTimeout } =
    await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  // The fence is what stops a holder that lost its lease from going ahead with
  // the irreversible act anyway. Simulate the loss by overwriting the row with
  // somebody else's token mid-body.
  await assert.rejects(
    withMintsoftAuthLock('fenced', async ({ assertHeld }) => {
      await db.setting.updateMany({
        where: { key: LOCK_KEY },
        data: { value: `${new Date(Date.now() + 60_000).toISOString()}|other-holder` },
      })
      await assertHeld()          // must refuse to continue
      return 'proceeded anyway'
    }),
    (e: unknown) => e instanceof MintsoftAuthLockTimeout,
    'assertHeld must refuse once the lease belongs to someone else',
  )
  await clearLease()
})

test('auth lease: releasing does not clobber a newer holder', { skip }, async () => {
  loadEnv()
  await clearLease()
  const { db } = await import('../../lib/db/index.ts')
  const { withMintsoftAuthLock } = await import('../../lib/connectors/mintsoft/api/auth-lock.ts')

  // A holder whose lease expired and was taken by someone else must not delete
  // the NEW owner's lease on its way out — that would hand the lease to a third
  // caller while the second is still working.
  await withMintsoftAuthLock('loser', async () => {
    await db.setting.updateMany({
      where: { key: LOCK_KEY },
      data: { value: `${new Date(Date.now() + 60_000).toISOString()}|new-owner` },
    })
  }).catch(() => { /* body may or may not throw; the release is what we assert */ })

  const row = await db.setting.findUnique({ where: { key: LOCK_KEY } })
  assert.ok(row?.value.endsWith('|new-owner'), 'release must be owner-scoped')
  await clearLease()
})
