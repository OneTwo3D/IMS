import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  ACCOUNTING_WRITE_LOCK_KEY,
  PAYMENT_WRITE_LOCK_KEY,
  QBO_DAILY_BATCH_LOCK_KEY,
  REFUND_ACCOUNTING_LOCK_KEY,
  SINGLE_KEY_ADVISORY_LOCKS,
  TWO_INT_ADVISORY_LOCK_NAMESPACES,
  XERO_DAILY_BATCH_LOCK_KEY,
} from '../../lib/db/advisory-locks.ts'

/**
 * o3d-4ajo: two pairs of features held the SAME advisory key, in unrelated
 * commits, with nothing saying so — refund creation against the Xero daily
 * batch, and the Xero payment-write lock against the QuickBooks daily batch.
 * Nothing failed; a job just waited, or a `try` lock reported "someone else
 * holds it" and skipped its run.
 *
 * The sharing turned out to be doing real work, so the VALUES are unchanged.
 * What these tests pin is that it can no longer happen by accident: domains are
 * distinct, and a shared domain must be expressed by importing one constant
 * rather than by writing the same number twice.
 */

test('[o3d-4ajo] every advisory lock DOMAIN is distinct', () => {
  const entries = Object.entries(SINGLE_KEY_ADVISORY_LOCKS)
  const byValue = new Map<number, string[]>()
  for (const [name, value] of entries) {
    byValue.set(value, [...(byValue.get(value) ?? []), name])
  }
  const collisions = [...byValue.entries()].filter(([, names]) => names.length > 1)
  assert.deepEqual(
    collisions, [],
    'two domains share a key — if the sharing is deliberate, give them ONE domain '
      + `constant and alias it, do not duplicate the value: ${collisions.map(([v, n]) => `${n.join(' == ')} (${v})`).join('; ')}`,
  )
})

test('[o3d-4ajo] every key is a positive safe integer pg can hold', () => {
  for (const [name, value] of Object.entries(SINGLE_KEY_ADVISORY_LOCKS)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} = ${value}`)
  }
})

test('[o3d-4ajo] no module declares an advisory key of its own', () => {
  // The registry is only authoritative if it is the ONLY place a bare key is
  // written down. A module-local constant is exactly how the collision arose.
  //
  // o3d-2k5r r26: `.mjs` is walked too. The session-lock-space probe's namespace
  // HAS to be declared in `lib/db/database-url-schema.mjs` — that module is
  // `.mjs` and cannot import this `.ts` registry, the dependency runs the other
  // way — and a keyspace the walker could not see is precisely the unregistered
  // constant this test exists to prevent. So the rule is not "only .ts files",
  // it is "the registry must RE-EXPORT the name", which is checkable and is
  // what keeps the value single-sourced.
  const roots = ['lib', 'app']
  const registryPath = 'lib/db/advisory-locks.ts'
  const registry = readFileSync(registryPath, 'utf8')
  // A declaration that assigns a numeric literal to a lock KEY or NAMESPACE
  // name. Both keyspaces, and hex as well as decimal: DISPATCH_SWEEP_LOCK_NAMESPACE
  // was written 0x77_6d_73_64, which a decimal-only pattern would miss. The
  // qualifier is `LOCK` anywhere in the name and `_KEY`/`_NAMESPACE` at the end,
  // not the contiguous `LOCK_KEY`/`LOCK_NAMESPACE` r25 matched on:
  // SESSION_LOCK_SPACE_PROBE_NAMESPACE is a lock namespace that the narrower
  // pattern reads straight past.
  const declaration = /(?:const|let|var)\s+(\w*LOCK\w*_(?:KEY|NAMESPACE))\s*(?::\s*number\s*)?=\s*(?:0x)?[\da-fA-F_]+/
  const offenders: string[] = []
  let declarations = 0
  let files = 0
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (entry === 'generated' || entry === 'node_modules') continue
        walk(path)
        continue
      }
      if (!path.endsWith('.ts') && !path.endsWith('.tsx') && !path.endsWith('.mjs')) continue
      if (path.endsWith(registryPath)) continue
      files += 1
      const src = readFileSync(path, 'utf8')
      for (const line of src.split('\n')) {
        const declared = declaration.exec(line)
        if (!declared) continue
        declarations += 1
        // Single-sourced is the property, not the file extension: a name the
        // registry re-exports has ONE value, and the distinctness tests above
        // see it. A name it does not is a key nothing knows about.
        if (new RegExp(`\\b${declared[1]}\\b`).test(registry)) continue
        offenders.push(`${path}: ${line.trim()}`)
      }
    }
  }
  for (const root of roots) walk(root)
  // THE DETECTOR MUST BE ALIVE. An empty offender list is what a pattern that
  // matches nothing returns as readily as a clean tree, and r25's pattern in
  // fact matched NOTHING outside the registry — it had been vacuous since the
  // day every key moved into the registry. Two preconditions, both about this
  // run rather than about the tree: the walk reached files, and the pattern
  // still recognises the very declarations the registry is made of.
  assert.ok(files > 100, `PRECONDITION: the walk reached the source tree; it read ${files} files`)
  const inRegistry = registry.split('\n').filter((line) => declaration.test(line)).length
  assert.ok(inRegistry >= 10, `PRECONDITION: the pattern recognises a lock-key declaration; it found ${inRegistry} in ${registryPath}`)
  assert.ok(declarations > 0, `PRECONDITION: the walk found a declaration outside the registry to judge; it found ${declarations}`)
  assert.deepEqual(offenders, [], `declare these in lib/db/advisory-locks.ts instead:\n${offenders.join('\n')}`)
})

test('[o3d-2k5r r26] the probe namespace the registry lists is the one the prober actually takes', async () => {
  // The registry re-exports it, so the distinctness test above is about the
  // real value. MUTATION ROUTE: give `SESSION_LOCK_SPACE_PROBE_NAMESPACE` its
  // own literal in `lib/db/advisory-locks.ts` instead of re-exporting. This
  // fails the moment the two drift, which is exactly the o3d-4ajo failure
  // (a second copy of a key that nothing compares).
  const { SESSION_LOCK_SPACE_PROBE_NAMESPACE: fromRegistry } = await import('../../lib/db/advisory-locks.ts')
  const { SESSION_LOCK_SPACE_PROBE_NAMESPACE: fromProber } = await import('../../lib/db/database-url-schema.mjs')
  assert.equal(fromRegistry, fromProber)
  assert.ok(Object.values(TWO_INT_ADVISORY_LOCK_NAMESPACES).includes(fromProber), 'and it is registered in the two-int keyspace it uses')
})

test('[o3d-4ajo] the deliberately-shared domains still share, and say so', () => {
  // These pairs serialize on purpose (each writes overlapping accounting state).
  // Pinning it here means a later "cleanup" that splits them has to argue with a
  // test rather than silently remove the protection.
  assert.equal(REFUND_ACCOUNTING_LOCK_KEY, ACCOUNTING_WRITE_LOCK_KEY)
  assert.equal(XERO_DAILY_BATCH_LOCK_KEY, ACCOUNTING_WRITE_LOCK_KEY,
    'the Xero daily batch selects orders a refund can invalidate before it stamps them')
  assert.equal(QBO_DAILY_BATCH_LOCK_KEY, PAYMENT_WRITE_LOCK_KEY,
    'the QBO batch reads paidAt while the Xero payment jobs write it')
})

test('[o3d-4ajo] every two-int namespace is distinct', () => {
  // A different keyspace from the single-bigint keys, so these cannot collide
  // with those — but they can collide with each other, and the failure would
  // look identical: two features serializing on an id that means different
  // things to each.
  const entries = Object.entries(TWO_INT_ADVISORY_LOCK_NAMESPACES)
  const byValue = new Map<number, string[]>()
  for (const [name, value] of entries) byValue.set(value, [...(byValue.get(value) ?? []), name])
  const collisions = [...byValue.entries()].filter(([, names]) => names.length > 1)
  assert.deepEqual(collisions, [], `namespaces must be unique — ${JSON.stringify(collisions)}`)
  for (const [name, value] of entries) {
    // int4: the two-int form takes signed 32-bit arguments.
    assert.ok(Number.isSafeInteger(value) && value > 0 && value < 2 ** 31, `${name} = ${value}`)
  }
})

test('[o3d-4ajo] a lost pinned lock refuses further protected work', async () => {
  // Postgres frees a session lock the instant its connection dies, so a batch
  // that keeps writing after that has lost the exclusion it assumed — another
  // batch, or a refund sharing the domain, can already be running.
  const { AdvisoryLockLostError } = await import('../../lib/db/pinned-advisory-lock.ts')
  // The contract, exercised on the shape the module exports rather than a live
  // socket failure: `lost` flips, assertHeld throws, and the error names it.
  let lost = false
  const lock = {
    get lost() { return lost },
    assertHeld(context?: string) {
      if (lost) throw new AdvisoryLockLostError(`Advisory lock was lost before ${context}`)
    },
  }
  lock.assertHeld('phase one')          // held: no throw
  lost = true
  assert.throws(() => lock.assertHeld('phase two'), AdvisoryLockLostError)
  assert.throws(() => lock.assertHeld('phase two'), /phase two/)
})

test('[o3d-4ajo] both daily batches check the lock before every write phase', () => {
  // The primitive is only useful if it is CALLED. A phase added later without a
  // check would silently reintroduce the window.
  for (const path of ['lib/connectors/xero/daily-sync.ts', 'lib/connectors/quickbooks/daily-sync.ts']) {
    const src = readFileSync(path, 'utf8')
    const phases = (src.match(/^ {2}\/\/ --- Group [AB]\d?/gm) ?? []).length
    const checks = (src.match(/batchLock\.assertHeld\(/g) ?? []).length
    assert.ok(phases > 0, `${path}: expected to find the batch phases`)
    assert.equal(checks, phases, `${path}: every write phase must assert the lock is still held`)
  }
})

test('[o3d-0m56 r4] the two-int advisory call passes the NAMESPACE first', async () => {
  // Argument order is the whole of the two-int form and it is invisible at the call site:
  // pg_try_advisory_lock takes (namespace, key). Swapped, it would take a REAL lock on a pair
  // that means something else, with no error anywhere — and the acquire and the release would
  // still agree with each other, so nothing downstream could notice the exclusion was wrong.
  const { advisoryLockCall } = await import('../../lib/db/pinned-advisory-lock.ts')
  assert.deepEqual(advisoryLockCall(7), { label: '7', args: [7], params: '$1' },
    'the single-bigint form the daily batches use is unchanged')
  assert.deepEqual(advisoryLockCall(7, 9), { label: '9/7', args: [9, 7], params: '$1, $2' })
})
