/**
 * Near-realtime draining of the shopping webhook inbox.
 *
 * Inbound WooCommerce/Shopify webhooks persist their event to the inbox and ACK
 * immediately (so WooCommerce/Shopify don't time out and retry). Historically the
 * inbox was only drained by the 5-minute cron, which made processing lag by up to
 * five minutes. After persisting a NEW event the handler now calls
 * `scheduleInboxDrain(connector)` to drain the inbox in (near) realtime.
 *
 * The drain is:
 *  - **non-blocking** — fired without await so the webhook response stays fast;
 *  - **debounced** — a burst of webhooks collapses into a single drain pass;
 *  - **single-flight** — overlapping triggers never spawn concurrent drains; an
 *    event that lands while a drain is running schedules exactly one re-run.
 *
 * Correctness does not depend on this: `claimEvent` atomically claims each event,
 * so the eager drain and the cron (and multiple server instances) can run
 * concurrently without double-processing. The cron remains the durability
 * backstop for retry/backoff, stale-claim recovery, and any kick lost to a
 * process restart between persist and drain.
 *
 * NOTE: this relies on the app running as a long-lived `next start` Node server,
 * where work scheduled after the response keeps running on the event loop. On a
 * serverless/edge runtime the post-response drain would be frozen — there you'd
 * need `waitUntil`, an external queue, or Postgres LISTEN/NOTIFY instead.
 */

const DEFAULT_DEBOUNCE_MS = 250

export type InboxDrainer = {
  /** Schedule a drain. Debounced unless `immediate` is set. */
  schedule: (options?: { debounceMs?: number; immediate?: boolean }) => void
  /** Resolves when the in-flight drain (if any) settles. Primarily for tests. */
  whenIdle: () => Promise<void>
}

export function createInboxDrainer(
  process: () => Promise<unknown>,
  config: { debounceMs?: number; onError?: (error: unknown) => void } = {},
): InboxDrainer {
  const debounceMsDefault = config.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let draining: Promise<void> | null = null
  let rerun = false

  function run() {
    // Single-flight: if a drain is already running, mark that another pass is
    // needed and let the current one loop again instead of starting a second.
    if (draining) {
      rerun = true
      return
    }
    draining = (async () => {
      try {
        do {
          rerun = false
          await process()
        } while (rerun)
      } catch (error) {
        config.onError?.(error)
      } finally {
        draining = null
      }
    })()
  }

  function schedule(options: { debounceMs?: number; immediate?: boolean } = {}) {
    if (options.immediate) {
      run()
      return
    }
    // Already scheduled within the debounce window — this event will be picked up
    // by the pending drain (it's already persisted to the inbox).
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      run()
    }, options.debounceMs ?? debounceMsDefault)
    // Don't let a pending drain timer keep the process alive on its own.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function whenIdle() {
    return draining ?? Promise.resolve()
  }

  return { schedule, whenIdle }
}

type ShoppingConnector = 'woocommerce' | 'shopify'

function warnDrainError(connector: ShoppingConnector, error: unknown) {
  console.warn('[shopping-webhook-inbox] eager drain failed', {
    connector,
    error: error instanceof Error ? error.message : String(error),
  })
}

// Dynamic imports of the processors keep this module free of a static import
// cycle with the connector webhook handlers (handlers import this module).
const drainers: Record<ShoppingConnector, InboxDrainer> = {
  woocommerce: createInboxDrainer(
    async () => (await import('@/lib/jobs/woocommerce/process-shopping-webhook-events')).processPendingWcWebhookEvents(),
    { onError: (error) => warnDrainError('woocommerce', error) },
  ),
  shopify: createInboxDrainer(
    async () => (await import('@/lib/jobs/shopify/process-shopping-webhook-events')).processPendingShopifyWebhookEvents(),
    { onError: (error) => warnDrainError('shopify', error) },
  ),
}

/**
 * Schedule a near-realtime drain of the shopping webhook inbox for a connector.
 * Call after persisting a newly-received event; safe to call on every event.
 */
export function scheduleInboxDrain(
  connector: ShoppingConnector,
  options?: { debounceMs?: number; immediate?: boolean },
): void {
  drainers[connector].schedule(options)
}
