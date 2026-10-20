/**
 * THE RUN LOCK: one run at a time may assign a sequence number and publish.
 *
 * `<report-dir>/.run.lock` is created exclusively (O_EXCL, O_NOFOLLOW, mode 0600) holding the pid, the host name,
 * a random token and the creation time. It is taken BEFORE the chain is read, and held until the JSON is
 * committed, so two runs cannot both claim the next sequence number. The holder re-checks it (`verify`) just
 * before the commit rename: a lock that is no longer ours means the run is not published.
 *
 * STALE RULE (decided once, here). A lock is reclaimed ONLY when its holder is PROVABLY DEAD, and age never decides:
 *   - the lock records the holder's pid, host, the process start time (field 22 of /proc/<pid>/stat) and the boot id;
 *   - a lock from another host is held (never reclaimed);
 *   - on this host the holder's /proc entry is read now: absent => dead; present with a different start time or boot
 *     id => the pid was reused or the machine rebooted => the holder is dead; present with the SAME start time and
 *     boot id => the holder is alive and is NEVER displaced, however old the lock (the waiter is refused);
 *   - where that cannot be established (no /proc, an unreadable entry, a lock written without an identity, an
 *     unreadable or malformed lock) the lock is not reclaimed and the run is refused with a recovery code that tells an
 *     operator to check and remove the lock by hand (LOCK_UNPROVABLE / LOCK_UNREADABLE).
 * A live holder that is merely slow therefore blocks the next run; it cannot be forked past. Separately the publisher
 * claims the sequence number with an exclusive file at commit (publish.ts), so even a holder displaced by a bug cannot
 * place a second commit record for a sequence that is already claimed.
 *
 * RECLAIM RACE. Reclaiming is itself a check-then-act, so it is serialised by a second exclusive file
 * (`.run.lock.reclaim`): only its holder may remove a stale lock, and it renames the stale lock aside and checks
 * the inode of what it moved against the inode it judged. If it moved something else (the owner released and a new
 * run took the name in between) it links that lock back and refuses. A reclaimer that crashes leaves the guard
 * behind and the next run refuses (LOCK_STALE_CONTENDED) until an operator removes it: fail closed. NOT closed: if
 * the new run's lock is moved aside and another run takes the name before the link-back, that new run loses its lock;
 * its own `verify` before commit then fails and it publishes nothing.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, fstatSync, readFileSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PACK_LOCK_FILE, PACK_RECLAIM_FILE } from '@/lib/reconciliation-pack/constants'
import { isStreamStamp } from '@/lib/reconciliation-pack/compare'

export type LockRefusal = 'LOCK_HELD' | 'LOCK_UNREADABLE' | 'LOCK_UNPROVABLE' | 'LOCK_STALE_CONTENDED' | 'LOCK_ERROR'

/** What identifies one incarnation of a process: pid alone is reused. */
export type ProcIdentity = { startTime: string; bootId: string }
export type HolderState = 'dead' | 'unprovable' | { live: ProcIdentity }
export type LockHooks = {
  now?: () => number
  hostname?: () => string
  pid?: () => number
  /** This process's own identity, written into the lock. null = it cannot be established (the lock is then unreclaimable). */
  selfIdentity?: () => ProcIdentity | null
  /** What the holder's pid is now. */
  holderState?: (pid: number) => HolderState
  /** Test seam: runs after a lock is judged stale and before it is reclaimed (the window a second run could use). */
  afterJudged?: () => void
}
export type LockHandle = { path: string; token: string; verify: () => boolean; release: () => void }
export type LockResult = { ok: true; handle: LockHandle } | { ok: false; code: LockRefusal }

type LockContent = { pid: number; host: string; token: string; createdAt: string; startTime: string | null; bootId: string | null }
const MAX_LOCK_BYTES = 2048
/** A host name is a DNS-style name: labels of letters, digits and hyphens joined by dots. Nothing else is ever written to, or accepted from, a lock. */
export const HOST_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*)?$/
const OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW

function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8') } catch { return null }
}
function bootId(): string | null {
  const text = readText('/proc/sys/kernel/random/boot_id')?.trim()
  return text && /^[0-9a-f-]{16,64}$/.test(text) ? text : null
}
/** Field 22 (starttime) of /proc/<pid>/stat. The command name may contain spaces and parentheses, so parse after the LAST ')'. */
export function parseStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(' ')
  const value = fields[19]
  return value !== undefined && /^[0-9]+$/.test(value) ? value : null
}
function identityOf(pid: number): ProcIdentity | null {
  const stat = readText(`/proc/${pid}/stat`)
  const boot = bootId()
  const start = stat === null ? null : parseStartTime(stat)
  return start !== null && boot !== null ? { startTime: start, bootId: boot } : null
}
function defaultHolderState(pid: number): HolderState {
  if (bootId() === null || readText('/proc/self/stat') === null) return 'unprovable'
  const stat = readText(`/proc/${pid}/stat`)
  if (stat === null) return existsSync(`/proc/${pid}`) ? 'unprovable' : 'dead'
  const identity = identityOf(pid)
  return identity === null ? 'unprovable' : { live: identity }
}

function readLockFile(file: string): { text: string; ino: number } | 'gone' | null {
  let fd: number
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK) } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_LOCK_BYTES) return null
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < info.size) {
      const n = readSync(fd, buffer, read, info.size - read, read)
      if (n === 0) break
      read += n
    }
    return { text: buffer.subarray(0, read).toString('utf8'), ino: info.ino }
  } finally {
    closeSync(fd)
  }
}

function parseLock(text: string): LockContent | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return null
    const keys = Object.keys(raw).sort().join(',')
    if (keys !== 'bootId,createdAt,host,pid,startTime,token') return null
    if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid < 1) return null
    if (typeof raw.host !== 'string' || raw.host.length > 253 || !HOST_NAME_RE.test(raw.host)) return null
    if (typeof raw.token !== 'string' || !/^[0-9a-f]{32}$/.test(raw.token)) return null
    if (!isStreamStamp(raw.createdAt)) return null
    for (const field of [raw.startTime, raw.bootId]) if (field !== null && (typeof field !== 'string' || !/^[0-9a-f-]{1,64}$/.test(field))) return null
    return { pid: raw.pid, host: raw.host, token: raw.token, createdAt: raw.createdAt, startTime: raw.startTime as string | null, bootId: raw.bootId as string | null }
  } catch { return null }
}

/**
 * Create `file` with its complete content or not at all. The bytes are written and fsynced under a temporary name
 * and then hard-linked to the final name, which fails if anything (a symlink included) is already there; a waiter
 * therefore never reads a half-written lock and mistakes it for garbage.
 */
function createExclusive(file: string, text: string): number {
  const temporary = `${file}.tmp.${randomBytes(6).toString('hex')}`
  const fd = openSync(temporary, OPEN_FLAGS, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
    const ino = fstatSync(fd).ino
    linkSync(temporary, file)
    return ino
  } finally {
    closeSync(fd)
    try { unlinkSync(temporary) } catch { /* already gone */ }
  }
}

function handleFor(lockPath: string, content: LockContent, ino: number): LockHandle {
  const verify = () => {
    try {
      if (lstatSync(lockPath).ino !== ino) return false
      const current = readLockFile(lockPath)
      return current !== null && current !== 'gone' && current.ino === ino && parseLock(current.text)?.token === content.token
    } catch { return false }
  }
  return {
    path: lockPath,
    token: content.token,
    verify,
    release: () => { if (verify()) { try { unlinkSync(lockPath) } catch { /* already gone */ } } },
  }
}

export function acquireRunLock(dir: string, hooks: LockHooks = {}): LockResult {
  const now = hooks.now ?? Date.now
  const host = (hooks.hostname ?? os.hostname)()
  const pid = (hooks.pid ?? (() => process.pid))()
  const stateOf = hooks.holderState ?? defaultHolderState
  const self = (hooks.selfIdentity ?? (() => identityOf(pid)))()
  const lockPath = path.join(dir, PACK_LOCK_FILE)
  if (!HOST_NAME_RE.test(host) || host.length > 253) return { ok: false, code: 'LOCK_ERROR' }
  const content: LockContent = { pid, host, token: randomBytes(16).toString('hex'), createdAt: new Date(now()).toISOString(), startTime: self?.startTime ?? null, bootId: self?.bootId ?? null }
  const text = JSON.stringify(content)
  let existing: { text: string; ino: number } | null = null
  // The holder may release between our failed create and our read; that is a free lock, so try again (bounded).
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= 20) return { ok: false, code: 'LOCK_HELD' }
    try {
      return { ok: true, handle: handleFor(lockPath, content, createExclusive(lockPath, text)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, code: 'LOCK_ERROR' }
    }
    const read = readLockFile(lockPath)
    if (read === 'gone') continue
    if (read === null) return { ok: false, code: 'LOCK_UNREADABLE' }
    existing = read
    break
  }
  const held = parseLock(existing.text)
  if (held === null) return { ok: false, code: 'LOCK_UNREADABLE' }
  if (held.host !== host) return { ok: false, code: 'LOCK_HELD' }
  if (held.startTime === null || held.bootId === null) return { ok: false, code: 'LOCK_UNPROVABLE' }
  const state = stateOf(held.pid)
  if (state === 'unprovable') return { ok: false, code: 'LOCK_UNPROVABLE' }
  const dead = state === 'dead' || state.live.startTime !== held.startTime || state.live.bootId !== held.bootId
  if (!dead) return { ok: false, code: 'LOCK_HELD' }

  hooks.afterJudged?.()
  const guardPath = path.join(dir, PACK_RECLAIM_FILE)
  try { createExclusive(guardPath, JSON.stringify({ pid, host })) } catch { return { ok: false, code: 'LOCK_STALE_CONTENDED' } }
  try {
    const again = readLockFile(lockPath)
    if (again === null || again === 'gone' || again.text !== existing.text || again.ino !== existing.ino) return { ok: false, code: 'LOCK_HELD' }
    const aside = path.join(dir, `.run.lock.stale.${randomBytes(6).toString('hex')}`)
    renameSync(lockPath, aside)
    const moved = lstatSync(aside)
    if (moved.ino !== existing.ino) {
      // We moved a lock that is not the one we judged. Put it back if the name is still free, and refuse.
      try { linkSync(aside, lockPath) } catch { /* someone took the name: their verify decides */ }
      unlinkSync(aside)
      return { ok: false, code: 'LOCK_HELD' }
    }
    unlinkSync(aside)
    try {
      return { ok: true, handle: handleFor(lockPath, content, createExclusive(lockPath, text)) }
    } catch {
      return { ok: false, code: 'LOCK_HELD' }
    }
  } catch {
    return { ok: false, code: 'LOCK_ERROR' }
  } finally {
    try { unlinkSync(guardPath) } catch { /* nothing to remove */ }
  }
}
