/**
 * Full-chain smoke test (o3d-lgo.4).
 *
 * Proves the harness itself — the chain's first hop and the tier's central claim:
 * a real order created in Woo reaches the IMS via WOO'S OWN WEBHOOK, with no
 * hand-posted payload anywhere. Everything in Phase 2 builds on that, so it is worth
 * one spec that fails fast and unambiguously if the plumbing rots.
 *
 * It does NOT post to Xero: the point here is the harness, not accounting. The rig
 * stays disarmed unless a test explicitly arms it (ims.setPostingMode).
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { awaitWebhookDelivery, cleanupWc, createWcOrder, createWcProduct, getWcOrder, wcCreds, type WcCreds } from './harness/wc.ts'
import { runTag } from './harness/tag.ts'

test.describe.serial('@full-chain @wc harness smoke', () => {
  let creds: WcCreds
  let runId: string

  test.beforeAll(async () => {
    runId = currentRunId()
    creds = await wcCreds()
  })

  test.afterAll(async () => {
    // Woo cleanup is per-spec; Xero teardown is global (nothing posted here).
    if (creds && runId) await cleanupWc(creds, runId)
  })

  test('a real WooCommerce order reaches the IMS via Woo\'s own webhook', async () => {
    // Comfortably longer than awaitWebhookDelivery's own 300s budget. If the two are
    // equal Playwright kills the test first and you get a bare "Test timeout exceeded"
    // instead of the harness's diagnosis of WHY nothing arrived — which is the only
    // part worth reading. (That happened; hence the gap.)
    test.setTimeout(420_000)

    const product = await createWcProduct(creds, runId, { label: 'SMOKE', price: '19.99' })
    expect(product.id).toBeGreaterThan(0)

    const order = await createWcOrder(creds, runId, { lines: [{ productId: product.id, quantity: 2 }] })
    expect(order.id).toBeGreaterThan(0)
    // processing is what wc_sync_order_statuses imports; anything else is silently skipped.
    expect(order.status).toBe('processing')

    // The assertion that matters: nothing here posts a webhook payload. If this passes,
    // Woo genuinely delivered to this instance.
    const imported = await awaitWebhookDelivery(order.id)
    expect(imported.salesOrderId).toBeTruthy()
    expect(imported.orderNumber).toBeTruthy()

    // And it is really our order, not a coincidental match.
    const wcOrder = await getWcOrder(creds, order.id)
    expect(wcOrder.billing?.last_name ?? '').toContain(runTag(runId))
  })
})
