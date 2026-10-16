import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * WIRING: the Xero INVOICE_PAYMENT branch hands the fence a capacity recheck that counts in-flight rows, and the
 * fence runs it AFTER authorising and BEFORE the remote call (behaviour is proved on a real database in
 * tests/concurrency/payment-identity.concurrent.test.ts; this pins that the production call site passes it).
 */
test('the INVOICE_PAYMENT fence call carries the under-lock capacity recheck, counting in-flight rows', async () => {
  const source = await readFile(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("case 'INVOICE_PAYMENT': {"), source.indexOf("case 'BILL_PAYMENT': {"))
  const at = branch.indexOf('recheckUnderLock: async () => {')
  assert.ok(at > 0, 'the receipt branch passes a recheck to its fence')
  assert.ok(branch.indexOf('countInFlight: true', at) > at, 'and it counts authorised in-flight rows')
  assert.ok(at < branch.indexOf("xeroPost<{ Payments?"), 'it is part of the fence call that precedes the Payments POST')
  const fence = await readFile(new URL('../../lib/connectors/accounting-settlement-probe.ts', import.meta.url), 'utf8')
  const run = fence.indexOf('await params.recheckUnderLock()')
  assert.ok(run > fence.indexOf('const authorised = await authoriseMoneyPost(params)'), 'the fence runs it after authorising')
  assert.ok(run < fence.indexOf("held.assertHeld('posting money to the accounting connector')"), 'and before the lock is asserted held for the post')
})
