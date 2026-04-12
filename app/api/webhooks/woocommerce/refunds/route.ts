import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { syncWcRefund } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'

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

  await db.setting.upsert({
    where: { key: 'wc_webhook_last_received_at' },
    create: { key: 'wc_webhook_last_received_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  // WooCommerce sends a signed ping with action.* topic after webhook creation
  if (topic!.startsWith('action.')) {
    return NextResponse.json({ ok: true, ping: true })
  }

  const payload = JSON.parse(body) as WcRefund & { order_id?: number; parent_id?: number }
  const wcOrderId = payload.order_id ?? payload.parent_id
  if (!wcOrderId) return NextResponse.json({ error: 'Missing order_id' }, { status: 400 })

  await syncWcRefund(wcOrderId, payload)
  return NextResponse.json({ ok: true })
}
