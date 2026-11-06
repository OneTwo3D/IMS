import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * THE POSTING GATE FAILS CLOSED. If the erasure state cannot be read (the refund lookup or the order read fails) the gate
 * answers `ok: false`; the Xero processor then returns a retryable failure (the same shape as its other read failures) and
 * posts nothing, so no stored contact identity is sent while the state is unknown.
 */
let failRefundLookup = false
let failOrderRead = false
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrderRefund: { findUnique: async () => { if (failRefundLookup) throw new Error('db unavailable'); return { orderId: 'order-1' } } },
      salesOrder: { findUnique: async () => { if (failOrderRead) throw new Error('db unavailable'); return { erasedAt: new Date(), customer: null } } },
    },
  },
})

const payload = { contactName: 'Zebediah Quillfeather', contactEmail: 'z@example.test' }

test('a refund-lookup failure is NOT read as "no order": the gate refuses and returns no contact at all', async () => {
  const { resolveSalesPostContact } = await import('../lib/domain/erasure/accounting-contact.ts')
  failRefundLookup = true; failOrderRead = false
  const result = await resolveSalesPostContact('SalesOrderRefund', 'refund-1', payload)
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes('Quillfeather') && !JSON.stringify(result).includes('z@example.test'), 'the refusal carries no identity')
  assert.match((result as { error: string }).error, /retried/)
})

test('an order-read failure refuses too', async () => {
  const { resolveSalesPostContact } = await import('../lib/domain/erasure/accounting-contact.ts')
  failRefundLookup = false; failOrderRead = true
  assert.equal((await resolveSalesPostContact('SalesOrder', 'order-1', payload)).ok, false)
})

test('CONTROL: with the state readable, an erased order yields the placeholder, so the refusals above are the failure injection', async () => {
  const { resolveSalesPostContact } = await import('../lib/domain/erasure/accounting-contact.ts')
  failRefundLookup = false; failOrderRead = false
  assert.deepEqual(await resolveSalesPostContact('SalesOrderRefund', 'refund-1', payload), { ok: true, contactName: 'GDPR Anonymised', contactEmail: undefined })
})

test('the processor returns a failure (and so retries) when the gate refuses, BEFORE the claim is re-taken and before any push', () => {
  const src = readFileSync(new URL('../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  for (const [name, fence, call] of [['postContact', 'sales-invoice', 'pushSalesInvoice('], ['postContact', 'sales-invoice-update', 'updateSalesInvoice('], ['creditContact', 'credit-note', 'pushCreditNote(']] as const) {
    const gate = src.indexOf(`const ${name} = await resolveSalesPostContact(`, src.indexOf(`const fence = await lease.fenceBeforeRemoteWrite('${fence}')`) - 700)
    const fenceAt = src.indexOf(`const fence = await lease.fenceBeforeRemoteWrite('${fence}')`)
    assert.ok(gate > 0 && gate < fenceAt && fenceAt < src.indexOf(call, fenceAt), `${fence}: the gate is read before the fence and the push`)
    assert.ok(src.slice(gate, gate + 260).includes(`if (!${name}.ok) return { success: false, error: ${name}.error }`), `${fence}: a refusal returns a failure`)
  }
})
