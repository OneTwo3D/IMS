import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { classifyXeroTaxType } from '@/lib/accounting/accounting-tax-type-validation'

// o3d-r30: caching the tax-rate display list is only safe because every accountingTaxType WRITE
// (create + update, incl. auto-apply) re-validates the selected TaxType against a LIVE Xero fetch. These
// tests pin the discriminated classifier and the updateTaxRate refusal path.

test('classifyXeroTaxType: a TaxType present in the live set is accepted', () => {
  assert.deepEqual(classifyXeroTaxType('OUTPUT2', { taxRates: [{ taxType: 'OUTPUT2' }, { taxType: 'INPUT2' }] }), { ok: true })
})

test('classifyXeroTaxType: a TaxType absent from a non-empty live set is rejected', () => {
  const res = classifyXeroTaxType('ARCHIVED', { taxRates: [{ taxType: 'OUTPUT2' }] })
  assert.equal(res.ok, false)
})

test('classifyXeroTaxType: a successful EMPTY active set is authoritative and rejects (all archived)', () => {
  // A successful fetch that yields no ACTIVE rates must NOT be confused with an outage — reject.
  const res = classifyXeroTaxType('ANYTHING', { taxRates: [] })
  assert.equal(res.ok, false)
})

test('classifyXeroTaxType: a null live result (fetch failed) fails CLOSED', () => {
  const res = classifyXeroTaxType('OUTPUT2', null)
  assert.equal(res.ok, false)
  assert.match(res.ok ? '' : res.error, /unreachable/)
})

// --- validateAccountingTaxTypeForWrite (connector-aware) ---------------------

let activeConnector: { id: string } | null = { id: 'xero' }
let liveXero: { taxRates: Array<{ taxType: string }> } | null = { taxRates: [{ taxType: 'OUTPUT2' }] }

mock.module('@/lib/accounting', {
  namedExports: { getActiveAccountingConnectorInfo: async () => activeConnector },
})
mock.module('@/lib/connectors/xero/accounts', {
  namedExports: { getXeroTaxRates: async () => liveXero },
})

async function loadValidator() {
  return (await import('@/lib/accounting/accounting-tax-type-validation')).validateAccountingTaxTypeForWrite
}

test('validateAccountingTaxTypeForWrite: non-Xero connector is a no-op (not the cached connector)', async () => {
  const validate = await loadValidator()
  activeConnector = { id: 'quickbooks' }
  assert.deepEqual(await validate('WHATEVER'), { ok: true })
})

test('validateAccountingTaxTypeForWrite: Xero + present type is accepted; absent is rejected', async () => {
  const validate = await loadValidator()
  activeConnector = { id: 'xero' }
  liveXero = { taxRates: [{ taxType: 'OUTPUT2' }] }
  assert.deepEqual(await validate('OUTPUT2'), { ok: true })
  assert.equal((await validate('ARCHIVED')).ok, false)
})

// --- updateTaxRate refusal path ---------------------------------------------

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async () => { throw new Error('db.$transaction must not run when validation refuses') },
      taxRate: {},
    },
  },
})

async function loadUpdateTaxRate() {
  return (await import('@/app/actions/settings')).updateTaxRate
}

test('updateTaxRate refuses an archived accountingTaxType before touching the DB (o3d-r30)', async () => {
  const updateTaxRate = await loadUpdateTaxRate()
  activeConnector = { id: 'xero' }
  liveXero = { taxRates: [{ taxType: 'OUTPUT2' }] } // ARCHIVED_TYPE is absent -> refuse
  const res = await updateTaxRate('tr-1', { accountingTaxType: 'ARCHIVED_TYPE' })
  assert.equal(res.success, false)
  assert.match(res.error ?? '', /not a currently-active Xero tax rate/)
})
