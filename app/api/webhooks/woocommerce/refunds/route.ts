import { NextResponse } from 'next/server'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { syncWcRefund } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'

export async function POST(request: Request) {
  const body = await request.text()
  const signature = request.headers.get('x-wc-webhook-signature')

  if (!(await verifyWcWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(body) as WcRefund & { order_id?: number; parent_id?: number }
  const wcOrderId = payload.order_id ?? payload.parent_id
  if (!wcOrderId) return NextResponse.json({ error: 'Missing order_id' }, { status: 400 })

  await syncWcRefund(wcOrderId, payload)
  return NextResponse.json({ ok: true })
}
