import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WRITERS } from './storefront-mapping-writers-census.test'

/**
 * THE ONE GLOBAL LOCK ORDER OF THE TAX-RATE / STOREFRONT-MAPPING WRITERS, PINNED (not just the presence of the lock, which tests/tax/storefront-mapping-writers-census.test.ts pins):
 *
 *     the mapping write lock (WOO_TAX_RATE_WRITE_LOCK_KEY: shared by writers, exclusive for the tax-rate apply and the EU VAT seed apply)  FIRST,
 *     then the tax-rate rows (resolveWritableTaxRateId(s), lockTaxRateForEdit, a raw `FROM tax_rates ... FOR ...`).
 *
 * A writer that locked a rate row and THEN asked for the mapping lock can deadlock against a transaction that holds the mapping lock and wants that rate row (the re-key, the seed apply). So for each
 * function below the first mapping-lock call must come BEFORE the first rate-row lock; and any file that writes the mapping table (WRITERS) and also takes a rate-row lock must be listed here, so a new
 * one is red until its order is declared.
 */
const MAPPING_LOCK = /lockStorefrontMappingWrites\(|WOO_TAX_RATE_WRITE_LOCK_KEY|pg_advisory_xact_lock_shared/
const RATE_LOCK = /resolveWritableTaxRateIds?\(|lockTaxRateForEdit\(|FROM\s+tax_rates[^`]*?\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/

export const ORDERED: ReadonlyArray<{ file: string; from: string; span: number }> = [
  { file: 'lib/connectors/woocommerce/sync/taxes.ts', from: 'Upsert the WC rate id', span: 1800 },
  { file: 'app/actions/wc-sync.ts', from: 'export async function updateShoppingTaxRateMapping', span: 1200 },
  { file: 'lib/tax/tax-rekey.ts', from: 'export async function runTaxRekey', span: 4200 },
  { file: 'lib/tax/purchase-tax-import.ts', from: 'export async function writePurchaseTaxImport', span: 2600 },
  { file: 'lib/tax/eu-vat-preflight.ts', from: 'export async function applyEuVatSeed', span: 9000 },
]

export function orderViolation(source: string, from: string, span: number): string | null {
  const start = source.indexOf(from)
  if (start < 0) return `marker "${from}" not found`
  const slice = source.slice(start, start + span)
  const lock = slice.search(MAPPING_LOCK)
  const rate = slice.search(RATE_LOCK)
  if (lock < 0) return 'no mapping-lock call in the function'
  if (rate < 0) return 'no rate-row lock in the function (the declaration is stale)'
  return lock < rate ? null : 'a rate row is locked BEFORE the mapping write lock'
}

test('every declared writer takes the mapping write lock before it locks any tax-rate row', () => {
  const bad: string[] = []
  for (const { file, from, span } of ORDERED) {
    const violation = orderViolation(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), from, span)
    if (violation !== null) bad.push(`${file}: ${violation}`)
  }
  assert.deepEqual(bad, [])
})

test('a mapping writer that also locks rate rows is declared in the order table (a new one is red until it is)', () => {
  const declared = new Set(ORDERED.map((o) => o.file))
  const undeclared: string[] = []
  for (const file of [...Object.keys(WRITERS), 'lib/tax/eu-vat-preflight.ts']) {
    if (declared.has(file)) continue
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    if (RATE_LOCK.test(source) && /shoppingTaxRateMapping|shopping_tax_rate_mappings/.test(source)) undeclared.push(file)
  }
  assert.deepEqual(undeclared, [], 'declare the function and its order in ORDERED')
})

test('the checker fails on the inverted order (it can go red)', () => {
  const inverted = 'function f(){ await resolveWritableTaxRateId(tx, id); await lockStorefrontMappingWrites(tx) }'
  const fixed = 'function f(){ await lockStorefrontMappingWrites(tx); await resolveWritableTaxRateId(tx, id) }'
  assert.match(orderViolation(inverted, 'function f', 500)!, /BEFORE the mapping write lock/)
  assert.equal(orderViolation(fixed, 'function f', 500), null)
  assert.match(orderViolation('function f(){}', 'function f', 500)!, /no mapping-lock call/)
})
