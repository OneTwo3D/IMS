import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { importWcOrder } from '@/lib/connectors/woocommerce/sync/order-import'
import { syncWcOrderStatus } from '@/lib/connectors/woocommerce/sync/order-status'
import { syncRefundsForOrder, syncWcRefund } from '@/lib/connectors/woocommerce/sync/refund-sync'
import { shouldSuppressWcOrderWebhookEcho } from '@/lib/connectors/woocommerce/sync/order-webhook-echo'
import { syncWcProductToIms } from '@/lib/connectors/woocommerce/sync/product-sync'
import {
  enqueueAndProcessImmediateWcStockSync,
  recordIncomingWcWebhook,
  shouldSuppressWcWebhookEcho,
} from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import type { WcFullOrder, WcFullProduct, WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import type { ShoppingWebhookResource } from '@/lib/shopping'

type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse }

/** @internal Test-only dependency injection for webhook unit tests. */
export type WcWebhookDependencies = {
  getMaintenanceModeResponse: (kind: 'cron' | 'webhook') => Promise<NextResponse | null>
  verifyWebhook: (body: string, signature: string | null) => Promise<boolean>
  recordWebhookReceipt: (resource: ShoppingWebhookResource) => Promise<void>
  handleOrderWebhook: (payload: unknown, topic: string | null) => Promise<Response>
  handleProductWebhook: (payload: unknown) => Promise<Response>
  handleRefundWebhook: (payload: unknown) => Promise<Response>
}

function parseWebhookJson<T>(body: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(body) as T }
  } catch (error) {
    console.warn('[woocommerce-webhook] JSON parse failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Malformed JSON body' }, { status: 400 }),
    }
  }
}

async function recordWebhookReceipt(resource: ShoppingWebhookResource) {
  const receivedAt = new Date().toISOString()
  const keys = ['wc_webhook_last_received_at']

  if (resource === 'orders') keys.push('wc_order_webhook_last_received_at')
  if (resource === 'products') keys.push('wc_product_webhook_last_received_at')

  await Promise.all(
    keys.map((key) =>
      db.setting.upsert({
        where: { key },
        create: { key, value: receivedAt },
        update: { value: receivedAt },
      }),
    ),
  )
}

function getWebhookHeaders(request: Request) {
  return {
    signature: request.headers.get('x-wc-webhook-signature'),
    topic: request.headers.get('x-wc-webhook-topic'),
  }
}

function isWebhookPing(signature: string | null, topic: string | null) {
  return !signature && !topic
}

function isSignedActionPing(topic: string | null) {
  return !!topic && topic.startsWith('action.')
}

async function advanceWcOrderSyncCursor() {
  await db.setting.upsert({
    where: { key: 'last_wc_order_sync_at' },
    create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
}

async function handleOrderWebhook(payload: unknown, topic: string | null) {
  const initialImportDone = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportDone?.value !== 'true') {
    return NextResponse.json({ ok: true, skipped: 'initial_import_pending' })
  }

  if (topic === 'refund.created') {
    const wcRefund = payload as WcRefund
    const failures: string[] = []
    if (typeof wcRefund.parent_id === 'number') {
      try {
        const refundResult = await syncWcRefund(wcRefund.parent_id, wcRefund)
        if (!refundResult.success) failures.push(`syncWcRefund: ${refundResult.error ?? 'unknown error'}`)
      } catch (e) {
        failures.push(`syncWcRefund: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failures.length === 0) {
      await advanceWcOrderSyncCursor()
      return NextResponse.json({ ok: true })
    }
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_webhook_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce refund webhook failed; cursor not advanced so polling can retry`,
      metadata: { externalRefundId: wcRefund.id, parentOrderId: wcRefund.parent_id, failures },
    })
    // Return HTTP 500 so WooCommerce retries delivery (it treats any 2xx as
    // delivered, regardless of body). Polling reconcile is suppressed while
    // webhooks are primary, so we rely on WC's retry to recover.
    return NextResponse.json({ ok: false, failures }, { status: 500 })
  }

  const wcOrder = payload as WcFullOrder

  const failures: string[] = []
  if (topic === 'order.created') {
    const importResult = await importWcOrder(wcOrder)
    if (!importResult.success) failures.push(`importWcOrder: ${importResult.error ?? 'unknown error'}`)
  } else if (topic === 'order.updated') {
    const suppressed = await shouldSuppressWcOrderWebhookEcho(wcOrder)
    if (suppressed.suppress) {
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_order_webhook_suppressed',
        tag: 'sync',
        level: 'INFO',
        description: `Suppressed WooCommerce order webhook echo for WC order #${wcOrder.number}`,
        metadata: {
          externalOrderId: wcOrder.id,
          reason: suppressed.reason,
          topic,
          status: wcOrder.status,
        },
      })
      return NextResponse.json({ ok: true, suppressed: suppressed.reason })
    }

    const importResult = await importWcOrder(wcOrder)
    if (!importResult.success) failures.push(`importWcOrder: ${importResult.error ?? 'unknown error'}`)
    const statusResult = await syncWcOrderStatus(wcOrder)
    if (!statusResult.success) failures.push(`syncWcOrderStatus: ${statusResult.error ?? 'unknown error'}`)
    try {
      await syncRefundsForOrder(wcOrder.id)
    } catch (e) {
      failures.push(`syncRefundsForOrder: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (failures.length === 0) {
    await advanceWcOrderSyncCursor()
    return NextResponse.json({ ok: true })
  }

  await logActivity({
    entityType: 'SYNC',
    action: 'wc_order_webhook_failed',
    tag: 'sync',
    level: 'WARNING',
    description: `WooCommerce order webhook for #${wcOrder.number} had failures; cursor not advanced so polling can retry`,
    metadata: { externalOrderId: wcOrder.id, topic, status: wcOrder.status, failures },
  })
  // Return HTTP 500 so WooCommerce retries delivery (any 2xx is treated as
  // delivered regardless of body). Polling reconcile is suppressed while
  // webhooks are primary, so we rely on WC's retry to recover.
  return NextResponse.json({ ok: false, failures }, { status: 500 })
}

async function handleProductWebhook(payload: unknown) {
  const productPayload = payload as Partial<WcFullProduct> & { stock_quantity?: number | null }
  const canSyncProduct =
    typeof productPayload.id === 'number'
    && typeof productPayload.sku === 'string'
    && typeof productPayload.type === 'string'
    && typeof productPayload.name === 'string'
    && typeof productPayload.status === 'string'

  if (canSyncProduct) {
    const result = await syncWcProductToIms(productPayload as WcFullProduct)
    if (result.success) {
      await db.setting.upsert({
        where: { key: 'last_wc_product_sync_at' },
        create: { key: 'last_wc_product_sync_at', value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      })
    } else {
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_product_webhook',
        tag: 'sync',
        level: 'WARNING',
        description: `WooCommerce product webhook import failed for ${productPayload.sku}`,
        metadata: {
          externalId: productPayload.id,
          sku: productPayload.sku,
          error: result.error ?? 'Unknown product sync error',
        },
      })
    }
  } else if (typeof productPayload.id === 'number') {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_product_webhook',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce product webhook payload skipped for WC product ${productPayload.id}`,
      metadata: {
        externalId: productPayload.id,
        skuType: typeof productPayload.sku,
        typeType: typeof productPayload.type,
        nameType: typeof productPayload.name,
        statusType: typeof productPayload.status,
        payloadKeys: Object.keys(productPayload).sort(),
      },
    })
  }

  if (typeof productPayload.id === 'number' && Object.prototype.hasOwnProperty.call(productPayload, 'stock_quantity')) {
    const product = await db.product.findFirst({
      where: { externalProductId: BigInt(productPayload.id) },
      select: { id: true, sku: true },
    })
    if (product) {
      const qty = typeof productPayload.stock_quantity === 'number'
        ? Math.floor(productPayload.stock_quantity)
        : null
      await recordIncomingWcWebhook(product.id, qty)
      const suppressed = await shouldSuppressWcWebhookEcho(product.id, qty)
      if (!suppressed) {
        try {
          await enqueueAndProcessImmediateWcStockSync(
            [product.id],
            'WC_WEBHOOK',
            { force: true, webhookQty: qty },
          )
        } catch (error) {
          await logActivity({
            entityType: 'SYNC',
            action: 'wc_stock_webhook',
            tag: 'sync',
            level: 'WARNING',
            description: `WooCommerce stock webhook correction failed for ${product.sku}`,
            metadata: {
              productId: product.id,
              externalId: productPayload.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }
  }

  return NextResponse.json({ ok: true })
}

async function handleRefundWebhook(payload: unknown) {
  const refundPayload = payload as WcRefund & { order_id?: number; parent_id?: number }
  const externalOrderId = refundPayload.order_id ?? refundPayload.parent_id
  if (!externalOrderId) return NextResponse.json({ error: 'Missing order_id' }, { status: 400 })

  await syncWcRefund(externalOrderId, refundPayload)
  return NextResponse.json({ ok: true })
}

const defaultDependencies: WcWebhookDependencies = {
  getMaintenanceModeResponse,
  verifyWebhook: verifyWcWebhook,
  recordWebhookReceipt,
  handleOrderWebhook,
  handleProductWebhook,
  handleRefundWebhook,
}

export async function handleWcWebhook(
  resource: ShoppingWebhookResource,
  request: Request,
  rawBody: string,
  dependencies: WcWebhookDependencies = defaultDependencies,
) {
  const maintenance = await dependencies.getMaintenanceModeResponse('webhook')
  if (maintenance) return maintenance

  const body = rawBody
  const { signature, topic } = getWebhookHeaders(request)

  if (isWebhookPing(signature, topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  if (!(await dependencies.verifyWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Signed pings count toward last-received telemetry, unsigned pings do not.
  await dependencies.recordWebhookReceipt(resource)

  if (isSignedActionPing(topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  const parsed = parseWebhookJson<unknown>(body)
  if (!parsed.ok) return parsed.response

  switch (resource) {
    case 'orders':
      return dependencies.handleOrderWebhook(parsed.value, topic)
    case 'products':
      return dependencies.handleProductWebhook(parsed.value)
    case 'refunds':
      return dependencies.handleRefundWebhook(parsed.value)
  }
}
