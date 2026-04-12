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

  if (!(await verifyWcWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Skip webhook-triggered imports if initial import hasn't completed yet —
  // those orders will be caught by the initial import instead.
  const initialImportDone = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportDone?.value !== 'true') {
    return NextResponse.json({ ok: true, skipped: 'initial_import_pending' })
  }

  const topic = request.headers.get('x-wc-webhook-topic')
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

  return NextResponse.json({ ok: true })
}
