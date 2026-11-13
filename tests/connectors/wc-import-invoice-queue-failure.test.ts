import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * AN IMPORT WHOSE SALES INVOICE COULD NOT BE QUEUED IS A FAILED IMPORT. The enqueue's catch used to log a WARNING and let the import return `success: true`, so
 * the order poll, the FX retry (which marked its pending row SYNCED), the admission drain and the webhook all counted a money-visible gap as imported. It now throws to the
 * importer's own failure handling, so the ONE channel every caller already honours (`success: false`) carries it, and a caller cannot forget a separate flag.
 *
 * `importWcOrder` cannot be driven end to end here (its database surface is the whole import; see wc-invoice-number-wiring.test.ts), so the wiring is asserted at the
 * source, and so is the list of callers, so a new caller must be added here, where it is checked for reading `success`.
 */

const ORDER_IMPORT = 'lib/connectors/woocommerce/sync/order-import.ts'

test('the sales invoice enqueue catch does not swallow: it records the warning and throws to the failure handling', () => {
  const src = readFileSync(ORDER_IMPORT, 'utf8')
  const at = src.indexOf("action: 'sales_invoice_accounting_queue_failed'")
  assert.ok(at > 0)
  const catchEnd = src.indexOf('\n    }\n', at)
  const block = src.slice(at, catchEnd)
  assert.ok(block.includes('throw new Error('), 'the catch must throw, not return into the success path')
  // The failure handling it throws into: a FAILED sync row, or the pending FX row marked failed (never SYNCED) when it is a retry.
  const handler = src.slice(src.indexOf('} catch (e) {\n    if (e instanceof WcImportErasedRetry)'))
  assert.ok(handler.includes('markPendingFxRetryLogFailed(options.pendingFxRetryLogId, e)'), 'an FX retry row is marked failed, not synced')
  assert.ok(handler.includes("status: 'FAILED'"), 'any other import leaves a FAILED sync row')
  assert.ok(handler.includes('return { success: false, error: String(e) }'), 'and answers success: false')
})

test('every caller of importWcOrder reads its `success` (the only failure channel), so none can count a failed import as imported', () => {
  const roots = ['lib', 'app', 'scripts']
  const callers: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      const text = readFileSync(full, 'utf8')
      if (full !== ORDER_IMPORT && /\bimportWcOrder\(/.test(text)) callers.push(full)
    }
  }
  for (const root of roots) walk(root)
  // order-import.ts itself calls it from the FX retry and the poll.
  const orderImportText = readFileSync(ORDER_IMPORT, 'utf8')
  assert.ok((orderImportText.match(/importWcOrder\(/g) ?? []).length >= 3)
  assert.deepEqual(callers.sort(), [
    'lib/connectors/woocommerce/sync/initial-import.ts',
    'lib/connectors/woocommerce/sync/order-admission.ts',
    'lib/connectors/woocommerce/sync/withdrawal.ts',
    'lib/connectors/woocommerce/webhooks.ts',
    'scripts/commerce-accounting-e2e-fixture.ts',
  ], 'a new caller of importWcOrder: add it here after checking it reads `success`')
  for (const caller of callers) {
    assert.ok(/\.success\b/.test(readFileSync(caller, 'utf8')), `${caller} must read the import's success`)
  }
  // The two inside order-import.ts: the FX retry and the poll.
  assert.ok(/importResult\.success|\.success/.test(orderImportText))
})
