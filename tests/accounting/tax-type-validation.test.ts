import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { isUnknownActiveTaxType } from '@/lib/accounting/accounting-tax-type-validation'

// o3d-r30: caching the tax-rate display list is only safe because the WRITE boundary (updateTaxRate)
// re-validates the selected TaxType against a LIVE fetch of the active connector's rates. These tests
// pin the validation logic and the refusal path.

test('isUnknownActiveTaxType: a TaxType present in the live set is accepted', () => {
  assert.equal(isUnknownActiveTaxType('OUTPUT2', [{ taxType: 'OUTPUT2' }, { taxType: 'INPUT2' }]), false)
})

test('isUnknownActiveTaxType: a TaxType absent from a non-empty live set is rejected', () => {
  assert.equal(isUnknownActiveTaxType('ARCHIVED', [{ taxType: 'OUTPUT2' }]), true)
})

test('isUnknownActiveTaxType: an empty live set fails OPEN (connector unreachable)', () => {
  assert.equal(isUnknownActiveTaxType('ANYTHING', []), false)
})

// --- updateTaxRate refusal path (write-time validation) ---------------------

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
  },
})

// If validation refuses, the DB transaction must never run — make it throw so a regression that skips
// the guard is caught.
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async () => {
        throw new Error('db.$transaction must not be reached when validation refuses')
      },
      taxRate: {},
    },
  },
})

let liveRates: Array<{ taxType: string }> = []
mock.module('@/app/actions/accounting-sync', {
  namedExports: {
    fetchAccountingTaxRates: async () => liveRates,
  },
})

async function loadUpdateTaxRate() {
  return (await import('@/app/actions/settings')).updateTaxRate
}

test('updateTaxRate refuses an accountingTaxType not in the live active set, before touching the DB (o3d-r30)', async () => {
  const updateTaxRate = await loadUpdateTaxRate()
  liveRates = [{ taxType: 'OUTPUT2' }] // a non-empty live set that lacks the submitted type
  const res = await updateTaxRate('tr-1', { accountingTaxType: 'ARCHIVED_TYPE' })
  assert.equal(res.success, false)
  assert.match(res.error ?? '', /not a currently-active/)
})
