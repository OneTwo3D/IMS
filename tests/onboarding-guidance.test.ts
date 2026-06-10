import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const PRODUCTS_STEP = 'components/onboarding/products-step.tsx'
const INTEGRATIONS_STEP = 'components/onboarding/integrations-step.tsx'
const SYNC_CLIENT = 'app/(dashboard)/sync/sync-client.tsx'

async function source(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

test('products onboarding documents lifecycle and preferred supplier import fields', async () => {
  const text = await source(PRODUCTS_STEP)

  for (const expected of ['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED']) {
    assert.match(text, new RegExp(expected))
  }
  assert.match(text, /preferredSupplierId/)
  assert.match(text, /preferredSupplierName/)
  assert.match(text, /Supplier-scoped reorder forecasts and draft POs use this field/)
  assert.match(text, /Use[\s\S]+DRAFT[\s\S]+first-time catalog imports/)
})

test('integrations onboarding makes connection verification and production readiness explicit', async () => {
  const text = await source(INTEGRATIONS_STEP)

  assert.match(text, /Save & Test Connection/)
  assert.match(text, /Connect & Verify Xero/)
  assert.match(text, /Connect & Verify QuickBooks/)
  assert.match(text, /onboarding cannot continue until Xero is connected/)
  assert.match(text, /onboarding cannot continue until QuickBooks is connected/)
  assert.match(text, /CRON_SECRET/)
  assert.match(text, /Enable scheduled backups/)
  assert.match(text, /remote backup target/)
})

test('WooCommerce setup documents webhook secret reuse for invoice PDF handoff', async () => {
  const onboarding = await source(INTEGRATIONS_STEP)
  const syncClient = await source(SYNC_CLIENT)

  for (const text of [onboarding, syncClient]) {
    assert.match(text, /wc_webhook_secret|webhook secret/)
    assert.match(text, /OneTwoInventory Helper/)
    assert.match(text, /invoice PDF/)
    assert.match(text, /rotating .*requires updating both/i)
  }
})
