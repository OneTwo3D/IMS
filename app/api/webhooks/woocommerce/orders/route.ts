import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { importWcOrder } from '@/lib/connectors/woocommerce/sync/order-import'
import { syncWcOrderStatus } from '@/lib/connectors/woocommerce/sync/order-status'
import { syncRefundsForOrder } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

export async function POST(request: Request) {
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

  // Record successful webhook receipt so the UI can confirm the webhook is working
  const receivedAt = new Date().toISOString()
  await Promise.all([
    db.setting.upsert({
      where: { key: 'wc_webhook_last_received_at' },
      create: { key: 'wc_webhook_last_received_at', value: receivedAt },
      update: { value: receivedAt },
    }),
    db.setting.upsert({
      where: { key: 'wc_order_webhook_last_received_at' },
      create: { key: 'wc_order_webhook_last_received_at', value: receivedAt },
      update: { value: receivedAt },
    }),
  ])

  // WooCommerce sends a signed ping with action.* topic after webhook creation
  if (topic!.startsWith('action.')) {
    return NextResponse.json({ ok: true, ping: true })
  }

  // Skip webhook-triggered imports if initial import hasn't completed yet —
  // those orders will be caught by the initial import instead.
  const initialImportDone = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportDone?.value !== 'true') {
    return NextResponse.json({ ok: true, skipped: 'initial_import_pending' })
  }

  const wcOrder = JSON.parse(body) as WcFullOrder

  if (topic === 'order.created') {
    await importWcOrder(wcOrder)
  } else if (topic === 'order.updated') {
    // Try import first (in case order wasn't synced yet)
    await importWcOrder(wcOrder)
    // Then sync status
    await syncWcOrderStatus(wcOrder)
    // Check for new refunds
    await syncRefundsForOrder(wcOrder.id)
  }

  await db.setting.upsert({
    where: { key: 'last_wc_order_sync_at' },
    create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  return NextResponse.json({ ok: true })
}
