import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TaxRateReplacedError, lockTaxRateForEdit } from '@/lib/tax/tax-rate-replaced'

/**
 * A RATE A RE-KEY REPLACED IS READ-ONLY (lib/tax/tax-rate-replaced.ts): the edit guard over a double, and the census of every path that can activate a rate or change its code.
 * The committed behaviour (the real row lock against the apply) is in tests/concurrency/tax-rekey.concurrent.test.ts.
 * Each guard has a `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

function tx(replacedById: string | null, locks: string[] = []) {
  return {
    $queryRaw: async () => { locks.push('lock'); return [] },
    taxRate: { findUnique: async () => ({ replacedById }) },
  }
}

// [mutation: the replacedById check removed -> every refusal arm fails; mutation: the switch-off exception widened to any edit -> the "also" arms fail]
test('a replaced rate refuses reactivation and any change of code, percentage, components or flags; switching it off is the only edit', async () => {
  for (const edit of [{ active: true }, { rate: 0.2 }, { accountingTaxType: 'TAX005' }, { components: [] }, { name: 'x' }, { active: false, rate: 0.2 }, { active: false, accountingTaxType: 'TAX005' }]) {
    await assert.rejects(lockTaxRateForEdit(tx('new'), 'old', edit), (e: unknown) => e instanceof TaxRateReplacedError && e.replacedById === 'new', JSON.stringify(edit))
  }
  await lockTaxRateForEdit(tx('new'), 'old', { active: false })
  await lockTaxRateForEdit(tx('new'), 'old', { active: false, rate: undefined })
})

test('a rate nobody replaced is edited as before, and the row is locked first (it serialises with the re-key apply)', async () => {
  const locks: string[] = []
  await lockTaxRateForEdit(tx(null, locks), 'cy', { active: true, rate: 0.2, accountingTaxType: 'TAX008', components: [] })
  assert.deepEqual(locks, ['lock'])
  await lockTaxRateForEdit({ taxRate: { findUnique: async () => null } }, 'missing', { active: true })
})

// [mutation: any one of these calls removed -> that census row fails]
test('CENSUS: every path that can activate a rate or change its code refuses a replaced row', () => {
  const settings = readFileSync('app/actions/settings.ts', 'utf8')
  assert.match(settings, /await lockTaxRateForEdit\(tx, id, input\)/, 'the tax rate editor locks the row and refuses a replaced one')
  assert.equal((settings.match(/updateMany\(\{ where: \{ id: (?:entry|rate)\.id, replacedById: null \}/g) ?? []).length, 2, 'the link-by-name and generate-missing code writers skip replaced rows')
  const demo = readFileSync('scripts/provision-xero-demo.ts', 'utf8')
  assert.equal((demo.match(/replaced_by_id is null/g) ?? []).length, 2, 'the demo provisioning remaps skip replaced rows')
  assert.match(readFileSync('scripts/copy-tax-rates.ts', 'utf8'), /where tax_rates\.replaced_by_id is null/, 'the copy script never overwrites a replaced row')
  assert.match(readFileSync('lib/tax/writable-tax-rate.ts', 'utf8'), /r\.active && r\.replacedById === null/, 'writers never use a replaced row as it stands, active or not')
  assert.match(readFileSync('lib/tax/retired-tax-code-guard.ts', 'utf8'), /row\.active && row\.replacedById === null && row\.accountingTaxType === o\.code/, 'the enqueue guard admits a retired code only for a bound rate that is active, not replaced and carries it')
  // Nothing else in app/ or lib/ writes active=true on a tax rate: the only writer of that flag is the editor (the import only ever deactivates).
  const importer = readFileSync('lib/tax/purchase-tax-import.ts', 'utf8')
  assert.equal(/taxRate\.update(?:Many)?\([^)]*active: true/.test(importer), false)
})
