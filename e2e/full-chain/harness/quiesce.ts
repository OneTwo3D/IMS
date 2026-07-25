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
import { hostname } from 'node:os'

import { Client } from 'pg'
import type { WcCreds } from './wc.ts'

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
   * Owner identity, so a LIVE holder can be told apart from the crash this lock's recovery was built for
   * (o3d-lgo.14). Optional: a lock written by an older build has neither, and is judged on age alone.
   */
  ownerPid?: number
  ownerHost?: string
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
}

/** Just the ownership fields the liveness check reads, so it can be exercised without a whole lock record. */
export type LockOwner = { ownerPid?: number; ownerHost?: string }

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
  try {
    process.kill(lock.ownerPid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? true : false
  }
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
export function lockRecoveryDecision(lock: LockRecord, nowMs = Date.now()): RecoveryDecision {
  const alive = isLockOwnerAlive(lock)
  const who = `run ${lock.runId}${lock.ownerHost ? ` on ${lock.ownerHost}` : ''}${lock.ownerPid ? ` (pid ${lock.ownerPid})` : ''}`

  if (alive === true) {
    return { action: 'held', reason: `${who} is a LIVE process on this host` }
  }
  if (alive === false) {
    return { action: 'recover', reason: `${who} is gone — its pid does not exist on this host` }
  }

  // Unknowable owner: the lease is the only evidence.
  if (lock.heartbeatAt) {
    const sinceMs = nowMs - Date.parse(lock.heartbeatAt)
    if (!Number.isFinite(sinceMs)) {
      return { action: 'wait', reason: `${who} has an unparseable heartbeat (${lock.heartbeatAt})` }
    }
    const since = `${Math.round(sinceMs / 1000)}s since its last renewal`
    return sinceMs > LEASE_TTL_MS
      ? { action: 'recover', reason: `${who} stopped renewing its lease — ${since}, past the ${Math.round(LEASE_TTL_MS / 1000)}s TTL` }
      : { action: 'held', reason: `${who} is renewing its lease — ${since}` }
  }

  // Legacy lock (pre-heartbeat): age is all there is.
  const ageMs = nowMs - Date.parse(lock.takenAt)
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
  /** The current row, raw text and parsed, or null if unlocked. */
  read(): Promise<{ raw: string; lock: LockRecord } | null>
  /** Replace ONLY if the row still reads exactly as `expected` (compare-and-set take-over). */
  replaceIfUnchanged(expected: string, raw: string): Promise<boolean>
  /** Delete ONLY if the row still reads exactly as `expected` (compare-and-set, for the forced release). */
  deleteIfUnchanged(expected: string): Promise<boolean>
  /** Delete ONLY if the row still carries `token` (for our own release; the heartbeat rewrites `raw`). */
  deleteIfOwned(token: string): Promise<boolean>
  /** Overwrite ONLY if the row still carries `token`. false means we no longer hold the lock. */
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
      const r = await db.query<{ value: string }>(`select value from settings where key = $1`, [key])
      if (!r.rows.length) return null
      return { raw: r.rows[0].value, lock: parseLock(r.rows[0].value) }
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
      const r = await db.query(
        `update settings set value = $2, "updatedAt" = now()
          where key = $1 and value::jsonb ->> 'token' = $3`,
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

    const decision = lockRecoveryDecision(found.lock, now())
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
    const takeover: LockRecord = {
      ...mine,
      stageSettings: inherited,
      e2eSettings: inheritedE2e,
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
/** When we last PROVED we still own the row. Not when we last tried. */
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
 * Keep the lease alive while the suite runs.
 *
 * unref'd so it can never hold the process open on its own, and guarded on our token. Losing the row is
 * not just a reason to skip teardown — see leaseVerdict: the run itself has to stop.
 */
function startHeartbeat(token: LockToken, lock: LockRecord): void {
  leaseProvenAt = Date.now()
  heartbeat = setInterval(() => {
    void (async () => {
      // Its own short-lived connection each time. acquire()'s clients are closed when it returns, and an
      // idle one held open for the whole suite is worse than reconnecting every 30 seconds.
      const db = e2eDb()
      let ownershipLost = false
      try {
        await db.connect()
        const renewed: LockRecord = { ...lock, heartbeatAt: new Date().toISOString() }
        const raw = JSON.stringify(renewed)
        if (await pgLockStore(db).writeIfOwned(token, raw)) {
          leaseProvenAt = Date.now()
          if (held) held = { token, raw }
          return
        }
        ownershipLost = true
        console.error(
          `\n[quiesce] *** LOST THE QUIESCE LOCK *** run ${lock.runId} no longer owns '${LOCK_KEY}' — it was ` +
            `recovered or deleted while this run is still going. Stage settings are now another run's ` +
            `responsibility, so this run will NOT restore them.\n`,
        )
      } catch (e) {
        // A renewal that fails is not yet a lost lease — there is slack by design — but it is not proof
        // of ownership either, and the clock below is what decides when the slack runs out.
        console.warn(`[quiesce] lease renewal failed (will retry): ${e instanceof Error ? e.message : e}`)
      } finally {
        await db.end().catch(() => {})
      }

      const msSinceProven = Date.now() - leaseProvenAt
      if (leaseVerdict({ ownershipLost, msSinceProven }) === 'stop') {
        held = null
        stopHeartbeat()
        onLeaseLost(
          ownershipLost
            ? `the quiesce lock was taken over by another run (${lock.runId} no longer owns it)`
            : `the quiesce lock lease could not be renewed for ${Math.round(msSinceProven / 1000)}s, ` +
              `within ${Math.round(LEASE_RENEW_INTERVAL_MS / 1000)}s of the ${Math.round(LEASE_TTL_MS / 1000)}s TTL ` +
              `at which another run may recover it`,
        )
      }
    })()
  }, LEASE_RENEW_INTERVAL_MS)
  heartbeat.unref()
}

function stopHeartbeat(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
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
        token,
        heartbeatAt: takenAt,
        stageSettings: prior,
        e2eSettings: priorE2e,
        createdWebhookIds: [],
      }
    }

    const creds = await wcCreds(e2e)

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

    for (const key of STAGE_SETTINGS_TO_DISABLE) {
      await stage.query(
        `insert into settings (key, value, "updatedAt") values ($1, 'false', now())
           on conflict (key) do update set value = 'false', "updatedAt" = now()`,
        [key],
      )
    }
    console.log(`[quiesce] stage disabled: ${STAGE_SETTINGS_TO_DISABLE.join(', ')}`)

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
  guard: { store: LockStore; expect: string } | { store: LockStore; token: string },
): Promise<boolean> {
  // Delivery webhooks are PERMANENT and deliberately not touched here (o3d-lgo.10).
  // `createdWebhookIds` is only honoured for locks written by the older create-per-run
  // design, so an in-flight lock from before that change still cleans up correctly
  // rather than orphaning its hooks.
  if (lock.createdWebhookIds?.length) {
    const creds = await wcCreds(e2e)
    for (const id of lock.createdWebhookIds) {
      try {
        await wcRequest(creds, `/webhooks/${id}?force=true`, { method: 'DELETE' })
        console.log(`[quiesce] deleted legacy per-run webhook ${id}`)
      } catch (e) {
        // Keep going: one undeletable hook must not strand stage's settings.
        console.warn(`[quiesce] could not delete webhook ${id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  for (const [key, value] of Object.entries(lock.stageSettings)) {
    if (value === null) {
      await stage.query(`delete from settings where key = $1`, [key])
      console.log(`[quiesce] stage ${key} restored to (absent)`)
    } else {
      await stage.query(
        `insert into settings (key, value, "updatedAt") values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
        [key, value],
      )
      console.log(`[quiesce] stage ${key} restored to ${value}`)
    }
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

  return 'token' in guard
    ? await guard.store.deleteIfOwned(guard.token)
    : await guard.store.deleteIfUnchanged(guard.expect)
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
export async function release(opts: { force?: boolean } = {}): Promise<void> {
  if (!held && !opts.force) {
    console.log('[quiesce] this process does not hold the quiesce lock — nothing to release.')
    return
  }

  const e2e = e2eDb(); await e2e.connect()
  const stage = stageDb(); await stage.connect()
  try {
    const store = pgLockStore(e2e)
    const found = await store.read()
    if (!found) { console.log('[quiesce] no lock row — nothing to release.'); return }

    if (!held) {
      // force: no token to match, so delete exactly the row we just read and judged. The compare-and-set
      // is the only thing standing between an operator and a live run here, and it is checked AFTER the
      // restore — so a failure means stage may now be armed underneath somebody. Say so plainly rather
      // than printing "released" over it.
      const dropped = await releaseInternal(e2e, stage, found.lock, { store, expect: found.raw })
      if (dropped) {
        console.log('[quiesce] released (forced).')
      } else {
        console.error(
          `\n[quiesce] *** THE LOCK CHANGED HANDS MID-RELEASE *** run ${found.lock.runId}'s row was rewritten ` +
            `(a heartbeat renewal, or another run taking over) while this forced release was restoring stage. ` +
            `The row was NOT deleted — but stage settings HAVE been restored, possibly underneath a live run. ` +
            `Re-check with --status before doing anything else.\n`,
        )
      }
      return
    }

    if (found.lock.token !== held.token) {
      // Someone else's lock. Restoring from it would put THEIR run's settings back mid-flight.
      console.warn(
        `[quiesce] the lock row belongs to run ${found.lock.runId} (token mismatch), not to this process — ` +
          `leaving it alone. Ours was recovered from under us; see the LOST THE QUIESCE LOCK error above.`,
      )
      return
    }

    const dropped = await releaseInternal(e2e, stage, found.lock, { store, token: held.token })
    console.log(dropped ? '[quiesce] released.' : '[quiesce] released; the row had already gone.')
  } finally {
    stopHeartbeat()
    held = null
    await e2e.end(); await stage.end()
  }
}

/** Report whether a lock is currently held (for diagnostics / the restore script). */
export async function status(): Promise<LockRecord | null> {
  const e2e = e2eDb(); await e2e.connect()
  try { return await readLock(e2e) } finally { await e2e.end() }
}
