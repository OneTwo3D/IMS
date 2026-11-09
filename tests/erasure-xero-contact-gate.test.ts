import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * THE CONTACT GATE IS ASKED IMMEDIATELY BEFORE THE CONTACT IS LOOKED UP OR CREATED. The processor reads the erasure state early
 * (before it re-takes the claim); an erasure can commit after that and before the contact round trip, which is the call that can
 * create a contact in Xero. Each of the three sales posts is given a gate that re-reads the state at that point; its answer
 * replaces the name and email, or stops the post. The Xero doubles below receive exactly what would be sent.
 */
const contactCalls: Array<{ name: string; email: string | undefined }> = []
mock.module('../lib/connectors/xero/contacts.ts', {
  namedExports: { findOrCreateContact: async (name: string, email: string | undefined) => { contactCalls.push({ name, email }); return { success: false, error: 'stop here' } } },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('../lib/connectors/xero/api.ts', { namedExports: { xeroPost: async () => { throw new Error('no post expected'); }, xeroGet: async () => ({}), xeroPut: async () => ({}) } })

const REAL = { contactName: 'Zebediah Quillfeather', contactEmail: 'z.quillfeather@example.test' }
const invoice = { invoiceNumber: 'INV-1', ...REAL, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }] }
const creditNote = { creditNoteNumber: 'CN-1', ...REAL, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }] }
const erased = async () => ({ ok: true as const, contactName: 'GDPR Anonymised', contactEmail: undefined })
const unreadable = async () => ({ ok: false as const, error: 'erasure state unreadable; retried' })

async function load() {
  const inv = await import('../lib/connectors/xero/invoices.ts')
  const cn = await import('../lib/connectors/xero/credit-notes.ts')
  return {
    'pushSalesInvoice': (gate?: never) => inv.pushSalesInvoice(invoice as never, 'AUTHORISED', gate ? { contactGate: gate } : undefined),
    'updateSalesInvoice': (gate?: never) => inv.updateSalesInvoice('inv-ext-1', invoice as never, 'AUTHORISED', gate ? { contactGate: gate } : undefined),
    'pushCreditNote': (gate?: never) => cn.pushCreditNote(creditNote as never, 'AUTHORISED', gate ? { contactGate: gate } : undefined),
  } as Record<string, (gate?: never) => Promise<{ success: boolean; error?: string }>>
}

for (const name of ['pushSalesInvoice', 'updateSalesInvoice', 'pushCreditNote']) {
  test(`${name}: erased after the early read and before contact preparation, the Xero double receives the placeholder and no email`, async () => {
    const fn = (await load())[name]!
    contactCalls.length = 0
    await fn(erased as never)
    assert.deepEqual(contactCalls, [{ name: 'GDPR Anonymised', email: undefined }])
  })

  test(`${name}: a gate that cannot read the state stops the post before any contact is looked up or created`, async () => {
    const fn = (await load())[name]!
    contactCalls.length = 0
    const result = await fn(unreadable as never)
    assert.equal(result.success, false)
    assert.deepEqual(contactCalls, [])
  })

  test(`${name}: CONTROL, with no gate the stored contact is what is sent, so the placeholder above came from the gate`, async () => {
    const fn = (await load())[name]!
    contactCalls.length = 0
    await fn()
    assert.deepEqual(contactCalls, [{ name: REAL.contactName, email: REAL.contactEmail }])
  })
}

test('the processor passes the live gate to all three sales posts', () => {
  const src = readFileSync(new URL('../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/contactGate: \(\) => resolveSalesPostContact\(referenceType, referenceId, payload\)/g) ?? []).length, 3)
})
