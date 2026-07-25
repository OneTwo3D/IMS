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
 */
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

type LockRecord = {
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
}

/** Just the ownership fields the liveness check reads, so it can be exercised without a whole lock record. */
export type LockOwner = { ownerPid?: number; ownerHost?: string }

/**
 * How long a lock with no provable owner may sit before recovery treats it as abandoned.
 *
 * A full-chain invocation is minutes, and the longest single test sets a 15-minute timeout, so 45 minutes is
 * far beyond any legitimate hold while still recovering automatically from a crash nobody is watching.
 */
export const LOCK_STALE_AFTER_MS = 45 * 60_000

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

async function readLock(db: Client): Promise<LockRecord | null> {
  const r = await db.query<{ value: string }>(`select value from settings where key = $1`, [LOCK_KEY])
  if (!r.rows.length) return null
  try {
    return JSON.parse(r.rows[0].value) as LockRecord
  } catch {
    // A corrupt lock must not be silently discarded: it means stage may still be
    // disabled with no record of the originals.
    throw new Error(
      `The quiesce lock row (${LOCK_KEY}) is present but unparseable. Stage may still be ` +
        `disabled. Inspect it and restore stage by hand before continuing.`,
    )
  }
}

async function writeLock(db: Client, lock: LockRecord | null): Promise<void> {
  if (lock === null) {
    await db.query(`delete from settings where key = $1`, [LOCK_KEY])
    return
  }
  await db.query(
    `insert into settings (key, value, "updatedAt") values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
    [LOCK_KEY, JSON.stringify(lock)],
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

export type QuiesceHandle = { runId: string; deliveryUrlBase: string }

/**
 * Take the lock: recover any stale one, disable stage, create delivery webhooks.
 * Safe to call when a previous run crashed — that is the point.
 */
export async function acquire(runId: string): Promise<QuiesceHandle> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set — webhooks would have nowhere to deliver.')

  const e2e = e2eDb(); await e2e.connect()
  const stage = stageDb(); await stage.connect()
  try {
    // Recover a DEAD lock; refuse to steal a LIVE one.
    //
    // This used to recover unconditionally, on the reasoning that a lock present at acquire time must be
    // stale because stage is still disabled. That is right for the crash it was written for and wrong for a
    // second concurrent invocation: the newcomer restored the stage settings the first run was still relying
    // on, and both then drove the one Woo store and the one Xero Demo org at once (o3d-lgo.14). The operating
    // model has always been one invocation at a time; now it is enforced rather than assumed.
    const existing = await readLock(e2e)
    if (existing) {
      const alive = isLockOwnerAlive(existing)
      const ageMs = Date.now() - Date.parse(existing.takenAt)
      const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 60_000)}m old` : `takenAt unparseable (${existing.takenAt})`
      if (alive === true) {
        throw new Error(
          `ABORT: the quiesce lock is held by a LIVE run — pid ${existing.ownerPid} on ${existing.ownerHost}, ` +
            `run ${existing.runId}, ${age}. The suite shares ONE Woo store and ONE Xero Demo org, so a second ` +
            `concurrent invocation would corrupt both runs. Wait for it, or kill that process and re-run ` +
            `(the lock then recovers automatically).`,
        )
      }
      if (alive === null && Number.isFinite(ageMs) && ageMs < LOCK_STALE_AFTER_MS) {
        throw new Error(
          `ABORT: the quiesce lock (run ${existing.runId}, ${age}) has no provable owner` +
            `${existing.ownerHost ? ` — it was taken on ${existing.ownerHost}, not this host` : ' (written by an older build)'}` +
            `, and is too recent to assume abandoned. It auto-recovers once it is older than ` +
            `${Math.round(LOCK_STALE_AFTER_MS / 60_000)}m; if you know the holder is gone, delete the ` +
            `'${LOCK_KEY}' settings row on the e2e instance (release() restores stage from the record, so ` +
            `prefer letting it recover).`,
        )
      }
      console.warn(
        `[quiesce] recovering an ABANDONED lock from ${existing.takenAt} (run ${existing.runId}, ${age}, ` +
          `${alive === false ? `owner pid ${existing.ownerPid} is gone` : 'no provable owner and past the staleness window'}) ` +
          `— restoring stage before starting.`,
      )
      await releaseInternal(e2e, stage, existing)
    }

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

    const creds = await wcCreds(e2e)

    // The permanent hooks are a precondition, not something to create here. Assert them
    // rather than silently proceeding: without them nothing is delivered and every test
    // fails 5 minutes later with a confusing timeout.
    await assertPermanentWebhooks(creds, appUrl)

    // Write the lock BEFORE mutating anything, so a crash mid-acquire is still
    // recoverable. Recording `prior` first is what makes release() truthful.
    const lock: LockRecord = {
      takenAt: new Date().toISOString(),
      runId,
      // Owner identity, so the next acquire can tell a live run from a crash (o3d-lgo.14).
      ownerPid: process.pid,
      ownerHost: hostname(),
      stageSettings: prior,
      e2eSettings: priorE2e,
      createdWebhookIds: [],
    }
    await writeLock(e2e, lock)

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

    return { runId, deliveryUrlBase: `${appUrl.replace(/\/$/, '')}/api/webhooks/shopping/woocommerce` }
  } finally {
    await e2e.end(); await stage.end()
  }
}

async function releaseInternal(e2e: Client, stage: Client, lock: LockRecord): Promise<void> {
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

  await writeLock(e2e, null)
}

/** Release the lock: delete our webhooks, restore stage, drop the record. */
export async function release(): Promise<void> {
  const e2e = e2eDb(); await e2e.connect()
  const stage = stageDb(); await stage.connect()
  try {
    const lock = await readLock(e2e)
    if (!lock) { console.log('[quiesce] no lock held — nothing to release.'); return }
    await releaseInternal(e2e, stage, lock)
    console.log('[quiesce] released.')
  } finally {
    await e2e.end(); await stage.end()
  }
}

/** Report whether a lock is currently held (for diagnostics / the restore script). */
export async function status(): Promise<LockRecord | null> {
  const e2e = e2eDb(); await e2e.connect()
  try { return await readLock(e2e) } finally { await e2e.end() }
}
