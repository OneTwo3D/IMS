/**
 * THE OWNER'S CONFIRMATIONS AS THE WRITE PATHS SEE THEM: a process-wide, synchronous snapshot with THREE answers per kind.
 *
 * The producer decision and the egress gates (producer-disposition.ts, producer-seam.ts) are pure and synchronous: no database. The confirmation that an
 * incumbent writer is stopped (WriterAttestation) lives in the database, so every process keeps a snapshot of which kinds are in force and refreshes it
 * in the background (`startAttestationRefresh`, started from instrumentation.ts, the ONLY production caller) or on demand (`ensureAttestationSnapshot`).
 *
 * NO COMMAND OR SCRIPT DRAINS A QUEUE TODAY (`writers:check` hands the decision its own `attestations` set; `outbound:status` and `retire:held-backlog` only
 * read), and none calls `ensureAttestationSnapshot`. A tsx process that evaluated a delivery gate without registering a source would stay `unknown` and HOLD
 * everything, with nothing in the process saying why: a script that ever drains a queue must call `ensureAttestationSnapshot` first (it is exercised by the
 * tests as the script-context contract).
 *
 * THE ANSWER IS THREE-VALUED, AND ONLY ONE OF THE THREE MAY REFUSE:
 *   present   a positive read found the confirmation. Confirmations are append-only, so this never changes back.
 *   absent    a positive read of the table found no such confirmation. Work that needs it is HELD (queued, retried), never shadowed for good: the
 *             owner may record it a minute later and the held work then goes out.
 *   unknown   nothing has been read in this process yet, or the last read failed with nothing known before it. Treated exactly like `absent` for
 *             delivery (held and retried), and NEVER as a reason to shadow, because a boot or a failed read is not the owner's word.
 *
 * WHERE THE SNAPSHOT LIVES (same reason as lib/db/database-url-schema.mjs, "WHERE THE VERDICT LIVES"): `next build` emits this module into several
 * chunks, one for the instrumentation hook and one for the application graph (routes, server actions, cron routes), and each carries its OWN copy of a
 * module-level variable. The refresh started by instrumentation.ts would then update a copy that no route ever reads. So the state is held on
 * `globalThis` under a `Symbol.for` key, which every copy computes identically, and the key carries a version so a future shape takes a different slot.
 * A slot holding anything that is not shaped like this state reads as `unknown` (fail closed toward holding, never toward sending).
 *
 * A caller (a test, a command) may hand the decision its own set through `context.attestations`, which wins over the snapshot.
 */

import { WRITER_ATTESTATION_KINDS } from './writer-attestation-constants'

export const ATTESTATION_REFRESH_MS = 30_000
/** After a failed on-demand load, wait this long before another is started by a lookup (the background refresh keeps its own cadence). */
const LAZY_RETRY_MS = 5_000

export type AttestationState = 'present' | 'absent' | 'unknown'

type Reader = { writerAttestation: { findFirst(args: { where: { kind: string }; select: { id: true } }): Promise<{ id: string } | null> } }
type ReaderSource = () => Promise<Reader>

type SnapshotSlot = {
  v: 1
  /** The kinds a positive read found, or null when nothing has been read. */
  kinds: ReadonlySet<string> | null
  timer: ReturnType<typeof setInterval> | null
  /** Where an on-demand load reads from. Registered by the background refresh or by the caller of ensureAttestationSnapshot. */
  source: ReaderSource | null
  inflight: Promise<void> | null
  lastAttemptAt: number
}

export const ATTESTATION_SNAPSHOT_KEY = Symbol.for('onetwo3d.ims.writerAttestationSnapshot.v1')

function isSlot(value: unknown): value is SnapshotSlot {
  if (typeof value !== 'object' || value === null) return false
  const slot = value as Partial<SnapshotSlot>
  return slot.v === 1
    && (slot.kinds === null || slot.kinds instanceof Set)
    && typeof slot.lastAttemptAt === 'number'
}

function slot(): SnapshotSlot {
  const holder = globalThis as unknown as Record<symbol, unknown>
  const existing = holder[ATTESTATION_SNAPSHOT_KEY]
  if (isSlot(existing)) return existing
  // Absent, or something this module did not put there: start from "nothing known". The foreign value is replaced, never trusted.
  const fresh: SnapshotSlot = { v: 1, kinds: null, timer: null, source: null, inflight: null, lastAttemptAt: 0 }
  holder[ATTESTATION_SNAPSHOT_KEY] = fresh
  return fresh
}

/** The state of one confirmation. `supplied` (a caller's own set) wins and is always a positive read. Never throws, and never starts a read that blocks. */
export function attestationState(kind: string, supplied?: ReadonlySet<string>): AttestationState {
  if (supplied !== undefined) return supplied.has(kind) ? 'present' : 'absent'
  const current = slot()
  if (current.kinds === null) {
    kickLazyLoad(current)
    return 'unknown'
  }
  if (current.kinds.has(kind)) return 'present'
  // A positive read that showed it absent may be stale by up to a refresh interval; make sure a refresh is not far off.
  kickLazyLoad(current)
  return 'absent'
}

/** True only for a positive read that found the confirmation. */
export function attestationInForce(kind: string, supplied?: ReadonlySet<string>): boolean {
  return attestationState(kind, supplied) === 'present'
}

/** For the refresh and for tests. Null forgets everything (the state is `unknown` again). */
export function setAttestationSnapshot(kinds: ReadonlySet<string> | null): void {
  const current = slot()
  current.kinds = kinds === null ? null : new Set(kinds)
}

/** Forget everything, including the timer registration and the registered source (tests). */
export function resetAttestationSnapshotForTests(): void {
  const current = slot()
  if (current.timer !== null) clearInterval(current.timer)
  current.kinds = null
  current.timer = null
  current.source = null
  current.inflight = null
  current.lastAttemptAt = 0
}

async function readAll(db: Reader): Promise<Set<string>> {
  const kinds = new Set<string>()
  for (const kind of WRITER_ATTESTATION_KINDS) {
    if (await db.writerAttestation.findFirst({ where: { kind }, select: { id: true } })) kinds.add(kind)
  }
  return kinds
}

/**
 * Read the table and replace the snapshot. A read that throws leaves the previous snapshot as it was (and `unknown` if there was none), and rethrows.
 * Confirmations are append-only, so a kind already known present is kept even if a later read were to miss it.
 */
export async function refreshAttestationSnapshot(db: Reader): Promise<void> {
  const current = slot()
  const read = await readAll(db)
  if (current.kinds !== null) for (const kind of current.kinds) read.add(kind)
  current.kinds = read
}

function kickLazyLoad(current: SnapshotSlot): void {
  if (current.source === null || current.inflight !== null) return
  if (Date.now() - current.lastAttemptAt < LAZY_RETRY_MS) return
  void runLoad(current).catch(() => undefined)
}

function runLoad(current: SnapshotSlot): Promise<void> {
  if (current.inflight !== null) return current.inflight
  const source = current.source
  if (source === null) return Promise.resolve()
  current.lastAttemptAt = Date.now()
  const run = source().then(refreshAttestationSnapshot)
  const tracked: Promise<void> = run.finally(() => { if (current.inflight === tracked) current.inflight = null })
  current.inflight = tracked
  return tracked
}

/**
 * Make sure this process has read the confirmations at least once, and wait for it. For a command or script (tsx), which never runs instrumentation.ts:
 * it registers where to read from and loads. A read that fails rejects (the caller decides); the state stays `unknown`, which holds work.
 */
export async function ensureAttestationSnapshot(load: ReaderSource): Promise<void> {
  const current = slot()
  current.source = load
  if (current.kinds !== null) return
  await runLoad(current)
}

/**
 * Start the background refresh of a server process (idempotent per process, across every bundled copy of this module). It also registers the source
 * an on-demand load uses, so a route that finds the state `unknown` triggers a read without waiting for the next tick.
 */
export function startAttestationRefresh(load: ReaderSource): void {
  const current = slot()
  current.source = load
  if (current.timer !== null) return
  const tick = (): void => { void runLoad(current).catch(() => undefined) }
  tick()
  current.timer = setInterval(tick, ATTESTATION_REFRESH_MS)
  current.timer.unref?.()
}
