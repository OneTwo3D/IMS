/**
 * THE ONE HTTP BOUNDARY FOR EVERY WOOCOMMERCE REQUEST (o3d-zvec.3).
 *
 * Every outbound WooCommerce call — the WC REST API in ./api.ts, the signed helper-plugin routes
 * (partial-shipment, FX push, FX probe) and the read-only order fetch in ./delivery.ts — goes
 * through this function instead of calling `connectorFetch` directly. Two reasons:
 *
 *  - the writeback fence is applied HERE, so it covers every mutating request by CONSTRUCTION. A
 *    writeback path added next month is fenced because it cannot reach WooCommerce any other way,
 *    not because whoever wrote it remembered a helper. tests/wc-writeback-fence-coverage.test.ts
 *    asserts that no other file in this connector imports the raw client, which is the part that
 *    keeps "by construction" true;
 *  - `connectorName: 'WooCommerce'` stops being copied into eleven call sites.
 *
 * Reads are NOT fenced. A GET cannot produce a duplicate partial shipment or a duplicate customer
 * email, and fencing the order import would make an undeclared installation useless rather than
 * safe — which is how a control gets switched off.
 */

import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { logActivity } from '@/lib/activity-log'

import {
  evaluateWcWritebackFence,
  isWcWritebackMutation,
  type WcWritebackRefusalCode,
} from './writeback-fence'

export const WC_CONNECTOR_NAME = 'WooCommerce'

/** Thrown instead of connecting. Carries the two origins so callers can report them verbatim. */
export class WooCommerceWritebackRefusedError extends Error {
  readonly code: WcWritebackRefusalCode
  readonly declaredOrigin: string | null
  readonly attemptedOrigin: string | null

  constructor(params: {
    message: string
    code: WcWritebackRefusalCode
    declaredOrigin: string | null
    attemptedOrigin: string | null
  }) {
    super(params.message)
    this.name = 'WooCommerceWritebackRefusedError'
    this.code = params.code
    this.declaredOrigin = params.declaredOrigin
    this.attemptedOrigin = params.attemptedOrigin
  }
}

export function isWooCommerceWritebackRefusal(error: unknown): error is WooCommerceWritebackRefusedError {
  return error instanceof WooCommerceWritebackRefusedError
}

export type WooCommerceRequestMeta = {
  /**
   * WHICH writeback path this is, in operator words ("partial-shipment push", "order status
   * push"). It is the attribution half of the activity-log entry: "something was refused" is not
   * actionable, "the tracking push to the wrong store was refused" is.
   */
  purpose: string
  /** Overridable for tests; production always reads the real process environment. */
  env?: Record<string, string | undefined>
} & Omit<ConnectorFetchOptions, 'connectorName'>

/**
 * A refused request is recorded in the activity log AND on stderr.
 *
 * Both, on purpose. The activity log is where an operator looks and is the durable record, but it
 * needs a database; a cron run against a broken or absent database would otherwise refuse in total
 * silence, which is the failure mode this exists to prevent. `logActivity` never throws.
 */
async function recordRefusal(
  meta: WooCommerceRequestMeta,
  method: string,
  targetUrl: URL | null,
  verdict: { code: WcWritebackRefusalCode; declaredOrigin: string | null; attemptedOrigin: string | null; message: string },
): Promise<void> {
  const description = `${verdict.message} (path: ${method} ${targetUrl?.pathname ?? '(unparseable)'}, purpose: ${meta.purpose})`
  console.error('[wc-writeback-fence] refused', {
    purpose: meta.purpose,
    method,
    code: verdict.code,
    declaredOrigin: verdict.declaredOrigin,
    attemptedOrigin: verdict.attemptedOrigin,
  })
  await logActivity({
    entityType: 'SYNC',
    action: 'WOOCOMMERCE_WRITEBACK_REFUSED',
    tag: 'woocommerce-writeback-fence',
    level: 'ERROR',
    description,
    resolveUser: false,
    metadata: {
      code: verdict.code,
      purpose: meta.purpose,
      method,
      requestPath: targetUrl?.pathname ?? null,
      attemptedOrigin: verdict.attemptedOrigin,
      declaredOrigin: verdict.declaredOrigin,
    },
  })
}

/**
 * `connectorFetch` for WooCommerce, with the writeback fence in front of every mutating request.
 *
 * Throws `WooCommerceWritebackRefusedError` — it does not return a failed `Response` — so a caller
 * that forgets to handle it fails loudly instead of recording an ordinary HTTP failure it will
 * retry for ever. Nothing is sent: the refusal happens before the URL reaches the HTTP client, so
 * no connection, no DNS lookup and no credential leaves the process.
 */
export async function wooCommerceConnectorFetch(
  input: string | URL,
  init: RequestInit = {},
  meta: WooCommerceRequestMeta,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()

  if (isWcWritebackMutation(init.method)) {
    let targetUrl: URL | null = null
    try {
      targetUrl = input instanceof URL ? input : new URL(String(input))
    } catch {
      targetUrl = null
    }

    const verdict = evaluateWcWritebackFence(targetUrl ?? String(input), meta.env ?? process.env)
    if (!verdict.allowed) {
      await recordRefusal(meta, method, targetUrl, verdict)
      throw new WooCommerceWritebackRefusedError({
        message: verdict.message,
        code: verdict.code,
        declaredOrigin: verdict.declaredOrigin,
        attemptedOrigin: verdict.attemptedOrigin,
      })
    }
  }

  const { purpose: _purpose, env: _env, ...fetchOptions } = meta
  return connectorFetch(input, init, { ...fetchOptions, connectorName: WC_CONNECTOR_NAME })
}
