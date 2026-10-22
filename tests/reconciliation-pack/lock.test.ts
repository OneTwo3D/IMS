import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { PACK_LOCK_FILE, PACK_RECLAIM_FILE, PACK_REPORT_JSON, PACK_SEQUENCE_CLAIM_PREFIX, packExitCode } from '../../lib/reconciliation-pack/constants.ts'
import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import { acquireRunLock, parseStartTime, type HolderState, type LockHooks } from '../../lib/reconciliation-pack/lock.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { NOW, at, cleanup, scratchDir } from './helpers.ts'

const bases: string[] = []
after(() => cleanup(bases))
const fresh = () => path.join(scratchDir(bases), 'reports')
const lockDir = () => { const dir = fresh(); mkdirSync(dir, { mode: 0o700 }); return dir }

const BOOT = 'a'.repeat(32)
const ME = { startTime: '5000', bootId: BOOT }
const as = (state: HolderState): LockHooks => ({ hostname: () => 'h', selfIdentity: () => ME, holderState: () => state })
const day = 24 * 3600_000

test('lock: a holder that is provably dead (no process) is reclaimed; the old holder can no longer commit or release', () => {
  const dir = lockDir()
  const old = acquireRunLock(dir, { ...as('dead'), pid: () => 424242 })
  const taken = acquireRunLock(dir, as('dead'))
  assert.equal(old.ok && taken.ok, true)
  if (old.ok && taken.ok) {
    assert.equal(old.handle.verify(), false)
    assert.equal(taken.handle.verify(), true)
    old.handle.release()
    assert.equal(taken.handle.verify(), true, 'the old holder\'s release did not remove the new lock')
  }
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), false)
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.run.lock.stale')), [])
})

test('lock: a LIVE holder is never displaced, however old its lock (the fork the age rule allowed)', () => {
  const dir = lockDir()
  assert.equal(acquireRunLock(dir, { ...as({ live: ME }), now: () => NOW.getTime() }).ok, true)
  for (const days of [0, 1, 30, 3650]) {
    assert.deepEqual(acquireRunLock(dir, { ...as({ live: ME }), now: () => NOW.getTime() + days * day }), { ok: false, code: 'LOCK_HELD' }, `${days} days`)
  }
})

test('lock: a reused pid (different start time) or a reboot (different boot id) means the holder is dead', () => {
  const a = lockDir()
  assert.equal(acquireRunLock(a, as({ live: ME })).ok, true)
  assert.equal(acquireRunLock(a, as({ live: { ...ME, startTime: '5001' } })).ok, true, 'same pid, new process')
  const b = lockDir()
  assert.equal(acquireRunLock(b, as({ live: ME })).ok, true)
  assert.equal(acquireRunLock(b, as({ live: { ...ME, bootId: 'b'.repeat(32) } })).ok, true, 'same pid after a reboot')
  const c = lockDir()
  assert.equal(acquireRunLock(c, as({ live: ME })).ok, true)
  assert.deepEqual(acquireRunLock(c, as({ live: { ...ME } })), { ok: false, code: 'LOCK_HELD' }, 'identical identity is the same process')
})

test('lock: a lock from ANOTHER host is never reclaimed, whatever the holder state', () => {
  const dir = lockDir()
  assert.equal(acquireRunLock(dir, { ...as('dead'), hostname: () => 'host-a' }).ok, true)
  assert.deepEqual(acquireRunLock(dir, { ...as('dead'), hostname: () => 'host-b', now: () => NOW.getTime() + 3650 * day }), { ok: false, code: 'LOCK_HELD' })
})

test('lock: where death cannot be proven nothing is reclaimed (an operator decides)', () => {
  const unprovableHolder = lockDir()
  assert.equal(acquireRunLock(unprovableHolder, as('dead')).ok, true)
  assert.deepEqual(acquireRunLock(unprovableHolder, as('unprovable')), { ok: false, code: 'LOCK_UNPROVABLE' })
  // a lock written by a process that could not establish its own identity can never be proven stale
  const noIdentity = lockDir()
  assert.equal(acquireRunLock(noIdentity, { ...as('dead'), selfIdentity: () => null }).ok, true)
  assert.deepEqual(acquireRunLock(noIdentity, as('dead')), { ok: false, code: 'LOCK_UNPROVABLE' })
})

test('lock: an unreadable, malformed, old-format, oversized or symlinked lock is not taken (fail closed)', () => {
  const good = { pid: 5, host: 'h', token: 'a'.repeat(32), createdAt: NOW.toISOString(), startTime: '1', bootId: BOOT }
  const bodies = ['', 'not json', '{}', JSON.stringify({ ...good, pid: 'x' }), JSON.stringify({ ...good, token: 'short' }), JSON.stringify({ ...good, createdAt: 'yesterday' }), JSON.stringify({ ...good, extra: 1 }), JSON.stringify({ ...good, startTime: 12 }), JSON.stringify({ ...good, bootId: 'NOT HEX' }), JSON.stringify({ pid: 5, host: 'h', token: 'a'.repeat(32), createdAt: NOW.toISOString() }), 'x'.repeat(5000)]
  for (const body of bodies) {
    const dir = lockDir()
    writeFileSync(path.join(dir, PACK_LOCK_FILE), body, { mode: 0o600 })
    assert.deepEqual(acquireRunLock(dir, as('dead')), { ok: false, code: 'LOCK_UNREADABLE' }, body.slice(0, 30))
  }
  const dir = lockDir()
  writeFileSync(path.join(dir, 'target'), '{}', { mode: 0o600 })
  symlinkSync(path.join(dir, 'target'), path.join(dir, PACK_LOCK_FILE))
  assert.deepEqual(acquireRunLock(dir), { ok: false, code: 'LOCK_UNREADABLE' })
  // and the well-formed one, for contrast, is judged on its holder
  const ok = lockDir()
  writeFileSync(path.join(ok, PACK_LOCK_FILE), JSON.stringify(good), { mode: 0o600 })
  assert.equal(acquireRunLock(ok, as('dead')).ok, true)
})

test('lock: reclaims are serialised by a guard file; a guard left behind refuses until removed', () => {
  const dir = lockDir()
  assert.equal(acquireRunLock(dir, as('dead')).ok, true)
  writeFileSync(path.join(dir, PACK_RECLAIM_FILE), '{}', { mode: 0o600 })
  assert.deepEqual(acquireRunLock(dir, as('dead')), { ok: false, code: 'LOCK_STALE_CONTENDED' })
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), true, 'a guard that is not ours is not removed')
  unlinkSync(path.join(dir, PACK_RECLAIM_FILE))
  assert.equal(acquireRunLock(dir, as('dead')).ok, true)
})

test('lock TOCTOU: a stale lock replaced between judgement and reclaim is not stolen', () => {
  const dir = lockDir()
  const lockFile = path.join(dir, PACK_LOCK_FILE)
  assert.equal(acquireRunLock(dir, { ...as('dead'), pid: () => 77 }).ok, true)
  const live = JSON.stringify({ pid: 88, host: 'h', token: 'b'.repeat(32), createdAt: NOW.toISOString(), startTime: '9', bootId: BOOT })
  const result = acquireRunLock(dir, { ...as('dead'), afterJudged: () => { unlinkSync(lockFile); writeFileSync(lockFile, live, { flag: 'wx', mode: 0o600 }) } })
  assert.deepEqual(result, { ok: false, code: 'LOCK_HELD' })
  assert.equal(readFileSync(lockFile, 'utf8'), live, 'the live lock is untouched')
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), false)
})

test('the start time is read from /proc/<pid>/stat after the LAST closing parenthesis', () => {
  const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), '987654']
  assert.equal(parseStartTime(`123 (we ird) (name) ${fields.join(' ')} 0 0`), '987654')
  assert.equal(parseStartTime('no parenthesis'), null)
  assert.equal(parseStartTime('1 (x) S 1 2'), null)
})

// ---- real processes ---------------------------------------------------------------------------------

const linux = existsSync('/proc/self/stat') && existsSync('/proc/sys/kernel/random/boot_id')
const tsx = (script: string, ...args: string[]) => spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'tests/reconciliation-pack', script), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
const firstLine = (proc: ChildProcessWithoutNullStreams) => new Promise<string>((resolve) => { let out = ''; proc.stdout.on('data', (d) => { out += String(d); if (out.includes('\n')) resolve(out.trim().split('\n')[0]!) }); proc.on('close', () => resolve(out.trim().split('\n')[0] ?? '')) })
const closed = (proc: ChildProcessWithoutNullStreams) => new Promise<number>((resolve) => { if (proc.exitCode !== null) resolve(proc.exitCode); else proc.on('close', (code) => resolve(code ?? -1)) })

test('REAL PROCESSES: a holder that exited without releasing is reclaimed; a live one is not, however old the lock is made to look', { skip: !linux }, async () => {
  const dead = lockDir()
  const diedProc = tsx('lock-child.ts', dead, 'die')
  assert.equal(await firstLine(diedProc), 'locked')
  await closed(diedProc)
  assert.equal(existsSync(path.join(dead, PACK_LOCK_FILE)), true, 'the dead holder left its lock behind')
  assert.equal(acquireRunLock(dead).ok, true, 'a dead holder is reclaimed with the real /proc')

  const live = lockDir()
  const holder = tsx('lock-child.ts', live, 'hold')
  assert.equal(await firstLine(holder), 'locked')
  assert.deepEqual(acquireRunLock(live), { ok: false, code: 'LOCK_HELD' })
  assert.deepEqual(acquireRunLock(live, { now: () => Date.now() + 3650 * day }), { ok: false, code: 'LOCK_HELD' }, 'ten years later the live holder is still not displaced')
  holder.stdin.end()
  await closed(holder)
  assert.equal(acquireRunLock(live).ok, true, 'once the holder is gone it is reclaimed')
})

test('REAL PROCESSES: a publisher paused before its commit is not displaced, and its report is the only commit for its sequence', { skip: !linux }, async () => {
  const dir = fresh()
  const go = path.join(scratchDir(bases), 'go')
  const child = tsx('pause-child.ts', dir, go)
  assert.equal(await firstLine(child), 'paused')
  const old = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(1), hooks: { lock: { now: () => Date.now() + 3650 * day } } })
  assert.deepEqual([old.ok, old.ok ? 0 : old.exitCode, old.ok ? '' : old.code], [false, packExitCode('refused'), 'LOCK_HELD'])
  writeFileSync(go, 'go')
  assert.equal(await closed(child), 0)
  const chain = readPackChain(dir)
  assert.equal(chain.ok && chain.reports.length, 1)
  assert.equal(publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(2) }).ok, true)
  const after2 = readPackChain(dir)
  assert.deepEqual(after2.ok && after2.reports.map((r) => r.sequence), [1, 2])
})

// ---- the commit itself, against a displaced holder -------------------------------------------------

const claimName = (n: number) => `${PACK_SEQUENCE_CLAIM_PREFIX}${String(n).padStart(9, '0')}`
const runDirs = (dir: string) => readdirSync(dir).filter((n) => /^\d{8}T/.test(n))

test('COMMIT SAFETY: a sequence already claimed by another committer cannot be committed again, even by the lock\'s holder', () => {
  const dir = fresh()
  const result = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(0), hooks: { beforeCommit: () => writeFileSync(path.join(dir, claimName(1)), 'someone else\n', { flag: 'wx', mode: 0o600 }) } })
  assert.deepEqual([result.ok, result.ok ? 0 : result.exitCode, result.ok ? '' : result.code], [false, packExitCode('report-not-published'), 'SEQUENCE_CLAIMED'])
  assert.deepEqual(runDirs(dir), [], 'no run directory and no JSON')
  assert.equal(readFileSync(path.join(dir, claimName(1)), 'utf8'), 'someone else\n', 'the other claim is not removed')
  const next = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(1) })
  assert.deepEqual([next.ok, next.ok ? 0 : next.exitCode, next.ok ? '' : next.code], [false, packExitCode('refused'), 'SEQUENCE_CLAIMED'], 'refused up front until an operator looks')
})

test('COMMIT SAFETY: the JSON is linked into place and never overwrites a file that is already there', () => {
  const dir = fresh()
  const result = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(0), hooks: { beforeCommit: () => { writeFileSync(path.join(dir, runDirs(dir)[0]!, PACK_REPORT_JSON), 'planted\n', { flag: 'wx', mode: 0o600 }) } } })
  assert.deepEqual([result.ok, result.ok ? '' : result.code], [false, 'WRITE_FAILED'])
  assert.equal(existsSync(path.join(dir, claimName(1))), false, 'a failed commit releases its own claim')
  assert.equal(publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(1) }).ok, true)
})

test('COMMIT SAFETY: a committed sequence keeps its claim for good; a read-back failure releases it', () => {
  const dir = fresh()
  const first = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(0) })
  assert.equal(first.ok, true)
  assert.equal(existsSync(path.join(dir, claimName(1))), true)
  const failed = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(1), hooks: { afterCommit: () => unlinkSync(path.join(dir, runDirs(dir).find((n) => !readdirSync(dir).includes('x') && existsSync(path.join(dir, n, PACK_REPORT_JSON)) && n !== (first.ok ? first.record.runId : ''))!, 'evidence.jsonl')) } })
  assert.equal(failed.ok, false)
  assert.equal(existsSync(path.join(dir, claimName(2))), false)
  const again = publishSyntheticRun({ reportDir: dir, phase: 'P1', asOf: '2026-10-19', now: at(2) })
  assert.equal(again.ok && again.record.sequence, 2)
  void linkSync
})
