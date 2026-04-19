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

async function handleOrderWebhook(body: string, topic: string | null) {
  const initialImportDone = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportDone?.value !== 'true') {
    return NextResponse.json({ ok: true, skipped: 'initial_import_pending' })
  }

  if (topic === 'refund.created') {
    const wcRefund = JSON.parse(body) as WcRefund
    if (typeof wcRefund.parent_id === 'number') {
      await syncWcRefund(wcRefund.parent_id, wcRefund)
    }
    await db.setting.upsert({
      where: { key: 'last_wc_order_sync_at' },
      create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    return NextResponse.json({ ok: true })
  }

  const wcOrder = JSON.parse(body) as WcFullOrder

  if (topic === 'order.created') {
    await importWcOrder(wcOrder)
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

    await importWcOrder(wcOrder)
    await syncWcOrderStatus(wcOrder)
    await syncRefundsForOrder(wcOrder.id)
  }

  await db.setting.upsert({
    where: { key: 'last_wc_order_sync_at' },
    create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  return NextResponse.json({ ok: true })
}

async function handleProductWebhook(body: string) {
  const payload = JSON.parse(body) as Partial<WcFullProduct> & { stock_quantity?: number | null }
  const canSyncProduct =
    typeof payload.id === 'number'
    && typeof payload.sku === 'string'
    && typeof payload.type === 'string'
    && typeof payload.name === 'string'
    && typeof payload.status === 'string'

  if (canSyncProduct) {
    const result = await syncWcProductToIms(payload as WcFullProduct)
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
        description: `WooCommerce product webhook import failed for ${payload.sku}`,
        metadata: {
          externalId: payload.id,
          sku: payload.sku,
          error: result.error ?? 'Unknown product sync error',
        },
      })
    }
  } else if (typeof payload.id === 'number') {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_product_webhook',
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce product webhook payload skipped for WC product ${payload.id}`,
      metadata: {
        externalId: payload.id,
        skuType: typeof payload.sku,
        typeType: typeof payload.type,
        nameType: typeof payload.name,
        statusType: typeof payload.status,
        payloadKeys: Object.keys(payload).sort(),
      },
    })
  }

  if (typeof payload.id === 'number' && Object.prototype.hasOwnProperty.call(payload, 'stock_quantity')) {
    const product = await db.product.findFirst({
      where: { externalProductId: BigInt(payload.id) },
      select: { id: true, sku: true },
    })
    if (product) {
      const qty = typeof payload.stock_quantity === 'number'
        ? Math.floor(payload.stock_quantity)
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
              externalId: payload.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }
  }

  return NextResponse.json({ ok: true })
}

async function handleRefundWebhook(body: string) {
  const payload = JSON.parse(body) as WcRefund & { order_id?: number; parent_id?: number }
  const externalOrderId = payload.order_id ?? payload.parent_id
  if (!externalOrderId) return NextResponse.json({ error: 'Missing order_id' }, { status: 400 })

  await syncWcRefund(externalOrderId, payload)
  return NextResponse.json({ ok: true })
}

export async function handleWcWebhook(resource: ShoppingWebhookResource, request: Request) {
  const maintenance = await getMaintenanceModeResponse('webhook')
  if (maintenance) return maintenance

  const body = await request.text()
  const { signature, topic } = getWebhookHeaders(request)

  if (isWebhookPing(signature, topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  if (!(await verifyWcWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  await recordWebhookReceipt(resource)

  if (isSignedActionPing(topic)) {
    return NextResponse.json({ ok: true, ping: true })
  }

  switch (resource) {
    case 'orders':
      return handleOrderWebhook(body, topic)
    case 'products':
      return handleProductWebhook(body)
    case 'refunds':
      return handleRefundWebhook(body)
  }
}
