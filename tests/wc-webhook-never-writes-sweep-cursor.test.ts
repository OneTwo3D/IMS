import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The WooCommerce webhook handler must not write the sweep-owned pull cursors.
 *
 * A delivery that stamped `last_wc_order_sync_at` / `last_wc_product_sync_at` to NOW moved the cursor past
 * an older order or product whose own webhook had been missed, so the next sweep never read it. Behaviour is
 * pinned per delivery in wc-order-webhook-status-admission / wc-product-webhook-retry and against Postgres in
 * tests/db/wc-webhook-leaves-sweep-cursor.test.ts; this is the cheap tripwire for a NEW write site, which no
 * per-path test would notice.
 */
const source = readFileSync(join(process.cwd(), 'lib/connectors/woocommerce/webhooks.ts'), 'utf8')
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

test('webhooks.ts has no reference to the sweep cursors outside comments', () => {
  for (const key of ['last_wc_order_sync_at', 'last_wc_product_sync_at', 'last_wc_order_reconcile_at', 'last_wc_product_reconcile_at', 'advancePullCursor']) {
    assert.equal(code.includes(key), false, `${key} must not appear in webhook code`)
  }
})

test('webhooks.ts keeps its own processed stamps', () => {
  assert.ok(code.includes("'wc_order_webhook_last_processed_at'"))
  assert.ok(code.includes("'wc_product_webhook_last_processed_at'"))
})
