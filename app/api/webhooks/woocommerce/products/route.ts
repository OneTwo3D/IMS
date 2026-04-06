import { NextResponse } from 'next/server'
import { verifyWcWebhook } from '@/lib/connectors/woocommerce/sync/webhook-verify'
import { syncWcProductToIms } from '@/lib/connectors/woocommerce/sync/product-sync'
import type { WcFullProduct } from '@/lib/connectors/woocommerce/sync/types'

export async function POST(request: Request) {
  const body = await request.text()
  const signature = request.headers.get('x-wc-webhook-signature')

  if (!(await verifyWcWebhook(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const wcProduct = JSON.parse(body) as WcFullProduct
  await syncWcProductToIms(wcProduct)
  return NextResponse.json({ ok: true })
}
