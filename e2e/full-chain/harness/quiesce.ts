/**
 * The quiesce lock (o3d-lgo.3).
 *
 * The full-chain rig SHARES the one Woo store and the one Xero Demo org with stage.
 * Stage syncs Woo every 5 minutes, posts to Xero every 5 minutes and batches at
 * 02:00, so without a lock it would import our test orders, post them to the shared
 * ledger, and race our own queue. The lock is therefore not an optimisation — it is
 * the isolation mechanism the whole design rests on.
 *
 * It does two things for the run window:
 *   1. Disables stage's connector settings (recording their prior values).
 *   2. Creates temporary Woo webhooks pointing at THIS instance (deleting them after).
 *
 * It deliberately does NOT touch the third-party Qoblex/ecartapi webhooks: those are
 * now permanently disabled, which removed a whole failure mode (a crashed run can no
 * longer leave someone else's integration silently paused).
 *
 * ASYMMETRY THAT MATTERS: we CREATE temporary hooks rather than REPOINT stage's
 * existing 818/819. A crash leaving a stray temp hook aimed at a dead e2e host merely
 * fails delivery while stage keeps working; a crash leaving stage's OWN hooks aimed at
 * a dead host silently stops stage receiving orders entirely. Always prefer
 * create+delete over mutate+restore here.
 *
 * THE LOCK IS THE SINGLE POINT OF FAILURE. If a run dies between acquire() and
 * release(), stage stays disabled and orders pile up unimported. So the lock record is
 * durable (a row in the e2e DB, not process memory) and acquire() RECOVERS a stale one
 * before doing anything else. scripts/restore-stage-connectors.ts is the manual escape
 * hatch.
 *
 * MUTUAL EXCLUSION, AND WHY IT IS THREE THINGS AND NOT ONE (o3d-lgo.14). Recovering an
 * abandoned lock and refusing a live one are the same code path looked at from two sides,
 * so the protocol has to answer all three of these together or it trades one failure for
 * another:
 *
 *   1. OWNERSHIP. acquire() returns an opaque TOKEN and release() verifies it. A process
 *      that never acquired releases NOTHING — because Playwright runs globalTeardown even
 *      when globalSetup throws, so the invocation that was just REFUSED the lock goes on to
 *      run teardown. Without the token it restores stage and deletes the lock out from under
 *      the run still using it: refusing to steal the lock at acquire, then stealing it at
 *      teardown instead.
 *   2. ATOMICITY. The claim is a single conditional INSERT (ON CONFLICT DO NOTHING) and
 *      recovery deletes COMPARE-AND-SET on the exact row it judged. Read-then-write lets two
 *      near-simultaneous invocations both see no row and both write one.
 *   3. A RENEWED LEASE, not a fixed age. The holder heartbeats while it runs; a lock is only
 *      abandoned once its heartbeat has stopped for LEASE_TTL_MS. A fixed staleness window
 *      cannot tell "still running" from "died an hour ago" for a holder on ANOTHER host,
 *      where pid liveness is unknowable — and this suite is one worker over dozens of tests
 *      with individual timeouts up to 30 minutes, so a healthy run can outlive any window
 *      short enough to be useful.
 *
 * Same-host pid liveness is kept as a FAST PATH on top of the lease: a crash on this box is
 * recovered immediately rather than after the TTL.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { Client } from 'pg'
import type { WcCreds } from './wc.ts'
import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '../../../lib/db/advisory-locks.ts'
import { INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER } from '../../../lib/integration-plugin-keys.ts'

const LOCK_KEY = 'e2e_quiesce_lock'

/** Stage settings that must be false while the rig runs. */
const STAGE_SETTINGS_TO_DISABLE = [
  'wc_sync_enabled',
  'plugin_xero_enabled',
  'xero_sync_enabled',
  'xero_daily_batch_enabled',
  'xero_payment_polling_enabled',
] as const

/**
 * Write settings on ANOTHER instance's database, under the same locks that instance's own code
 * takes (o3d-osl8 round 6, finding 2).
 *
 * `plugin_xero_enabled` is in the list above, and this harness was the concrete counter-example to
 * "the connector-selection advisory lock serializes every writer": it changes which accounting
 * connector stage considers active, over a raw `pg` client, taking no lock at all. Stage's own
 * `cancelOrphanedAccountingSyncRows` decides which sync rows to discard from exactly that value —
 * so a run acquiring or releasing the quiesce lock while an operator clicked "cancel orphaned
 * rows" on stage could have that cancel retire the queue of the connector this harness was in the
 * middle of switching.
 *
 * The order matches lib/integration-plugin-selection-lock.ts exactly — advisory lock first, then
 * the plugin rows `FOR UPDATE` in sorted key order — because taking them in the other order is the
 * one way these can deadlock against the app.
 *
 * All of it in ONE transaction, so stage never observes a partially-disabled connector set either.
 */
async function writeSettingsUnderPluginSelectionLock(
  client: Client,
  writes: ReadonlyArray<{ key: string; value: string | null }>,
  onWrite?: (key: string, value: string | null) => void,
): Promise<void> {
  const keys = [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER]
  await client.query('begin')
  try {
    await client.query('select pg_advisory_xact_lock($1)', [ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY])
    // Materialise before locking: `for update` locks only rows that exist, and on a fresh stage the
    // plugin rows may not.
    await client.query(
      `insert into settings (key, value, "updatedAt")
         select k, 'false', now() from unnest($1::text[]) as k
       on conflict (key) do nothing`,
      [keys],
    )
    await client.query(`select key from settings where key = any($1::text[]) order by key for update`, [keys])

    for (const { key, value } of writes) {
      if (value === null) {
        await client.query(`delete from settings where key = $1`, [key])
      } else {
        await client.query(
          `insert into settings (key, value, "updatedAt") values ($1, $2, now())
             on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
          [key, value],
        )
      }
    }
    await client.query('commit')
    // AFTER the commit, not per statement: a log line saying "restored to X" printed from inside a
    // transaction that then rolls back is a false record of the one thing an operator reads to
    // decide whether stage is armed.
    for (const { key, value } of writes) onWrite?.(key, value)
  } catch (error) {
    // Best-effort: if the connection itself is gone the rollback fails too, and the original error
    // is the one worth reporting.
    await client.query('rollback').catch(() => {})
    throw error
  }
}

/**
 * Topics that must be registered on the store, pointing at this instance.
 *
 * These are PERMANENT webhooks (ids 847/848), registered once — NOT created per run.
 * Two reasons, and the first is a hard blocker:
 *
 *  1. Woo would intermittently not SCHEDULE delivery for a just-created webhook: order
 *     163327 got its deliveries, 163329 minutes later got none queued at all. Woo caches
 *     the active-webhook set, so a hook created moments earlier can be missing from the
 *     list the order-creation request consults. Long-lived hooks are always cached —
 *     which is exactly why stage's own 818/819 never miss. (o3d-lgo.10)
 *  2. It shrinks this lock: with nothing created per run, a crashed run cannot strand a
 *     webhook, so the lock only has to restore stage's settings.
 *
 * TRADE-OFF, accepted deliberately: the e2e instance now receives every real stage order.
 * Between runs it sits disarmed (wc_sync_enabled=false) so those are discarded; during a
 * run the gate is open, so a real order placed in that window would import into the e2e
 * database. That DB is disposable and the window is minutes, but it is not nothing.
 *
 * THERE IS NO REFUND TOPIC IN WOOCOMMERCE CORE — attempting one returns
 * `woocommerce_rest_shop_webhook_invalid_topic`. A refund fires `order.updated`
 * (class-wc-webhook.php maps it to woocommerce_order_refunded), and handleOrderWebhook
 * calls syncRefundsForOrder() (webhooks.ts:190), so OC-05/OC-06 are covered.
 */
export const REQUIRED_WEBHOOK_TOPICS = ['order.created', 'order.updated'] as const

/**
 * Settings that must be TRUE on THIS instance for the run, and are restored after.
 *
 * The rig deliberately starts disarmed so it can never post to the shared Demo ledger
 * by accident. But wc_sync_enabled is not only an outbound switch: the inbound webhook
 * route gates on it too (getWebhookProcessingGate, webhooks.ts:316). With it false the
 * IMS answers Woo **202 {skipped: true}** — a SUCCESS code — and silently discards the
 * order. Woo therefore never retries and marks delivery complete, so the loss is
 * invisible from both ends. Arming it here for the run window is what makes inbound
 * webhooks work at all.
 *
 * Xero posting stays disarmed: tests arm that explicitly via ims.setPostingMode.
 */
const E2E_SETTINGS_TO_ENABLE = ['wc_sync_enabled'] as const

export type LockRecord = {
  takenAt: string
  runId: string
  stageSettings: Record<string, string | null>
  e2eSettings: Record<string, string | null>
  createdWebhookIds: number[]
  /**
   * Woo webhooks aimed at ANOTHER IMS (stage), paused for the run window with the status each had
   * before. Absent on locks from an older build — release then simply has nothing to restore.
   */
  stageWebhooks?: Array<{ id: number; status: string }>
  /**
   * Owner identity, so a LIVE holder can be told apart from the crash this lock's recovery was built for
   * (o3d-lgo.14). Optional: a lock written by an older build has neither, and is judged on age alone.
   */
  ownerPid?: number
  ownerHost?: string
  /**
   * The holder process's BIRTH: its kernel start-time counter and the machine's boot id. A pid alone is
   * a slot the kernel reissues, so after a crash or reboot an unrelated process holding the same pid
   * would keep the lock looking LIVE forever. Absent on locks from an older build, and on any platform
   * without /proc — the pid check then stands alone, as it used to.
   */
  ownerStart?: string
  ownerBoot?: string
  /**
   * Opaque proof of ownership. Only the process that minted it may release this lock — see the header:
   * a refused contender still runs globalTeardown, and without this it would restore stage on the
   * incumbent's behalf. Optional so a lock written by an older build can still be RECOVERED (release()
   * refuses to match an absent token, which is the safe direction: recovery goes through acquire()).
   */
  token?: string
  /**
   * Last renewal. The holder bumps this every LEASE_RENEW_INTERVAL_MS; a lock is abandoned only once it
   * has stopped. Optional: an older build's lock has none and falls back to LOCK_STALE_AFTER_MS on takenAt.
   */
  heartbeatAt?: string
  /** Diagnostics: the run whose abandoned lock this one took over, if any. */
  recoveredFrom?: string
  /**
   * Set while a release is restoring the world from this record. The row deliberately STAYS in place
   * until the restore finishes, so the lock is never briefly absent: a contender reading it mid-restore
   * sees a lock rather than an unlocked rig with half-restored stage settings.
   */
  releasing?: boolean
}

/** Just the ownership fields the liveness check reads, so it can be exercised without a whole lock record. */
export type LockOwner = { ownerPid?: number; ownerHost?: string; ownerStart?: string; ownerBoot?: string }

/**
 * A pid is not an identity — it is a slot, and the kernel reissues it.
 *
 * `process.kill(pid, 0)` proves only that SOMETHING owns that pid now. After a crash (and especially
 * after a reboot, where pids restart low) an unrelated process — including the next Playwright run —
 * can hold the dead holder's pid, and the lock would then read as permanently LIVE: stage stays
 * disabled until a human forces it (Codex, PR #560 round 4).
 *
 * So the lock also records the process's BIRTH: the kernel's start-time counter for that pid, and the
 * machine's boot id. Both are read straight from /proc; on a system without it we simply record nothing
 * and fall back to the pid alone, which is the behaviour we had.
 */
function processStartedAt(pid: number): string | undefined {
  try {
    // Field 22 of /proc/<pid>/stat is starttime, in clock ticks since boot. comm (field 2) can contain
    // spaces and brackets, so parse from the LAST ')' rather than splitting the whole line.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return after[19] || undefined // field 22 = index 19 once pid and comm are removed
  } catch {
    return undefined
  }
}

function bootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * How long a lock with no provable owner may sit before recovery treats it as abandoned.
 *
 * LEGACY ONLY: it applies to a lock written before heartbeats existed, which is judged on age alone. A
 * lock that never renews and is 45 minutes old is abandoned by any reasonable reading; a CURRENT lock is
 * judged on its lease instead, so a healthy long run is never stolen no matter how long it takes.
 */
export const LOCK_STALE_AFTER_MS = 45 * 60_000

/** How often the holder renews its lease while the suite runs. */
export const LEASE_RENEW_INTERVAL_MS = 30_000

/**
 * How long a lease survives without renewal before the lock counts as abandoned.
 *
 * Ten missed renewals. Long enough to ride out a paused event loop, a Xero client sleeping on a
 * Retry-After, or a stalled connection; short enough that a crashed run on another host is recovered
 * automatically within minutes instead of blocking the rig for the rest of the day. Note this is
 * deliberately NOT sized against the suite's duration — a running suite renews, so its own length is
 * irrelevant. That is the whole point of a lease over a fixed window.
 */
export const LEASE_TTL_MS = 10 * LEASE_RENEW_INTERVAL_MS

/**
 * Is the recorded owner still running?
 *
 *   true  — same host and the pid answers signal 0: a LIVE run holds this lock.
 *   false — same host and the pid is gone: crashed, safe to recover immediately.
 *   null  — cannot tell (different host, or no owner recorded by an older build): fall back to age.
 *
 * signal 0 performs the permission/existence check without delivering anything. EPERM means the process
 * exists but belongs to another user, which still counts as alive.
 */
export function isLockOwnerAlive(lock: LockOwner): boolean | null {
  if (!lock.ownerPid || !lock.ownerHost) return null
  if (lock.ownerHost !== hostname()) return null

  // The host rebooted since the lock was taken, so its holder is definitively gone whatever now owns
  // the pid. Checked first because it is the cheapest and most decisive signal.
  const boot = bootId()
  if (lock.ownerBoot && boot && lock.ownerBoot !== boot) return false

  try {
    process.kill(lock.ownerPid, 0)
  } catch (e) {
    // EPERM means the pid exists but belongs to another user — still alive.
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false
  }

  // Something holds the pid. Is it the same PROCESS? A reused pid has a different birth time.
  if (lock.ownerStart) {
    const start = processStartedAt(lock.ownerPid)
    if (start && start !== lock.ownerStart) return false
    if (!start) return true // the pid answered but /proc did not — do not guess dead
  }
  return true
}

export type RecoveryDecision = {
  /** 'held' — someone is using it; 'recover' — abandoned, take it over; 'wait' — cannot tell yet. */
  action: 'held' | 'recover' | 'wait'
  /** Human explanation, used verbatim in the abort message so the operator knows what to do. */
  reason: string
}

/**
 * Should this lock be taken over, refused, or waited out?
 *
 * The order matters. Pid liveness is checked FIRST and is decisive when it answers, because it is the
 * only signal that distinguishes "hung but running" from "gone": a holder that has stopped renewing but
 * whose process is still alive must be REFUSED, not recovered — killing it is the operator's call, and
 * stealing the lock from a process that may still be driving the shared Woo store is precisely the
 * corruption this exists to prevent. Only when liveness is unknowable (another host, or a lock from an
 * older build) does the lease decide.
 */
export function lockRecoveryDecision(
  lock: LockRecord,
  nowMs = Date.now(),
  /**
   * How long ago the DATABASE last saw this row written, if it told us.
   *
   * Preferred over any timestamp inside the record, because it is measured by one clock that every
   * contender shares. Comparing a holder-written heartbeat against the contender's own Date.now() means
   * two hosts whose clocks differ by more than the TTL disagree about whether a lease is alive — one
   * side steals a healthy run, the other never recovers a dead one (Codex, PR #560 round 4).
   */
  dbAgeMs: number | null = null,
): RecoveryDecision {
  const alive = isLockOwnerAlive(lock)
  const who = `run ${lock.runId}${lock.ownerHost ? ` on ${lock.ownerHost}` : ''}${lock.ownerPid ? ` (pid ${lock.ownerPid})` : ''}`

  if (alive === true) {
    return { action: 'held', reason: `${who} is a LIVE process on this host` }
  }
  if (alive === false) {
    return { action: 'recover', reason: `${who} is gone — no live process with its identity on this host` }
  }

  // A RELEASE IN PROGRESS IS NOT AN EXPIRED LEASE. The releaser stops renewing before it fences, so a
  // fenced row's age grows by design — and recovering it on the lease TTL would let another host take
  // over while the original is still restoring stage, which would then land underneath the new run
  // (Codex, PR #560 round 5). A stuck release is judged on the LEGACY window instead: 45 minutes is far
  // beyond any real release (local settings writes plus, on legacy locks only, a bounded webhook
  // delete), and still recovers automatically rather than leaving stage disabled until a human notices.
  if (lock.releasing) {
    const stuckMs = dbAgeMs ?? nowMs - Date.parse(lock.heartbeatAt ?? lock.takenAt)
    const how = dbAgeMs !== null ? 'by the database' : "against this host's clock"
    if (!Number.isFinite(stuckMs)) {
      return { action: 'wait', reason: `${who} is mid-RELEASE and its age cannot be determined` }
    }
    const stuck = `${Math.round(stuckMs / 60_000)}m into a release (measured ${how})`
    return stuckMs > LOCK_STALE_AFTER_MS
      ? { action: 'recover', reason: `${who} is ${stuck} — long past any real release, so it is abandoned` }
      : {
        action: 'held',
        reason:
          `${who} is ${stuck} and still restoring stage. Taking it over now would land its restore ` +
          `underneath this run. It is recovered automatically after ` +
          `${Math.round(LOCK_STALE_AFTER_MS / 60_000)}m, or immediately with the escape hatch's --force.`,
      }
  }

  // Unknowable owner: the lease is the only evidence.
  if (dbAgeMs !== null || lock.heartbeatAt) {
    // The database's own measurement first; the recorded heartbeat is the fallback for a store that
    // cannot report one (and it is the same signal, just measured on a clock we do not control).
    const sinceMs = dbAgeMs ?? nowMs - Date.parse(lock.heartbeatAt as string)
    const measuredBy = dbAgeMs !== null ? 'by the database' : "against this host's clock"
    if (!Number.isFinite(sinceMs)) {
      return { action: 'wait', reason: `${who} has an unparseable heartbeat (${lock.heartbeatAt})` }
    }
    if (!lock.heartbeatAt && dbAgeMs !== null && !lock.token) {
      // A pre-lease lock: it never renews, so row age is NOT lease age. Fall through to the legacy window.
    } else {
      const since = `${Math.round(sinceMs / 1000)}s since its last renewal (measured ${measuredBy})`
      return sinceMs > LEASE_TTL_MS
        ? { action: 'recover', reason: `${who} stopped renewing its lease — ${since}, past the ${Math.round(LEASE_TTL_MS / 1000)}s TTL` }
        : { action: 'held', reason: `${who} is renewing its lease — ${since}` }
    }
  }

  // Legacy lock (pre-heartbeat): age is all there is.
  const ageMs = dbAgeMs ?? nowMs - Date.parse(lock.takenAt)
  if (!Number.isFinite(ageMs)) {
    return { action: 'wait', reason: `${who} has no heartbeat and an unparseable takenAt (${lock.takenAt})` }
  }
  const age = `${Math.round(ageMs / 60_000)}m old`
  return ageMs > LOCK_STALE_AFTER_MS
    ? { action: 'recover', reason: `${who} predates lease renewal and is ${age}, past the ${Math.round(LOCK_STALE_AFTER_MS / 60_000)}m legacy window` }
    : { action: 'wait', reason: `${who} predates lease renewal, is only ${age}, and has no provable owner on this host` }
}

function stageDb(): Client {
  const url = process.env.STAGE_DATABASE_URL
  if (!url) throw new Error('STAGE_DATABASE_URL is not set — the quiesce lock cannot reach stage.')
  return new Client({ connectionString: url })
}

function e2eDb(): Client {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (url.includes('onetwo3d_ims_dev')) {
    throw new Error('ABORT: DATABASE_URL points at STAGE. The lock must be held by the e2e instance.')
  }
  return new Client({ connectionString: url })
}

/**
 * The lock row, as the four operations the protocol actually needs.
 *
 * Named as an interface so the claim protocol can be tested against a fake that reproduces the races —
 * a contender winning between our read and our write, a heartbeat losing its row — without needing two
 * real processes and a Postgres. The Postgres implementation is the only one used in anger; its
 * conditional-write semantics ARE the mutual exclusion, so the fake mirrors them exactly.
 */
export type LockStore = {
  /** Claim by conditional insert. false means someone else already holds it. Never overwrites. */
  claim(raw: string): Promise<boolean>
  /**
   * The current row, raw text and parsed — plus how long ago the DATABASE last saw it written.
   *
   * `ageMs` is measured by Postgres (now() - updatedAt), not by subtracting a holder-written timestamp
   * from the contender's clock. Two hosts whose clocks differ by more than the TTL would otherwise
   * disagree about whether a lease had expired: one side declares every fresh renewal stale and takes
   * the lock from a healthy run, or never recovers a dead one (Codex, PR #560 round 4). One clock,
   * shared by everyone, removes the question.
   */
  read(): Promise<{ raw: string; lock: LockRecord; ageMs: number | null } | null>
  /** Replace ONLY if the row still reads exactly as `expected` (compare-and-set take-over). */
  replaceIfUnchanged(expected: string, raw: string): Promise<boolean>
  /** Delete ONLY if the row still reads exactly as `expected` (compare-and-set, for the forced release). */
  deleteIfUnchanged(expected: string): Promise<boolean>
  /** Delete ONLY if the row still carries `token` (for our own release; the heartbeat rewrites `raw`). */
  deleteIfOwned(token: string): Promise<boolean>
  /**
   * Overwrite ONLY if the row still carries `token` AND is not being released. false means we no longer
   * hold the lock — or that a release of ours has already fenced it, which a late renewal must not undo.
   */
  writeIfOwned(token: string, raw: string): Promise<boolean>
}

function parseLock(raw: string): LockRecord {
  try {
    return JSON.parse(raw) as LockRecord
  } catch {
    // A corrupt lock must not be silently discarded: it means stage may still be
    // disabled with no record of the originals.
    throw new Error(
      `The quiesce lock row (${LOCK_KEY}) is present but unparseable. Stage may still be ` +
        `disabled. Inspect it and restore stage by hand before continuing.`,
    )
  }
}

/**
 * The Postgres implementation. `key` is overridable ONLY so the concurrency test can prove the
 * conditional-write semantics against a real database without writing a bogus quiesce lock into whatever
 * DATABASE_URL happens to point at.
 */
export function pgLockStore(db: Client, key: string = LOCK_KEY): LockStore {
  return {
    async claim(raw) {
      // ON CONFLICT DO NOTHING is the mutual exclusion: exactly one of N concurrent inserts returns a row.
      const r = await db.query(
        `insert into settings (key, value, "updatedAt") values ($1, $2, now())
           on conflict (key) do nothing
         returning key`,
        [key, raw],
      )
      return r.rowCount === 1
    },
    async read() {
      const r = await db.query<{ value: string; age_ms: string | null }>(
        `select value, extract(epoch from (now() - "updatedAt")) * 1000 as age_ms
           from settings where key = $1`,
        [key],
      )
      if (!r.rows.length) return null
      const ageMs = r.rows[0].age_ms == null ? null : Number(r.rows[0].age_ms)
      return {
        raw: r.rows[0].value,
        lock: parseLock(r.rows[0].value),
        ageMs: Number.isFinite(ageMs as number) ? (ageMs as number) : null,
      }
    },
    async replaceIfUnchanged(expected, raw) {
      const r = await db.query(
        `update settings set value = $3, "updatedAt" = now() where key = $1 and value = $2`,
        [key, expected, raw],
      )
      return r.rowCount === 1
    },
    async deleteIfUnchanged(expected) {
      const r = await db.query(`delete from settings where key = $1 and value = $2`, [key, expected])
      return r.rowCount === 1
    },
    async deleteIfOwned(token) {
      const r = await db.query(`delete from settings where key = $1 and value::jsonb ->> 'token' = $2`, [key, token])
      return r.rowCount === 1
    },
    async writeIfOwned(token, raw) {
      // `releasing` is excluded so a renewal that was already in flight when release() fenced the row
      // cannot overwrite the fence and make our own final delete fail (Codex, PR #560 round 3).
      const r = await db.query(
        `update settings set value = $2, "updatedAt" = now()
          where key = $1 and value::jsonb ->> 'token' = $3
            and coalesce(value::jsonb ->> 'releasing', 'false') <> 'true'`,
        [key, raw, token],
      )
      return r.rowCount === 1
    },
  }
}

async function readLock(db: Client): Promise<LockRecord | null> {
  return (await pgLockStore(db).read())?.lock ?? null
}

/**
 * Take the lock row: claim a free one, TAKE OVER an abandoned one, refuse a live one.
 *
 * RECOVERY IS A TAKE-OVER, NOT A RESTORE-THEN-RECLAIM. The obvious shape — restore stage from the
 * abandoned record, delete the row, then claim it fresh — has a race that survives compare-and-set on the
 * delete: two recoverers can judge the same abandoned row, the first wins and DISABLES stage again, and
 * the second is still in the middle of restoring it. Its CAS then fails and it aborts, but stage has
 * already been re-enabled underneath the winner (Codex, PR #560). Idempotent writes do not help — the
 * problem is that the restore crosses an ownership change.
 *
 * So the abandoned row is converted into OUR row in a single compare-and-set, and we INHERIT the
 * originals it recorded. Nothing is restored on the way in, there is no unlocked interval to lose a race
 * in, and release() at the end of our run is what finally puts stage back — from the same values the
 * crashed run recorded. Only one contender can win the CAS; the rest see a live lock and abort.
 *
 * `snapshot` is called once per attempt because losing a race means the world may have changed.
 */
export async function claimLock(
  store: LockStore,
  snapshot: () => Promise<LockRecord>,
  opts: { attempts?: number; now?: () => number } = {},
): Promise<{ raw: string; lock: LockRecord }> {
  const attempts = opts.attempts ?? 3
  const now = opts.now ?? Date.now
  let lastReason = 'unknown'

  for (let i = 0; i < attempts; i++) {
    const mine = await snapshot()
    const raw = JSON.stringify(mine)
    if (await store.claim(raw)) return { raw, lock: mine }

    const found = await store.read()
    // Gone between the failed claim and the read: someone released it. Try again immediately.
    if (!found) { lastReason = 'the holder released it as we looked'; continue }

    const decision = lockRecoveryDecision(found.lock, now(), found.ageMs)
    lastReason = decision.reason
    if (decision.action !== 'recover') {
      throw new Error(
        `ABORT: the quiesce lock is HELD — ${decision.reason}. The suite shares ONE Woo store and ONE ` +
          `Xero Demo org, so a second concurrent invocation would corrupt both runs. Wait for it to finish, ` +
          `or kill that process and re-run (a lock whose owner is gone recovers automatically; one that ` +
          `stops renewing its lease is recovered ${Math.round(LEASE_TTL_MS / 1000)}s later).`,
      )
    }

    // Inherit what the abandoned run recorded — those are the true originals, since stage is still
    // disabled by it. Our own snapshot would record the DISABLED values as the originals and release()
    // would then "restore" stage to off, turning one crashed run into a permanent outage. Fall back to
    // our snapshot only when the abandoned record has nothing (it died before recording, so it never
    // disabled anything either).
    const inherited = Object.keys(found.lock.stageSettings ?? {}).length ? found.lock.stageSettings : mine.stageSettings
    const inheritedE2e = Object.keys(found.lock.e2eSettings ?? {}).length ? found.lock.e2eSettings : mine.e2eSettings
    // Same reasoning for the webhooks, and the same trap: the abandoned run PAUSED them, so our own
    // snapshot sees `paused` and would "restore" stage's hooks to off — one crashed run becoming a
    // permanent stage-import outage (Codex, PR o3d-f737 round 1). Fall back to ours only for a legacy
    // lock that has no record, which also never paused anything.
    const inheritedHooks = found.lock.stageWebhooks?.length ? found.lock.stageWebhooks : mine.stageWebhooks
    const takeover: LockRecord = {
      ...mine,
      stageSettings: inherited,
      e2eSettings: inheritedE2e,
      stageWebhooks: inheritedHooks,
      // Legacy per-run webhooks the crashed run created become ours to delete at release.
      createdWebhookIds: found.lock.createdWebhookIds ?? [],
      recoveredFrom: found.lock.runId,
    }
    const takeoverRaw = JSON.stringify(takeover)
    if (await store.replaceIfUnchanged(found.raw, takeoverRaw)) {
      console.warn(
        `[quiesce] took over an ABANDONED lock — ${decision.reason}. Its recorded stage settings are now ` +
          `ours to restore at the end of this run: ` +
          `${Object.entries(inherited).map(([k, v]) => `${k}=${v ?? '(absent)'}`).join(', ') || '(none recorded)'}`,
      )
      return { raw: takeoverRaw, lock: takeover }
    }
    lastReason = `${decision.reason} — but another contender took it over first`
  }

  throw new Error(
    `ABORT: could not take the quiesce lock after ${attempts} attempts — it kept changing hands ` +
      `(last: ${lastReason}). Something else is running the full-chain suite against this rig.`,
  )
}

// --- WooCommerce REST -------------------------------------------------------

async function wcCreds(db: Client) {
  const { decryptSettingValue, isEncryptedSettingValue } = await import('../../../lib/security/encrypted-settings.ts')
  const r = await db.query<{ key: string; value: string }>(
    `select key, value from settings where key in ('wc_url','wc_consumer_key','wc_consumer_secret','wc_webhook_secret')`,
  )
  const m = new Map(r.rows.map((x) => [x.key, isEncryptedSettingValue(x.value) ? decryptSettingValue(x.key, x.value) : x.value]))
  const url = m.get('wc_url'); const key = m.get('wc_consumer_key'); const secret = m.get('wc_consumer_secret')
  if (!url || !key || !secret) throw new Error('WooCommerce credentials are not configured on this instance.')
  return { url: url.replace(/\/$/, ''), key, secret, webhookSecret: m.get('wc_webhook_secret') ?? '' }
}

async function wcRequest<T>(
  c: { url: string; key: string; secret: string },
  path: string,
  init?: RequestInit,
): Promise<T> {
  const auth = Buffer.from(`${c.key}:${c.secret}`).toString('base64')
  const res = await fetch(`${c.url}/wp-json/wc/v3${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WC ${init?.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

/**
 * Assert the permanent delivery webhooks exist, are ACTIVE, and point here.
 *
 * WooCommerce disables a webhook after repeated delivery failures, so one can go quietly
 * `disabled` between runs — and a disabled hook fails the same way as a missing one:
 * every test times out with nothing in the inbox. Checking costs one request.
 */
async function assertPermanentWebhooks(creds: WcCreds, appUrl: string): Promise<void> {
  const host = new URL(appUrl).host
  const hooks = await wcRequest<Array<{ id: number; topic: string; delivery_url: string; status: string }>>(
    creds, '/webhooks?per_page=100',
  )
  const problems: string[] = []
  for (const topic of REQUIRED_WEBHOOK_TOPICS) {
    const hit = hooks.find((h) => h.topic === topic && h.delivery_url.includes(host))
    if (!hit) {
      problems.push(`no ${topic} webhook delivering to ${host}`)
    } else if (hit.status !== 'active') {
      problems.push(`${topic} webhook ${hit.id} is "${hit.status}", not active (Woo disables a hook after repeated delivery failures)`)
    }
  }
  if (problems.length) {
    throw new Error(
      `Permanent delivery webhooks are not usable:\n  - ${problems.join('\n  - ')}\n` +
        `Without them Woo delivers nothing here and every test times out with an empty inbox. ` +
        `Re-register them (o3d-lgo.10) before running.`,
    )
  }
  console.log(`[quiesce] permanent delivery webhooks OK (${REQUIRED_WEBHOOK_TOPICS.join(', ')} -> ${host})`)
}

/**
 * Woo webhooks that deliver to a DIFFERENT IMS than this one — in practice the stage instance.
 *
 * Only our own route is matched (`/api/webhooks/shopping/woocommerce`), which deliberately leaves the
 * third-party Qoblex/ecartapi hooks alone: this module must not touch those (see the header).
 */
export function isStageBoundImsWebhook(deliveryUrl: string, stageHost: string): boolean {
  // OUR route, so the third-party Qoblex/ecartapi hooks are never candidates however they are named —
  // this module must not touch those (see the header).
  if (!deliveryUrl.includes('/api/webhooks/shopping/woocommerce')) return false
  let host: string
  try {
    host = new URL(deliveryUrl).host
  } catch {
    // An unparseable delivery_url is not something to switch off on a guess.
    return false
  }
  // The STAGE host specifically, read from stage's own public_app_url — NOT "any host that is not this
  // one". This lock coordinates exactly two instances, and the Woo store can carry hooks for others: a
  // not-e2e test would pause PRODUCTION's hook if it ever shared this store, taking down a live import
  // to tidy a test environment (Codex, PR o3d-f737 round 1).
  //
  // EQUALITY, not substring: "ims-e2e.example.com".includes("ims.example.com") is false, but the reverse
  // pairing of those names is exactly how a substring test matches the wrong instance.
  return host === stageHost
}

async function stageBoundImsWebhooks(creds: WcCreds, stageAppUrl: string): Promise<Array<{ id: number; status: string; delivery_url: string }>> {
  const stageHost = new URL(stageAppUrl).host
  const hooks = await wcRequest<Array<{ id: number; status: string; delivery_url: string }>>(
    creds, '/webhooks?per_page=100',
  )
  return hooks.filter((h) => isStageBoundImsWebhook(h.delivery_url, stageHost))
}

/**
 * PAUSE the stage instance's own delivery webhooks for the run window.
 *
 * Disabling stage's IMS settings is not enough. The webhooks live in WOOCOMMERCE, so every order this
 * suite creates still fans a delivery out at stage — which, quiesced, cannot accept it. Two costs, both
 * observed on 2026-07-26 (o3d-f737):
 *
 *   1. Every failed delivery is retried by Action Scheduler, and those retries queue AHEAD of this
 *      run's own deliveries on a store whose queue only advances when WP-Cron is nudged. Order
 *      deliveries that normally land in under a minute went undelivered for twenty, and three
 *      consecutive OC-22 runs failed on a webhook that was never coming.
 *   2. WooCommerce DISABLES a webhook after repeated delivery failures. Stage's order.updated hook had
 *      already been auto-disabled with failure_count 6, and order.created was on its way — so running
 *      this suite was quietly breaking the stage store's own order sync.
 *
 * Paused, not deleted: the status each hook had is recorded in the lock so release restores it, and a
 * crashed run's recovery inherits that record exactly as it inherits stage's settings.
 */
async function pauseStageWebhooks(creds: WcCreds, recorded: Array<{ id: number; status: string }>): Promise<void> {
  // Only the ACTIVE ones are touched. A hook an operator paused, or that Woo's own failure counter
  // disabled, is left exactly as found — and its recorded status is what release puts back, so this
  // never "activates" something that was off.
  const toPause = recorded.filter((h) => h.status === 'active')
  for (const hook of toPause) {
    await withDeadline(
      wcRequest(creds, `/webhooks/${hook.id}`, { method: 'PUT', body: JSON.stringify({ status: 'paused' }) }),
      WEBHOOK_DELETE_TIMEOUT_MS,
      `pausing stage webhook ${hook.id}`,
    )
  }
  if (recorded.length) {
    console.log(
      `[quiesce] stage-bound webhooks: paused ${toPause.length ? toPause.map((h) => h.id).join(', ') : 'none'}` +
        ` (recorded ${recorded.map((h) => `${h.id}=${h.status}`).join(', ')})`,
    )
  }
}

/** Put each stage-bound webhook back to the status the lock recorded. Idempotent. */
async function restoreStageWebhooks(
  creds: WcCreds,
  recorded: Array<{ id: number; status: string }>,
): Promise<{ restored: number[]; failed: Array<{ id: number; status: string; error: string }> }> {
  const restored: number[] = []
  const failed: Array<{ id: number; status: string; error: string }> = []
  for (const { id, status } of recorded) {
    // One retry: the single remote call in a release, and a transient Woo blip should not be enough to
    // hold the lock open (below) when trying twice would have settled it.
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await withDeadline(
          wcRequest(creds, `/webhooks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
          WEBHOOK_DELETE_TIMEOUT_MS,
          `restoring stage webhook ${id}`,
        )
        lastError = undefined
        break
      } catch (e) {
        lastError = e
      }
    }
    if (lastError) {
      // NOT swallowed. Reporting these as restored is what would make the outage self-perpetuating: the
      // lock row is deleted on a successful release, so the record of what to put back would be gone,
      // and the NEXT run would snapshot `paused` as the baseline and faithfully restore it for ever
      // (Codex, round 1).
      failed.push({ id, status, error: lastError instanceof Error ? lastError.message : String(lastError) })
    } else {
      restored.push(id)
    }
  }
  if (restored.length) console.log(`[quiesce] stage-bound webhooks restored: ${restored.join(', ')}`)
  return { restored, failed }
}

// --- public API -------------------------------------------------------------

export type QuiesceHandle = { runId: string; deliveryUrlBase: string; token: LockToken }

/** Opaque proof that THIS process holds the lock. Only its holder may release it. */
export type LockToken = string

/**
 * The token this process holds, or null when it holds nothing.
 *
 * Module state, so release() defaults to "what we acquired" and a process that never acquired has
 * nothing to default to — which is exactly the property that stops a refused contender releasing
 * someone else's lock from globalTeardown.
 */
let held: { token: LockToken; raw: string } | null = null
let heartbeat: NodeJS.Timeout | null = null
/** The I/O-free timer that enforces the fence even when a renewal never settles. */
let watchdog: NodeJS.Timeout | null = null
/**
 * The renewal currently executing, if any.
 *
 * Clearing the interval does not cancel a renewal that has already started, and that renewal still
 * writes. release() therefore AWAITS this before reading the row: a renewal landing between the read and
 * the fence makes the fence fail and the release silently do nothing (Codex, PR #560 round 3).
 */
let renewInFlight: Promise<void> | null = null
/**
 * When we last PROVED we still own the row, on a MONOTONIC clock.
 *
 * Not Date.now(). If the host clock steps backwards (ntp correction, a VM resuming), a wall-clock
 * leaseProvenAt can sit in the future and the watchdog then never trips — while another host, judging
 * the same lock by the DATABASE's clock, expires it after the TTL and starts a second run. The two
 * would be driving the shared store together with the fence silently disarmed (Codex, PR #560 round 7).
 * performance.now() cannot be moved by anything.
 */
let leaseProvenAt = 0

/** Does THIS process hold the quiesce lock? Teardown asks before touching anything shared. */
export function holdsQuiesceLock(): boolean {
  return held !== null
}

/**
 * How long we may go without PROVING ownership before this run must stop.
 *
 * Strictly less than the TTL another run recovers us at, so we fail-stop BEFORE anyone can legitimately
 * take the lock — never after. One renewal interval of margin is enough: a renewal that has not
 * succeeded within it has already had nine attempts.
 */
export const LEASE_FENCE_AFTER_MS = LEASE_TTL_MS - LEASE_RENEW_INTERVAL_MS

/**
 * May this run keep touching shared state?
 *
 * 'stop' has two causes and one meaning. Either the row is provably someone else's now, or we simply
 * cannot prove it is still ours and are close enough to the TTL that another host may take it. In both
 * cases continuing means a second suite driving the same Woo store and Xero org — which is the entire
 * thing this lock exists to prevent, so the run must not merely decline to clean up: it must STOP.
 */
export function leaseVerdict(o: { ownershipLost: boolean; msSinceProven: number }): 'ok' | 'stop' {
  if (o.ownershipLost) return 'stop'
  return o.msSinceProven >= LEASE_FENCE_AFTER_MS ? 'stop' : 'ok'
}

/**
 * What to do when the lease is gone. Replaceable ONLY so the tests can observe the decision instead of
 * exiting the test runner.
 *
 * The default really is a hard exit. Playwright has no "abort the run" hook a background timer can pull,
 * and letting the suite carry on would have it drive the shared store while another run legitimately
 * owns it. The cost is that our tracked Xero documents are left in the Demo ledger — the next run's
 * straggler scan names them, and a manual void is cheap next to corrupting a live run.
 */
let onLeaseLost: (reason: string) => void = (reason) => {
  console.error(
    `\n[quiesce] *** STOPPING THE RUN *** ${reason}\n` +
      `Another invocation may now legitimately hold the lock, so continuing would drive the shared Woo\n` +
      `store and Xero Demo org from two suites at once. Any Xero documents this run created are LEFT in\n` +
      `the Demo ledger — the next run's straggler scan will name them.\n`,
  )
  process.exit(1)
}

/** Test seam for the fail-stop above. Returns the previous handler so a test can restore it. */
export function setLeaseLostHandler(fn: (reason: string) => void): (reason: string) => void {
  const prev = onLeaseLost
  onLeaseLost = fn
  return prev
}

/**
 * How often the watchdog asks "can we still prove we hold this?" — and the deadline on one renewal's I/O.
 *
 * The renewal deadline is well inside the renewal interval so a blackholed connection is abandoned before
 * the next attempt, rather than piling up.
 */
export const LEASE_WATCHDOG_INTERVAL_MS = 5_000
export const LEASE_RENEW_TIMEOUT_MS = 10_000
/** A release's only remote call. Bounded so a stalled Woo cannot hold the fence past recovery. */
const WEBHOOK_DELETE_TIMEOUT_MS = 15_000
/**
 * Server-side cancellation for the restore writes.
 *
 * Far below the window after which a `releasing` row may be recovered, so a stalled query is killed by
 * Postgres long before anyone could take the fence — and killed, not merely abandoned, so it cannot
 * resume against a stage that now belongs to another run.
 */
const RESTORE_STATEMENT_TIMEOUT_MS = 20_000

/** Reject rather than hang forever. A renewal that has not answered in 10s is not going to. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Fail-stop. Idempotent: the watchdog and a renewal can reach this at the same moment. */
function loseLease(reason: string): void {
  if (!held) return
  held = null
  stopHeartbeat()
  onLeaseLost(reason)
}

/**
 * Keep the lease alive while the suite runs — and stop the run when it cannot be kept.
 *
 * THE WATCHDOG IS SEPARATE FROM THE RENEWAL ON PURPOSE. Judging the lease inside the renewal means the
 * judgement only happens when the renewal's I/O settles, so a blackholed connection or query — which has
 * no deadline of its own — sails straight past the fence: another host recovers the expired row after the
 * TTL while these workers keep driving the shared Woo store and Xero org (Codex, PR #560 round 2). The
 * watchdog does no I/O at all. It reads a clock and a variable, so nothing can wedge it.
 *
 * Renewals are also SERIALIZED. Overlapping ones can settle out of order and write an older heartbeat
 * over a newer one, which would age the lease backwards from another host's point of view.
 *
 * Both timers are unref'd so they can never hold the process open on their own.
 */
function startHeartbeat(token: LockToken, lock: LockRecord): void {
  leaseProvenAt = performance.now()

  heartbeat = setInterval(() => {
    if (renewInFlight) return // serialized: never two renewals racing to write heartbeatAt
    renewInFlight = (async () => {
      // Its own short-lived connection each time. acquire()'s clients are closed when it returns, and an
      // idle one held open for the whole suite is worse than reconnecting every 30 seconds.
      const db = e2eDb()
      try {
        await withDeadline(db.connect(), LEASE_RENEW_TIMEOUT_MS, 'the lease renewal connection')
        const renewed: LockRecord = { ...lock, heartbeatAt: new Date().toISOString() }
        const raw = JSON.stringify(renewed)
        const owned = await withDeadline(
          pgLockStore(db).writeIfOwned(token, raw), LEASE_RENEW_TIMEOUT_MS, 'the lease renewal write',
        )
        if (owned) {
          // Monotonic in two senses: a monotonic CLOCK, and never moved backwards by a late renewal.
          leaseProvenAt = Math.max(leaseProvenAt, performance.now())
          if (held) held = { token, raw }
          return
        }
        console.error(
          `\n[quiesce] *** LOST THE QUIESCE LOCK *** run ${lock.runId} no longer owns '${LOCK_KEY}' — it was ` +
            `recovered or deleted while this run is still going. Stage settings are now another run's ` +
            `responsibility, so this run will NOT restore them.\n`,
        )
        loseLease(`the quiesce lock was taken over by another run (${lock.runId} no longer owns it)`)
      } catch (e) {
        // A renewal that fails is not yet a lost lease — there is slack by design — but it is not proof
        // of ownership either. The watchdog owns the decision about when the slack runs out.
        console.warn(`[quiesce] lease renewal failed (will retry): ${e instanceof Error ? e.message : e}`)
      } finally {
        void db.end().catch(() => {})
        renewInFlight = null
      }
    })()
    void renewInFlight
  }, LEASE_RENEW_INTERVAL_MS)
  heartbeat.unref()

  watchdog = setInterval(() => {
    const msSinceProven = performance.now() - leaseProvenAt
    if (leaseVerdict({ ownershipLost: false, msSinceProven }) === 'stop') {
      loseLease(
        `the quiesce lock lease has not been PROVEN for ${Math.round(msSinceProven / 1000)}s — within ` +
          `${Math.round(LEASE_RENEW_INTERVAL_MS / 1000)}s of the ${Math.round(LEASE_TTL_MS / 1000)}s TTL at ` +
          `which another run may recover it`,
      )
    }
  }, LEASE_WATCHDOG_INTERVAL_MS)
  watchdog.unref()
}

function stopHeartbeat(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
  if (watchdog) { clearInterval(watchdog); watchdog = null }
}

/**
 * Take the lock: recover an abandoned one, refuse a live one, disable stage, arm this instance.
 * Safe to call when a previous run crashed — that is the point.
 */
export async function acquire(runId: string): Promise<QuiesceHandle> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set — webhooks would have nowhere to deliver.')

  const e2e = e2eDb(); await e2e.connect()
  const stage = stageDb(); await stage.connect()
  try {
    const store = pgLockStore(e2e)
    const token: LockToken = `${runId}:${process.pid}@${hostname()}:${randomUUID()}`

    // Snapshot + claim, once per attempt. The snapshot has to be INSIDE the attempt because a recovery
    // between attempts changes what the originals are (see claimLock).
    const snapshot = async (): Promise<LockRecord> => {
      const prior: Record<string, string | null> = {}
      for (const key of STAGE_SETTINGS_TO_DISABLE) {
        const r = await stage.query<{ value: string }>(`select value from settings where key = $1`, [key])
        prior[key] = r.rows.length ? r.rows[0].value : null
      }
      const priorE2e: Record<string, string | null> = {}
      for (const key of E2E_SETTINGS_TO_ENABLE) {
        const r = await e2e.query<{ value: string }>(`select value from settings where key = $1`, [key])
        priorE2e[key] = r.rows.length ? r.rows[0].value : null
      }
      const takenAt = new Date().toISOString()
      return {
        takenAt,
        runId,
        // Owner identity, so the next acquire can tell a live run from a crash (o3d-lgo.14).
        ownerPid: process.pid,
        ownerHost: hostname(),
        // Birth identity, so a REUSED pid cannot make a dead lock look live (Codex round 4).
        ownerStart: processStartedAt(process.pid),
        ownerBoot: bootId(),
        token,
        heartbeatAt: takenAt,
        stageSettings: prior,
        e2eSettings: priorE2e,
        createdWebhookIds: [],
        // INSIDE the snapshot, so it is re-read per attempt like the settings are. Hoisted out, a
        // contender that lost one attempt would keep the statuses it saw while the incumbent still held
        // the lock — recording `paused`, never pausing, and writing `paused` back on release (Codex,
        // round 1). This lands in the record claimLock writes, which is also what startHeartbeat
        // captures, so the heartbeat rewrites cannot drop it.
        stageWebhooks: await stageBoundImsWebhooks(creds, stageAppUrl)
          .then((hooks) => hooks.map((h) => ({ id: h.id, status: h.status })))
          .catch((e) => {
            // A store that will not list its webhooks cannot be quiesced safely: proceeding would fan
            // failed deliveries at stage all run and leave nothing to restore.
            throw new Error(`could not list Woo webhooks to quiesce stage's delivery hooks: ${e instanceof Error ? e.message : e}`)
          }),
      }
    }

    const creds = await wcCreds(e2e)

    // Stage's OWN identity, from stage's own database — the only authoritative answer to "which
    // webhooks belong to the instance this lock quiesces". Anything derived from the e2e side would be
    // a guess about someone else's host (Codex, round 1).
    const stageAppUrl = await (async () => {
      const r = await stage.query<{ value: string }>(`select value from settings where key = 'public_app_url'`)
      const url = r.rows[0]?.value?.trim()
      if (!url) {
        throw new Error(
          `ABORT: the stage instance has no public_app_url setting, so its delivery webhooks cannot be ` +
            `identified. Without that, running would fan failed deliveries at a quiesced stage all run ` +
            `and eventually let Woo auto-disable stage's hooks (o3d-f737). Set it on stage and re-run.`,
        )
      }
      return url
    })()

    // The permanent hooks are a precondition, not something to create here. Assert them
    // rather than silently proceeding: without them nothing is delivered and every test
    // fails 5 minutes later with a confusing timeout. Checked BEFORE the claim so a
    // misconfigured store does not disable stage on its way to failing.
    await assertPermanentWebhooks(creds, appUrl)

    // The claim writes the record BEFORE anything is mutated, so a crash mid-acquire is still
    // recoverable. Recording the originals first is what makes release() truthful.
    const claimed = await claimLock(store, snapshot)
    held = { token, raw: claimed.raw }
    startHeartbeat(token, claimed.lock)

    await writeSettingsUnderPluginSelectionLock(
      stage,
      STAGE_SETTINGS_TO_DISABLE.map((key) => ({ key, value: 'false' })),
    )
    console.log(`[quiesce] stage disabled: ${STAGE_SETTINGS_TO_DISABLE.join(', ')}`)

    // Stage's own webhooks live in WOOCOMMERCE, so disabling its settings does not stop Woo delivering
    // to it — it only guarantees the delivery FAILS (o3d-f737). The statuses to put back are already in
    // the claim, written before this mutates anything, so a crash here still restores correctly.
    await pauseStageWebhooks(creds, claimed.lock.stageWebhooks ?? [])

    for (const key of E2E_SETTINGS_TO_ENABLE) {
      await e2e.query(
        `insert into settings (key, value, "updatedAt") values ($1, 'true', now())
           on conflict (key) do update set value = 'true', "updatedAt" = now()`,
        [key],
      )
    }
    console.log(`[quiesce] e2e armed for inbound webhooks: ${E2E_SETTINGS_TO_ENABLE.join(', ')}`)

    return { runId, deliveryUrlBase: `${appUrl.replace(/\/$/, '')}/api/webhooks/shopping/woocommerce`, token }
  } finally {
    await e2e.end(); await stage.end()
  }
}

/**
 * Restore the world from a lock record and drop the row.
 *
 * `guard` decides WHICH row may be deleted, and there are two callers with different evidence: recovery
 * knows the exact bytes it judged (`expect`), our own release knows its `token` (the heartbeat has been
 * rewriting the bytes all run). Deleting unconditionally is what let one run drop another's lock.
 * Returns false when the row moved on underneath us — the restore is idempotent, so that is a retry,
 * not a failure.
 */
async function releaseInternal(
  e2e: Client,
  stage: Client,
  lock: LockRecord,
  fencedRaw: string,
  store: LockStore,
): Promise<boolean> {
  // Delivery webhooks are PERMANENT and deliberately not touched here (o3d-lgo.10).
  // `createdWebhookIds` is only honoured for locks written by the older create-per-run
  // design, so an in-flight lock from before that change still cleans up correctly
  // rather than orphaning its hooks.
  // Collected here and thrown at the END: stage's SETTINGS must be restored either way, so a webhook
  // that will not come back cannot be allowed to skip them.
  let webhookRestoreFailure: string | null = null
  if (lock.stageWebhooks?.length) {
    // Before the settings restore: a hook put back while stage is still disabled simply fails once more,
    // whereas stage re-enabled with its hooks still paused is a store that silently stops importing.
    const creds = await wcCreds(e2e)
    const { failed } = await restoreStageWebhooks(creds, lock.stageWebhooks)
    if (failed.length) {
      webhookRestoreFailure =
        `could not restore ${failed.length} stage webhook(s): ` +
        failed.map((f) => `${f.id}->${f.status} (${f.error})`).join('; ')
    }
  }
  if (lock.createdWebhookIds?.length) {
    const creds = await wcCreds(e2e)
    for (const id of lock.createdWebhookIds) {
      try {
        // BOUNDED. This is the only remote call in a release, and an unbounded one is what would let a
        // release stall past the point where its fence can be recovered — after which its own settings
        // writes would land underneath a new owner (Codex, PR #560 round 5).
        await withDeadline(
          wcRequest(creds, `/webhooks/${id}?force=true`, { method: 'DELETE' }),
          WEBHOOK_DELETE_TIMEOUT_MS,
          `deleting legacy webhook ${id}`,
        )
        console.log(`[quiesce] deleted legacy per-run webhook ${id}`)
      } catch (e) {
        // Keep going: one undeletable hook must not strand stage's settings.
        console.warn(`[quiesce] could not delete webhook ${id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  // LAST CHECK BEFORE THE FIRST DAMAGING WRITE. Everything above is remote and bounded but not
  // instant; if our fence was recovered while we were in it, restoring stage now would put this run's
  // settings underneath whoever holds the lock. The final delete would catch it — but only after the
  // damage. Cheap to ask, and the answer is the difference between a no-op and a cross-run corruption.
  const stillOurs = await store.read()
  if (!stillOurs || stillOurs.raw !== fencedRaw) {
    throw new Error(
      `Abandoned this release before it wrote anything: our fence is gone — the lock was recovered ` +
        `while we were claiming it. NOTHING was restored, which is correct: stage is now ` +
        `${stillOurs ? `run ${stillOurs.lock.runId}'s` : "the next run's"} business.`,
    )
  }

  // A SERVER-SIDE deadline, not just a local one. Abandoning a promise leaves the query running, and a
  // restore write that resumes after another host has recovered our fence would re-enable stage
  // underneath that run (Codex, PR #560 round 6). statement_timeout makes Postgres cancel it instead.
  for (const [name, db] of [['stage', stage], ['e2e', e2e]] as const) {
    try {
      await db.query(`set statement_timeout = ${RESTORE_STATEMENT_TIMEOUT_MS}`)
    } catch (e) {
      // Swallowing this left the writes UNBOUNDED — the exact condition the timeout exists to prevent,
      // silently (Codex, PR #560 round 7). Better to restore nothing and say so: the lock stays fenced,
      // the next run recovers it after the releasing window, and the operator has an accurate error.
      throw new Error(
        `Refusing to restore: could not install a statement timeout on the ${name} connection ` +
          `(${e instanceof Error ? e.message : e}), so a stalled write could outlive this release fence ` +
          `and land underneath the next run. Nothing was restored; stage is still disabled.`,
      )
    }
  }

  // Under the SAME locks the disable took, and in one transaction: restoring stage puts
  // plugin_xero_enabled back, which is a connector switch as far as stage's orphan-cancel sweep is
  // concerned (o3d-osl8 round 6, finding 2).
  //
  // The session statement_timeout installed above applies to the lock wait too, deliberately: a
  // stage transaction holding the selection lock is a sweep deciding what to discard, and it is
  // measured in milliseconds. If we are still waiting after 20s something is wrong on stage, and
  // failing the release loudly — leaving the lock row in place for the next run to recover — is the
  // right outcome, not restoring underneath whatever is stuck.
  await writeSettingsUnderPluginSelectionLock(
    stage,
    Object.entries(lock.stageSettings).map(([key, value]) => ({ key, value })),
    (key, value) => console.log(`[quiesce] stage ${key} restored to ${value ?? '(absent)'}`),
  )

  // Between the two databases, ask again. The stage writes above are the ones that matter most and are
  // now done; re-checking here keeps the window in which a lost fence goes unnoticed as short as the
  // protocol allows without a distributed transaction we cannot have across two databases.
  const stillOursMidway = await store.read()
  if (!stillOursMidway || stillOursMidway.raw !== fencedRaw) {
    throw new Error(
      `Our release fence was lost MIDWAY: stage HAS been restored from this run's record, this instance ` +
        `has NOT been disarmed, and the lock row is now ` +
        `${stillOursMidway ? `run ${stillOursMidway.lock.runId}'s` : 'gone'}. Both instances need checking.`,
    )
  }

  // Put this instance back to disarmed, so nothing imports or posts between runs.
  // `?? {}` because a lock written before e2eSettings existed would otherwise throw
  // here and strand stage — recovery must never be brittler than what it recovers.
  for (const [key, value] of Object.entries(lock.e2eSettings ?? {})) {
    if (value === null) {
      await e2e.query(`delete from settings where key = $1`, [key])
      console.log(`[quiesce] e2e ${key} restored to (absent)`)
    } else {
      await e2e.query(
        `insert into settings (key, value, "updatedAt") values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
        [key, value],
      )
      console.log(`[quiesce] e2e ${key} restored to ${value}`)
    }
  }

  // A webhook we could not put back means the world is NOT restored, so the lock row must SURVIVE: it is
  // the only durable record of the original statuses, and deleting it would leave stage's hook paused
  // with nothing that knows better — the next run would snapshot `paused` as the baseline and preserve
  // the outage for ever (Codex, round 1). Stage's settings are already restored above, so the cost of
  // holding the row is bounded: the lease lapses and the next run takes over and inherits the record.
  if (webhookRestoreFailure) {
    throw new Error(
      `Stage's settings were restored, but ${webhookRestoreFailure}. The lock row is deliberately LEFT in ` +
        `place because it holds the only record of the original webhook statuses — the next run takes it ` +
        `over after the lease lapses and restores them. Re-activate the hook(s) by hand if you need stage ` +
        `importing before then (o3d-f737).`,
    )
  }

  // The row has been FENCED to us since before the first mutation above, so this cannot delete anyone
  // else's lock — it either removes our own fence or finds it already gone.
  return await store.deleteIfUnchanged(fencedRaw)
}

/**
 * Claim the exclusive right to restore, BEFORE restoring anything.
 *
 * releaseInternal used to check ownership only at the END: it deleted webhooks and put stage's settings
 * back, and only then ran the conditional delete. If the row had changed hands in between — a take-over,
 * or a forced release racing a live heartbeat — the delete failed, but the previous owner's settings had
 * already been restored underneath the new holder. That is the dual-driver condition the whole lock
 * exists to prevent, arriving through the exit instead of the entrance (Codex, PR #560 round 2).
 *
 * So the row is first compare-and-set into a RELEASING state. Winning that swap is what grants the right
 * to touch shared state; losing it means the lock is someone else's now and we touch nothing. The fence
 * stays in place while the restore runs, so the lock is never briefly absent — a contender that reads it
 * mid-restore sees a live-looking lock and backs off rather than starting a suite against a
 * half-restored stage.
 */
export async function fenceForRelease(
  store: LockStore,
  found: { raw: string; lock: LockRecord },
): Promise<string | null> {
  const fenced: LockRecord = { ...found.lock, releasing: true, heartbeatAt: new Date().toISOString() }
  const fencedRaw = JSON.stringify(fenced)
  return (await store.replaceIfUnchanged(found.raw, fencedRaw)) ? fencedRaw : null
}

/**
 * Release the lock this process took: restore stage, disarm this instance, drop the record.
 *
 * A NO-OP WHEN THIS PROCESS NEVER ACQUIRED, and that is the point rather than an edge case. Playwright
 * runs globalTeardown even when globalSetup THROWS, so the invocation that acquire() just refused arrives
 * here next — and the old unconditional release restored stage, cancelled the incumbent's queue and
 * deleted its lock while that suite was still running (o3d-lgo.14). Refusing to steal the lock at acquire
 * time is worth nothing if teardown gives it away.
 *
 * `force` is the manual escape hatch (scripts/restore-stage-connectors.ts): an operator restoring stage
 * after a crash legitimately releases a lock this process never took.
 */
export async function release(opts: { force?: boolean; expectRaw?: string; expectRunId?: string } = {}): Promise<void> {
  if (!held && !opts.force && !opts.expectRaw) {
    console.log('[quiesce] this process does not hold the quiesce lock — nothing to release.')
    return
  }

  // Stop renewing, and WAIT for a renewal already in flight. Clearing the interval does not cancel one
  // that has started, and it still writes: landing between our read and our fence it makes the fence
  // fail, so the release quietly does nothing and stage stays disabled (Codex, PR #560 round 3).
  const ourToken = held?.token ?? null
  stopHeartbeat()
  if (renewInFlight) await renewInFlight.catch(() => {})

  const e2e = e2eDb(); await e2e.connect()
  const stage = stageDb(); await stage.connect()
  try {
    const store = pgLockStore(e2e)
    const found = await store.read()
    if (!found) { console.log('[quiesce] no lock row — nothing to release.'); return }

    // The operator path judged a SPECIFIC row recoverable. Releasing "whatever is current" instead lets a
    // contender take the abandoned lock over in between and have stage restored underneath its running
    // suite — the exact fault this script exists to fix, by a TOCTOU (Codex, PR #560 round 3).
    if (opts.expectRaw && found.raw !== opts.expectRaw) {
      throw new Error(
        `Refused to release the quiesce lock: the row changed since it was judged recoverable — run ` +
          `${found.lock.runId} holds it now. NOTHING was restored, which is correct, but stage is still ` +
          `disabled as far as this process is concerned. Re-check with --status.`,
      )
    }

    // IDENTITY, EVEN UNDER --force. Forcing overrides the LIVENESS verdict — "I know that holder is
    // gone" — never the TARGET. If the inspected holder exits and a successor claims the lock before we
    // read it, an unpinned force would fence and delete the successor's LIVE lock and restore stage
    // beneath its suite (Codex, PR #560 round 4). Matching on the run id rather than the raw bytes is
    // what lets a heartbeat tick in between without spuriously refusing.
    if (opts.expectRunId && found.lock.runId !== opts.expectRunId) {
      throw new Error(
        `Refused to release the quiesce lock: you inspected run ${opts.expectRunId}, but run ` +
          `${found.lock.runId} holds it now — it was taken over between the check and this release. ` +
          `NOTHING was restored. Re-check with --status; forcing overrides the verdict, never the target.`,
      )
    }

    if (ourToken && found.lock.token !== ourToken) {
      // Someone else's lock. Restoring from it would put THEIR run's settings back mid-flight. Leaving
      // it alone is right — but this run must not report a clean finish: its lock was taken from under
      // it, its results are untrustworthy, and stage is disabled on somebody else's account now.
      throw new Error(
        `The quiesce lock now belongs to run ${found.lock.runId}, not to this process — it was recovered ` +
          `from under this run (see the LOST THE QUIESCE LOCK error above). Nothing was restored, ` +
          `correctly: stage is that run's responsibility now, and this run's results cannot be trusted.`,
      )
    }

    // FENCE FIRST, MUTATE SECOND. Winning this compare-and-set is what grants the right to restore
    // anything; losing it means the row moved on and nothing of ours may be written to the shared world.
    const fencedRaw = await fenceForRelease(store, found)
    if (!fencedRaw) {
      // Returning quietly here was reported as SUCCESS by both callers — teardown exited green and the
      // recovery script printed "Done." over an ongoing stage outage (Codex, PR #560 round 6). A release
      // that did not happen must never read as one.
      throw new Error(
        `Could not claim the release of the quiesce lock: the row changed between reading it and ` +
          `claiming it (run ${found.lock.runId}). NOTHING was restored — correct if another run took it ` +
          `over, but if nothing else is running then stage is STILL DISABLED. Check with --status.`,
      )
    }

    const dropped = await releaseInternal(e2e, stage, found.lock, fencedRaw, store)
    const how = ourToken ? '' : ' (forced)'
    if (!dropped) {
      // The fence is ours and renewals cannot overwrite it, so this should be unreachable — which is
      // exactly why it must not be logged as success. A row left behind means the next run finds a lock
      // it has to recover, and the operator needs to know stage was restored while one still exists.
      throw new Error(
        `The quiesce lock row survived the release: stage HAS been restored from run ${found.lock.runId}'s ` +
          `record, but the '${LOCK_KEY}' row could not be deleted. Inspect it — the next run will treat it ` +
          `as an abandoned lock and take it over, which is safe but should not be silent.`,
      )
    }
    console.log(`[quiesce] released${how}.`)
  } finally {
    held = null
    await e2e.end(); await stage.end()
  }
}

/** Report whether a lock is currently held (for diagnostics / the restore script). */
export async function status(): Promise<LockRecord | null> {
  return (await statusRaw())?.lock ?? null
}

/**
 * The lock row AND the exact bytes it holds.
 *
 * The raw value is what makes the operator path safe: the script judges THAT row recoverable and hands
 * it back to release(), which refuses if anything has changed since. Judging one row and then releasing
 * "whatever is current" lets a contender take the abandoned lock over in between.
 */
export async function statusRaw(): Promise<{ raw: string; lock: LockRecord; ageMs: number | null } | null> {
  const e2e = e2eDb(); await e2e.connect()
  try { return await pgLockStore(e2e).read() } finally { await e2e.end() }
}
