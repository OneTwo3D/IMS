/**
 * WooCommerce side of the full-chain harness (o3d-lgo.4).
 *
 * Orders are created through the real WC REST API and delivered to the IMS by Woo's
 * OWN webhook — no hand-posted HMAC. That is the whole point of the tier: the existing
 * suite simulates the hop (woocommerce-xero-bundle-refund.spec.ts posts the payload
 * itself), so a broken webhook configuration is invisible to it. Stage's hooks had in
 * fact delivered nothing for ~3.5 days and no test noticed.
 *
 * awaitWebhookDelivery() therefore FAILS LOUDLY and never falls back to posting the
 * payload directly. A fallback would restore green tests and re-hide the exact class of
 * bug this tier exists to catch.
 */
import { Client } from 'pg'
import { runTag, taggedSku } from './tag.ts'

export type WcCreds = { url: string; key: string; secret: string; webhookSecret: string }

export async function wcCreds(): Promise<WcCreds> {
  const { decryptSettingValue, isEncryptedSettingValue } = await import('../../../lib/security/encrypted-settings.ts')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ key: string; value: string }>(
      `select key, value from settings
        where key in ('wc_url','wc_consumer_key','wc_consumer_secret','wc_webhook_secret')`,
    )
    const m = new Map(
      r.rows.map((x) => [x.key, isEncryptedSettingValue(x.value) ? decryptSettingValue(x.key, x.value) : x.value]),
    )
    const url = m.get('wc_url'), key = m.get('wc_consumer_key'), secret = m.get('wc_consumer_secret')
    if (!url || !key || !secret) throw new Error('WooCommerce credentials are not configured on this instance.')
    return { url: url.replace(/\/$/, ''), key, secret, webhookSecret: m.get('wc_webhook_secret') ?? '' }
  } finally {
    await db.end()
  }
}

export async function wcRequest<T = unknown>(c: WcCreds, path: string, init?: RequestInit): Promise<T> {
  const auth = Buffer.from(`${c.key}:${c.secret}`).toString('base64')
  const res = await fetch(`${c.url}/wp-json/wc/v3${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`WC ${init?.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 400)}`)
  }
  // Some WP installs prepend notices/whitespace before the JSON body.
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error(`WC ${path} returned a non-JSON body: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start)) as T
}

export type WcLineInput = { sku: string; quantity: number; price: string }

export type WcProduct = { id: number; sku: string; name: string; price: string }
export type WcOrder = { id: number; number: string; status: string; total: string; currency: string }

/** Create a simple, tagged product in Woo. */
export async function createWcProduct(
  c: WcCreds,
  runId: string,
  opts: { label: string; price: string; manageStock?: boolean; stock?: number },
): Promise<WcProduct> {
  const sku = taggedSku(runId, opts.label)
  const created = await wcRequest<WcProduct>(c, '/products', {
    method: 'POST',
    body: JSON.stringify({
      name: `${runTag(runId)} ${opts.label}`,
      type: 'simple',
      sku,
      regular_price: opts.price,
      manage_stock: opts.manageStock ?? false,
      stock_quantity: opts.stock,
      status: 'publish',
      catalog_visibility: 'hidden', // never surface test products to a shopper
    }),
  })
  createdProducts.push(created.id)
  return created
}

/**
 * Create an order in Woo.
 *
 * status defaults to 'processing' deliberately: wc_sync_order_statuses is
 * ["processing"], so an order in any other status is SILENTLY not imported. That
 * silence is a real trap — it presents as a webhook failure.
 */
export async function createWcOrder(
  c: WcCreds,
  runId: string,
  opts: {
    lines: Array<{ productId: number; quantity: number }>
    status?: string
    currency?: string
    setPaid?: boolean
    shipping?: { method_title: string; total: string }
    feeLines?: Array<{ name: string; total: string }>
    customerNote?: string
  },
): Promise<WcOrder> {
  const created = await wcRequest<WcOrder>(c, '/orders', {
    method: 'POST',
    body: JSON.stringify({
      status: opts.status ?? 'processing',
      currency: opts.currency,
      set_paid: opts.setPaid ?? true,
      customer_note: opts.customerNote ?? runTag(runId),
      billing: {
        first_name: 'E2E', last_name: runTag(runId), email: `e2e+${runId}@example.invalid`,
        address_1: '1 Test Street', city: 'Cambridge', postcode: 'CB1 1AA', country: 'GB',
      },
      shipping: {
        first_name: 'E2E', last_name: runTag(runId),
        address_1: '1 Test Street', city: 'Cambridge', postcode: 'CB1 1AA', country: 'GB',
      },
      line_items: opts.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
      shipping_lines: opts.shipping ? [{ method_id: 'flat_rate', ...opts.shipping }] : undefined,
      fee_lines: opts.feeLines,
    }),
  })
  createdOrders.push(created.id)
  return created
}

/** Refund an order in Woo. A refund fires order.updated (there is no refund topic). */
export async function refundWcOrder(
  c: WcCreds,
  orderId: number,
  opts: { amount: string; reason?: string; lineItems?: Array<{ id: number; quantity: number; refund_total: string }> },
): Promise<{ id: number; amount: string }> {
  return wcRequest(c, `/orders/${orderId}/refunds`, {
    method: 'POST',
    body: JSON.stringify({
      amount: opts.amount,
      reason: opts.reason ?? 'full-chain e2e',
      line_items: opts.lineItems,
      api_refund: false, // do not attempt a gateway refund on a test order
    }),
  })
}

export async function cancelWcOrder(c: WcCreds, orderId: number): Promise<WcOrder> {
  return wcRequest<WcOrder>(c, `/orders/${orderId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'cancelled' }),
  })
}

export type WcOrderDetail = WcOrder & {
  billing?: { first_name?: string; last_name?: string; email?: string }
  customer_note?: string
  meta_data?: Array<{ key: string; value: unknown }>
  line_items?: Array<{ id: number; sku: string; quantity: number; total: string }>
  refunds?: Array<{ id: number; total: string }>
}

export async function getWcOrder(c: WcCreds, orderId: number): Promise<WcOrderDetail> {
  return wcRequest<WcOrderDetail>(c, `/orders/${orderId}`)
}

/**
 * Kick WP-Cron so Action Scheduler drains queued webhook deliveries.
 *
 * Fire-and-forget: wp-cron.php can take seconds and we do not want to block the poll
 * loop on it, and a failed nudge is not itself a test failure — the next poll retries.
 */
async function nudgeWpCron(c: WcCreds): Promise<void> {
  try {
    // Give it room to finish. WordPress holds a `doing_cron` lock for ~60s, so nudges
    // are no-ops most of the time anyway; aborting the one request that DID win the
    // lock would leave the queue undrained for another minute.
    await fetch(`${c.url}/wp-cron.php?doing_wp_cron=${Date.now() / 1000}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    // Ignored on purpose: see above.
  }
}

/**
 * Wait for Woo's OWN webhook to land the order in the IMS.
 *
 * Fails with a diagnosis rather than a bare timeout, because "the order never arrived"
 * has several very different causes and the useful one is rarely the first guess:
 *   - the Action Scheduler stalled (stage's does — the runbook warns about it);
 *   - the order is in a status wc_sync_order_statuses does not import;
 *   - the order parked in the pending-FX quarantine (order-import.ts) and is NOT lost.
 */
export async function awaitWebhookDelivery(
  wcOrderId: number,
  opts: { timeoutMs?: number; pollMs?: number; creds?: WcCreds } = {},
): Promise<{ salesOrderId: string; orderNumber: string }> {
  // Measured, not guessed: on this store a delivery scheduled at 18:34:51 ran at
  // 18:37:56 — just over 3 MINUTES. Woo queues webhook delivery through Action
  // Scheduler, which runs off WP-Cron, which holds a ~60s lock and is visitor-triggered
  // on a store with no visitors. 180s timed out 5 seconds before the delivery landed.
  // This is the real latency of the real chain; do not tune it down without re-measuring.
  const timeoutMs = opts.timeoutMs ?? 300_000
  // 15s, not 3s: nudging faster cannot help (the cron lock swallows it) and each nudge
  // is a real HTTP request to the shared store.
  const pollMs = opts.pollMs ?? 15_000
  const creds = opts.creds ?? (await wcCreds())
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Nudge WP-Cron every poll. WooCommerce delivers webhooks ASYNCHRONOUSLY via
      // Action Scheduler, which on this store runs off WP-Cron (DISABLE_WP_CRON=false,
      // i.e. VISITOR-TRIGGERED). Stage has no visitors, so deliveries sit `pending`
      // indefinitely and the test times out on a store that is working perfectly. This
      // is the "Action Scheduler doesn't auto-drain" caveat in
      // docs/woocommerce-live-runbook.md — the cause is no traffic, not a stall.
      // Requesting wp-cron.php is exactly what a page view does, so this drives the
      // real delivery path rather than bypassing it.
      void nudgeWpCron(creds)
      const r = await db.query<{ id: string; orderNumber: string }>(
        `select so.id, so."orderNumber"
           from sales_orders so
           join shopping_order_links sol on sol."orderId" = so.id
          where sol."externalOrderId" = $1 and sol.connector = 'woocommerce'
          limit 1`,
        [String(wcOrderId)],
      )
      if (r.rows.length) return { salesOrderId: r.rows[0].id, orderNumber: r.rows[0].orderNumber }
      await new Promise((res) => setTimeout(res, pollMs))
    }

    // Diagnose before failing — a bare timeout sends people to the wrong place.
    const diag: string[] = []
    // The inbox is shopping_webhook_events (persistShoppingWebhookEvent); it is what
    // proves Woo actually delivered, as distinct from the IMS failing to import.
    const inbox = await db.query<{ topic: string; status: string; lastError: string | null; attempts: number }>(
      `select topic, status, "lastError", attempts from shopping_webhook_events
        where connector = 'woocommerce' and "payloadJson"::text like $1
        order by "receivedAt" desc limit 5`,
      [`%"id":${wcOrderId}%`],
    ).catch(() => ({ rows: [] as Array<{ topic: string; status: string; lastError: string | null; attempts: number }> }))
    if (inbox.rows.length) {
      diag.push(
        `Woo DID deliver — inbox rows: ${inbox.rows
          .map((x) => `${x.topic}=${x.status} (attempts ${x.attempts}${x.lastError ? `, last error: ${x.lastError}` : ''})`)
          .join('; ')}. So the failure is IMPORT, not delivery.`,
      )
    } else {
      // An empty inbox does NOT prove Woo failed to deliver, and saying so sends
      // people to the wrong place (it sent me to the Action Scheduler, which was
      // healthy). The route SILENTLY DISCARDS a webhook when its processing gate is
      // shut — getWebhookProcessingGate (webhooks.ts:316) requires
      // plugin_woocommerce_enabled AND wc_sync_enabled on THIS instance — and answers
      // 202 {skipped:true}, a SUCCESS code, so Woo never retries and the loss is
      // invisible from both ends. Check the gate before blaming delivery.
      const gate = await db.query<{ key: string; value: string }>(
        `select key, value from settings where key in ('plugin_woocommerce_enabled','wc_sync_enabled')`,
      ).catch(() => ({ rows: [] as Array<{ key: string; value: string }> }))
      const g = new Map(gate.rows.map((x) => [x.key, x.value]))
      const shut = ['plugin_woocommerce_enabled', 'wc_sync_enabled'].filter((k) => g.get(k) !== 'true')
      if (shut.length) {
        diag.push(
          `THE WEBHOOK PROCESSING GATE IS SHUT on this instance (${shut.map((k) => `${k}=${g.get(k) ?? '(unset)'}`).join(', ')}). ` +
            `The route accepts the delivery, answers 202 {skipped:true}, and DISCARDS it — so an empty inbox here means dropped, not undelivered. ` +
            `The quiesce lock is meant to arm wc_sync_enabled for the run window.`,
        )
      } else {
        diag.push(
          'Gate is open but nothing is in shopping_webhook_events — Woo did not deliver (or has not yet). ' +
            'Check from the WOO side, not this one: wp_actionscheduler_actions rows for ' +
            'hook=woocommerce_deliver_webhook_async carry {"webhook_id":N,"arg":<orderId>}. If they are ' +
            'PENDING the store is fine and nothing is draining the queue — Action Scheduler runs off ' +
            'WP-Cron, which is visitor-triggered (DISABLE_WP_CRON=false) and stage has no visitors. ' +
            'This harness nudges wp-cron.php on every poll for exactly that reason; if they are still ' +
            'pending, the nudge is failing. If there are no rows at all, the webhook is not active or ' +
            'its topic does not fire for this event.',
        )
      }
    }
    // Pending-FX quarantine lives in shopping_sync_logs (pendingFxQueueWhere).
    const parked = await db.query<{ count: string }>(
      `select count(*)::text as count from shopping_sync_logs where "externalId" = $1`,
      [String(wcOrderId)],
    ).catch(() => ({ rows: [{ count: '0' }] }))
    if (parked.rows[0]?.count !== '0') {
      diag.push(
        'This order has shopping_sync_logs rows — it may be PARKED in the pending-FX quarantine, not lost (order-import.ts retryPendingWcOrdersWaitingForFx drains it).',
      )
    }
    throw new Error(
      `WC order ${wcOrderId} did not reach the IMS within ${timeoutMs}ms.\n  ${diag.join('\n  ')}\n` +
        `  NOT falling back to a hand-posted webhook: proving Woo's own delivery works is the point of this tier.`,
    )
  } finally {
    await db.end()
  }
}

// What this run created, so teardown can delete it by id.
const createdOrders: number[] = []
const createdProducts: number[] = []

/**
 * Delete everything this run created in Woo, BY ID.
 *
 * Deliberately not `/orders?search=<tag>`: the stage store holds 160k+ orders and that
 * search scans them all — it hung a run for minutes with the quiesce lock held, which
 * is far worse than the residue it was cleaning. Ids are exact, instant, and cannot
 * match somebody else's order.
 *
 * Best-effort per item: one undeletable product must not strand the rest, and cleanup
 * must never mask the test failure that matters.
 */
export async function cleanupWc(c: WcCreds, _runId?: string): Promise<void> {
  for (const id of createdOrders.splice(0)) {
    await wcRequest(c, `/orders/${id}?force=true`, { method: 'DELETE' }).catch((e) =>
      console.warn(`[wc-cleanup] order ${id}: ${e instanceof Error ? e.message : e}`))
  }
  for (const id of createdProducts.splice(0)) {
    await wcRequest(c, `/products/${id}?force=true`, { method: 'DELETE' }).catch((e) =>
      console.warn(`[wc-cleanup] product ${id}: ${e instanceof Error ? e.message : e}`))
  }
}

/**
 * Sweep residue from EARLIER runs whose teardown never ran. Slow (it searches), so it
 * is opt-in and never part of a normal run's teardown.
 */
export async function sweepOldWcArtefacts(c: WcCreds, tagPrefix = 'E2E-FC'): Promise<number> {
  let removed = 0
  const orders = await wcRequest<Array<{ id: number }>>(c, `/orders?search=${encodeURIComponent(tagPrefix)}&per_page=100`)
  for (const o of orders) {
    await wcRequest(c, `/orders/${o.id}?force=true`, { method: 'DELETE' }).then(() => removed++).catch(() => {})
  }
  const products = await wcRequest<Array<{ id: number }>>(c, `/products?search=${encodeURIComponent(tagPrefix)}&per_page=100`)
  for (const p of products) {
    await wcRequest(c, `/products/${p.id}?force=true`, { method: 'DELETE' }).then(() => removed++).catch(() => {})
  }
  return removed
}
