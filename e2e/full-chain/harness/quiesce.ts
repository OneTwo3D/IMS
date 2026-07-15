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
import { Client } from 'pg'

const LOCK_KEY = 'e2e_quiesce_lock'

/** Stage settings that must be false while the rig runs. */
const STAGE_SETTINGS_TO_DISABLE = [
  'wc_sync_enabled',
  'plugin_xero_enabled',
  'xero_sync_enabled',
  'xero_daily_batch_enabled',
  'xero_payment_polling_enabled',
] as const

export type WebhookSpec = { topic: string; resource: 'orders' | 'refunds' }

/**
 * Topics the suite needs delivered to this instance.
 *
 * THERE IS NO REFUND TOPIC IN WOOCOMMERCE CORE. Attempting one returns
 * `woocommerce_rest_shop_webhook_invalid_topic`. A refund fires `order.updated`:
 * class-wc-webhook.php maps 'order.updated' => ['woocommerce_update_order',
 * 'woocommerce_order_refunded']. The IMS then picks the refund up because
 * handleOrderWebhook calls syncRefundsForOrder() (webhooks.ts:190). So OC-05/OC-06
 * are covered by order.updated and need no extra hook.
 *
 * (webhooks.ts:131 does handle a 'refund.created' topic on the /refunds resource,
 * but core Woo cannot emit it — that path only fires if something registers a custom
 * topic.)
 */
export const REQUIRED_WEBHOOKS: WebhookSpec[] = [
  { topic: 'order.created', resource: 'orders' },
  { topic: 'order.updated', resource: 'orders' },
]

type LockRecord = {
  takenAt: string
  runId: string
  stageSettings: Record<string, string | null>
  createdWebhookIds: number[]
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
    // Recover first, unconditionally. A stale lock means stage is still disabled.
    const stale = await readLock(e2e)
    if (stale) {
      console.warn(`[quiesce] STALE LOCK from ${stale.takenAt} (run ${stale.runId}) — restoring stage before starting.`)
      await releaseInternal(e2e, stage, stale)
    }

    const prior: Record<string, string | null> = {}
    for (const key of STAGE_SETTINGS_TO_DISABLE) {
      const r = await stage.query<{ value: string }>(`select value from settings where key = $1`, [key])
      prior[key] = r.rows.length ? r.rows[0].value : null
    }

    const creds = await wcCreds(e2e)
    const base = `${appUrl.replace(/\/$/, '')}/api/webhooks/shopping/woocommerce`

    // Write the lock BEFORE mutating anything, so a crash mid-acquire is still
    // recoverable. Recording `prior` first is what makes release() truthful.
    const lock: LockRecord = { takenAt: new Date().toISOString(), runId, stageSettings: prior, createdWebhookIds: [] }
    await writeLock(e2e, lock)

    for (const key of STAGE_SETTINGS_TO_DISABLE) {
      await stage.query(
        `insert into settings (key, value, "updatedAt") values ($1, 'false', now())
           on conflict (key) do update set value = 'false', "updatedAt" = now()`,
        [key],
      )
    }
    console.log(`[quiesce] stage disabled: ${STAGE_SETTINGS_TO_DISABLE.join(', ')}`)

    for (const w of REQUIRED_WEBHOOKS) {
      const created = await wcRequest<{ id: number }>(creds, '/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          name: `E2E full-chain ${runId} ${w.topic}`,
          topic: w.topic,
          delivery_url: `${base}/${w.resource}`,
          status: 'active',
          secret: creds.webhookSecret,
        }),
      })
      lock.createdWebhookIds.push(created.id)
      await writeLock(e2e, lock) // persist after EACH create, so none can be orphaned
      console.log(`[quiesce] webhook ${created.id} ${w.topic} -> ${base}/${w.resource}`)
    }

    return { runId, deliveryUrlBase: base }
  } finally {
    await e2e.end(); await stage.end()
  }
}

async function releaseInternal(e2e: Client, stage: Client, lock: LockRecord): Promise<void> {
  // Webhooks first: they are the thing pointing at us. force=true because Woo
  // otherwise moves them to trash and a trashed hook still occupies its topic slot.
  if (lock.createdWebhookIds.length) {
    const creds = await wcCreds(e2e)
    for (const id of lock.createdWebhookIds) {
      try {
        await wcRequest(creds, `/webhooks/${id}?force=true`, { method: 'DELETE' })
        console.log(`[quiesce] deleted webhook ${id}`)
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
