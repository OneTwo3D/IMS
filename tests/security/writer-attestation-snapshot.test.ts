import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

/**
 * THE ATTESTATION SNAPSHOT IS PROCESS-WIDE, NOT MODULE-LOCAL (review of #1051, HIGH).
 *
 * `next build` gives the instrumentation hook its own copy of a module, separate from the copy the application graph imports. A module-local variable is
 * then refreshed in one copy and read in another. These tests load the module TWICE (two distinct module instances, as two bundled chunks are) and prove
 * a refresh through one is seen through the other, and that a script context (no instrumentation, no background refresh) sees the confirmation too.
 */

type Snapshot = typeof import('../../lib/security/writer-attestation-snapshot.ts')
const MODULE_PATH = path.resolve(process.cwd(), 'lib/security/writer-attestation-snapshot.ts')
const requireFromHere = createRequire(path.join(process.cwd(), 'package.json'))

/**
 * A FRESH, SEPARATE INSTANCE of the module on every call, as a second bundled chunk is: the module is evicted from the require cache and loaded again, so each
 * result has its own module scope (and therefore its own module-level variables, which is exactly what the old implementation kept its snapshot in).
 */
const load = async (_tag: string): Promise<Snapshot> => {
  delete requireFromHere.cache[MODULE_PATH]
  return requireFromHere(MODULE_PATH) as Snapshot
}

const readerOf = (kinds: string[], opts: { fail?: boolean } = {}) => async () => ({
  writerAttestation: {
    findFirst: async ({ where }: { where: { kind: string } }) => {
      if (opts.fail) throw new Error('database unavailable')
      return kinds.includes(where.kind) ? { id: 'x' } : null
    },
  },
})

test('two module instances are really two instances (the premise of the test), yet share one process-wide state', async () => {
  const a = await load('a1')
  const b = await load('b1')
  assert.notEqual(a.ensureAttestationSnapshot, b.ensureAttestationSnapshot, 'distinct module instances')
  a.resetAttestationSnapshotForTests()
  assert.equal(b.attestationState('qoblex-xero-stopped'), 'unknown')
  await a.ensureAttestationSnapshot(readerOf(['qoblex-xero-stopped']))
  assert.equal(a.attestationState('qoblex-xero-stopped'), 'present')
  assert.equal(b.attestationState('qoblex-xero-stopped'), 'present', 'a refresh in one instance is seen by the other (the instrumentation copy and the application copy)')
  assert.equal(b.attestationInForce('qoblex-xero-stopped'), true)
  assert.equal(b.attestationState('qoblex-stock-push-stopped'), 'absent', 'a positive read that did not find it')
  a.resetAttestationSnapshotForTests()
})

test('a refresh through the instance the application graph does NOT import still reaches the one it does (instrumentation copy -> route copy)', async () => {
  const instrumentation = await load('instr')
  const application = await load('app')
  instrumentation.resetAttestationSnapshotForTests()
  instrumentation.startAttestationRefresh(async () => readerOf(['qoblex-stock-push-stopped'])() as never)
  for (let i = 0; i < 50 && application.attestationState('qoblex-stock-push-stopped') !== 'present'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(application.attestationState('qoblex-stock-push-stopped'), 'present')
  // The timer is registered once per PROCESS: a second copy starting it again does not start a second one.
  application.startAttestationRefresh(async () => readerOf([])() as never)
  instrumentation.resetAttestationSnapshotForTests()
})

test('a TSX SCRIPT context (no instrumentation hook, no background refresh) sees the confirmation after ensureAttestationSnapshot, through any module instance', async () => {
  const script = await load('script')
  const producer = await load('producer-in-script')
  script.resetAttestationSnapshotForTests()
  assert.equal(producer.attestationState('qoblex-xero-stopped'), 'unknown', 'before the script loads it, work is held, not shadowed')
  await script.ensureAttestationSnapshot(readerOf(['qoblex-xero-stopped']))
  assert.equal(producer.attestationState('qoblex-xero-stopped'), 'present')
  script.resetAttestationSnapshotForTests()
})

test('a read that fails leaves the state UNKNOWN (not absent, not present); a later success replaces it; a kind known present is never forgotten', async () => {
  const s = await load('failing')
  s.resetAttestationSnapshotForTests()
  await assert.rejects(s.ensureAttestationSnapshot(readerOf([], { fail: true })))
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'unknown')
  await s.ensureAttestationSnapshot(readerOf(['qoblex-xero-stopped']))
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'present')
  await s.refreshAttestationSnapshot((await readerOf([])()) as never) // a later read that misses it (a replica behind): append-only, so it stays known
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'present')
  s.resetAttestationSnapshotForTests()
})

test('a lookup that finds the state unknown starts the registered load itself (a route does not wait for the next background tick)', async () => {
  const s = await load('lazy')
  s.resetAttestationSnapshotForTests()
  // Register a source without loading (ensure with an already-failing first attempt registers it), then look up.
  await assert.rejects(s.ensureAttestationSnapshot(readerOf([], { fail: true })))
  s.resetAttestationSnapshotForTests()
  s.startAttestationRefresh(async () => readerOf(['qoblex-xero-stopped'])() as never)
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'unknown')
  for (let i = 0; i < 50 && s.attestationState('qoblex-xero-stopped') !== 'present'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'present')
  s.resetAttestationSnapshotForTests()
})

test('a slot holding something this module did not put there reads as unknown (fail closed toward holding), and is replaced, not trusted', async () => {
  const s = await load('foreign')
  s.resetAttestationSnapshotForTests()
  ;(globalThis as unknown as Record<symbol, unknown>)[s.ATTESTATION_SNAPSHOT_KEY] = { v: 2, kinds: new Set(['qoblex-xero-stopped']) }
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'unknown')
  ;(globalThis as unknown as Record<symbol, unknown>)[s.ATTESTATION_SNAPSHOT_KEY] = 'yes'
  assert.equal(s.attestationState('qoblex-xero-stopped'), 'unknown')
  s.resetAttestationSnapshotForTests()
})
