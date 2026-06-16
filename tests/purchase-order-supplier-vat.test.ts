import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Purchase VAT policy (decision): the supplier's Default VAT Rate — carried as
// the order-level rate — is authoritative for every PO line. A "No VAT" supplier
// yields 0% on every line, a per-line manual override still wins, and there is
// NO destination-country/category auto-resolution for purchases (that is
// sales-only). These source-level invariants guard against regressing back to
// the per-line `resolveLineTaxRateBatch` resolution that wrongly applied the
// global EU Standard 20% rate to no-VAT suppliers.

const ACTIONS = 'app/actions/purchase-orders.ts'
const FORM = 'app/(dashboard)/purchase-orders/po-form.tsx'

async function source(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

test('server PO actions resolve line VAT from the supplier/order default, not destination auto-resolution', async () => {
  const text = await source(ACTIONS)

  // The shared helper exists and is used by both create and update paths.
  assert.match(text, /async function resolvePurchaseLineTaxRates\(/)
  assert.equal(
    (text.match(/resolvePurchaseLineTaxRates\(input\.lines, orderDefaultCtx\)/g) || []).length,
    2,
    'both createPurchaseOrder and updatePurchaseOrder must resolve via the shared supplier-rate helper',
  )

  // Destination/category auto-resolution must NOT be used for purchases.
  assert.doesNotMatch(text, /resolveLineTaxRateBatch/)

  // Manual per-line override still wins inside the helper.
  assert.match(text, /resolvedTaxRateFromProfile\(row, 'exact'\)/)
})

test('PO form previews line VAT as the order/supplier default for purchases', async () => {
  const text = await source(FORM)

  // resolveRateClientSide short-circuits the purchase path to the order default
  // before any destination/category steps.
  assert.match(
    text,
    /if \(usedFor === 'PURCHASE'\) \{[\s\S]*?taxRateId: orderDefault\.id[\s\S]*?taxRateValue: orderDefault\.rate[\s\S]*?\}/,
  )
})

test('PO edit mode tracks the supplier rate so "No VAT" sticks on reopen', async () => {
  const text = await source(FORM)

  // The header tax rate is matched from the persisted header name, NOT from a
  // line's rate — a stale 20% line must not force the header back to 20%.
  assert.match(text, /const initialTaxRate = existingPo\?\.taxRateName/)
  assert.doesNotMatch(text, /taxRates\.find\(\(t\) => t\.id === existingPo\.lines\[0\]/)

  // Loaded lines re-derive VAT from the order default (auto), so they follow the
  // supplier rate on reopen instead of being treated as manual overrides.
  assert.match(text, /const lineOrderDefault = \{/)
  assert.match(
    text,
    /taxRateId: lineOrderDefault\.id,\s*taxRateValue: lineOrderDefault\.rate,\s*taxRateName: lineOrderDefault\.name,\s*taxRateWarning: null,\s*taxRateAutoResolved: true,/,
  )
})
