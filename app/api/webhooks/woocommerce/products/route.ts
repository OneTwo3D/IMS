import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { syncWcProductToIms } from '@/lib/connectors/woocommerce/sync/product-sync'
import {
  enqueueAndProcessImmediateWcStockSync,
  recordIncomingWcWebhook,
  shouldSuppressWcWebhookEcho,
} from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'
import type { WcFullProduct } from '@/lib/connectors/woocommerce/sync/types'

export async function POST(request: Request) {
  const maintenance = await getMaintenanceModeResponse('webhook')
  if (maintenance) return maintenance

  const body = await request.text()
  const signature = request.headers.get('x-wc-webhook-signature')
  const topic = request.headers.get('x-wc-webhook-topic')

  // WooCommerce sends an unsigned verification ping (no signature, no topic)
  // when first creating a webhook — accept it so WC considers the URL valid.
  if (!signature && !topic) {
    return NextResponse.json({ ok: true, ping: true })
  }

  if (!(await verifyWcWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const receivedAt = new Date().toISOString()
  await Promise.all([
    db.setting.upsert({
      where: { key: 'wc_webhook_last_received_at' },
      create: { key: 'wc_webhook_last_received_at', value: receivedAt },
      update: { value: receivedAt },
    }),
    db.setting.upsert({
      where: { key: 'wc_product_webhook_last_received_at' },
      create: { key: 'wc_product_webhook_last_received_at', value: receivedAt },
      update: { value: receivedAt },
    }),
  ])

  // WooCommerce sends a signed ping with action.* topic after webhook creation
  if (topic!.startsWith('action.')) {
    return NextResponse.json({ ok: true, ping: true })
  }

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
          wcId: payload.id,
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
        wcId: payload.id,
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
      where: { wcProductId: BigInt(payload.id) },
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
              wcId: payload.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }
  }

  return NextResponse.json({ ok: true })
}
