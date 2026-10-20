/**
 * THE RUN LOCK: one run at a time may assign a sequence number and publish.
 *
 * `<report-dir>/.run.lock` is created exclusively (O_EXCL, O_NOFOLLOW, mode 0600) holding the pid, the host name,
 * a random token and the creation time. It is taken BEFORE the chain is read, and held until the JSON is
 * committed, so two runs cannot both claim the next sequence number. The holder re-checks it (`verify`) just
 * before the commit rename: a lock that is no longer ours means the run is not published.
 *
 * STALE RULE (decided once, here). Only a lock on THIS host can be stale: when its pid no longer exists, or when
 * it is older than LOCK_STALE_MS (pid reuse). A lock from another host, an unreadable lock, a malformed lock and
 * a lock whose pid is alive and young are all "held": the run is refused, never the lock taken.
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
import { closeSync, constants as fsConstants, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LOCK_STALE_MS, PACK_LOCK_FILE, PACK_RECLAIM_FILE } from '@/lib/reconciliation-pack/constants'
import { isStreamStamp } from '@/lib/reconciliation-pack/compare'

export type LockRefusal = 'LOCK_HELD' | 'LOCK_UNREADABLE' | 'LOCK_STALE_CONTENDED' | 'LOCK_ERROR'
export type LockHooks = {
  now?: () => number
  hostname?: () => string
  pid?: () => number
  pidAlive?: (pid: number) => boolean
  /** Test seam: runs after a lock is judged stale and before it is reclaimed (the window a second run could use). */
  afterJudged?: () => void
}
export type LockHandle = { path: string; token: string; verify: () => boolean; release: () => void }
export type LockResult = { ok: true; handle: LockHandle } | { ok: false; code: LockRefusal }

type LockContent = { pid: number; host: string; token: string; createdAt: string }
const MAX_LOCK_BYTES = 2048
const OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function readLockFile(file: string): { text: string; ino: number } | null {
  let fd: number
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK) } catch { return null }
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
    if (keys !== 'createdAt,host,pid,token') return null
    if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid < 1) return null
    if (typeof raw.host !== 'string' || raw.host.length === 0 || raw.host.length > 255) return null
    if (typeof raw.token !== 'string' || !/^[0-9a-f]{32}$/.test(raw.token)) return null
    if (!isStreamStamp(raw.createdAt)) return null
    return { pid: raw.pid, host: raw.host, token: raw.token, createdAt: raw.createdAt }
  } catch { return null }
}

function createExclusive(file: string, text: string): number {
  const fd = openSync(file, OPEN_FLAGS, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
    return fstatSync(fd).ino
  } finally {
    closeSync(fd)
  }
}

function handleFor(lockPath: string, content: LockContent, ino: number): LockHandle {
  const verify = () => {
    try {
      if (lstatSync(lockPath).ino !== ino) return false
      const current = readLockFile(lockPath)
      return current !== null && current.ino === ino && parseLock(current.text)?.token === content.token
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
  const alive = hooks.pidAlive ?? defaultPidAlive
  const lockPath = path.join(dir, PACK_LOCK_FILE)
  const content: LockContent = { pid, host, token: randomBytes(16).toString('hex'), createdAt: new Date(now()).toISOString() }
  const text = JSON.stringify(content)
  try {
    return { ok: true, handle: handleFor(lockPath, content, createExclusive(lockPath, text)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, code: 'LOCK_ERROR' }
  }

  const existing = readLockFile(lockPath)
  if (existing === null) return { ok: false, code: 'LOCK_UNREADABLE' }
  const held = parseLock(existing.text)
  if (held === null) return { ok: false, code: 'LOCK_UNREADABLE' }
  const age = now() - Date.parse(held.createdAt)
  const stale = held.host === host && (!alive(held.pid) || age > LOCK_STALE_MS)
  if (!stale) return { ok: false, code: 'LOCK_HELD' }

  hooks.afterJudged?.()
  const guardPath = path.join(dir, PACK_RECLAIM_FILE)
  try { createExclusive(guardPath, JSON.stringify({ pid, host })) } catch { return { ok: false, code: 'LOCK_STALE_CONTENDED' } }
  try {
    const again = readLockFile(lockPath)
    if (again === null || again.text !== existing.text || again.ino !== existing.ino) return { ok: false, code: 'LOCK_HELD' }
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
