import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The operator's gift-card answers belong to the store and the orders they were given for: the operator reset deletes them in the same transaction as the sales orders, and a store-changing credential save deletes those of
 * every other store. Pinned at the source because the reset and the credential save cannot run without a database and a store.
 */
const read = (file: string) => readFileSync(file, 'utf8')

test('the operator reset deletes the answers inside the sales-orders transaction, after the orders', () => {
  const source = read('app/actions/reset.ts')
  const orders = source.indexOf('await tx.salesOrder.deleteMany({})')
  const answers = source.indexOf('await tx.euVatGiftCardLineResolution.deleteMany({})')
  assert.ok(orders > 0 && answers > orders, 'answers are deleted after the orders, in the same transaction')
  assert.ok(source.indexOf('}, { timeout: 600_000', answers) - answers < 200, 'before that transaction closes')
})

test('a WooCommerce rebind deletes the answers of every other store inside the credential-save transaction', () => {
  const source = read('app/actions/wc-sync.ts')
  assert.match(source, /tx\.euVatGiftCardLineResolution\.deleteMany\(\{ where: \{ NOT: \{ storeIdentity: normaliseStoreIdentity\(validatedUrl\.normalizedUrl\)/)
})
