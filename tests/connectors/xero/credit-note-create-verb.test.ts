import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { CreditNoteData } from '@/lib/connectors/types'

/**
 * o3d-tfri. Xero's `POST /CreditNotes` is CREATE-OR-UPDATE on `CreditNoteNumber`, exactly as
 * `POST /Invoices` is on `InvoiceNumber` (the defect o3d-6l3 fixed for bills by switching to PUT).
 *
 * The two credit-note posters need OPPOSITE verbs, and these tests pin which is which because the
 * difference is invisible in the payload — it is only the HTTP method:
 *
 *   • SUPPLIER (ACCPAYCREDIT): the number is not ours. Blank on the form → `SCN-<id>`; otherwise
 *     whatever the supplier or the operator typed, which nothing makes unique. A duplicate must be
 *     REFUSED by Xero rather than silently replacing a payable → PUT (create-only).
 *   • SALES (ACCRECCREDIT): the number is minted by `nextCreditNoteNumber` under an advisory lock,
 *     so a repeat can only be the SAME credit note re-posting after a lost response — and the
 *     upsert is what makes that converge instead of stranding a document → POST.
 */

const calls: Array<{ method: 'POST' | 'PUT'; path: string; body: Record<string, unknown> }> = []

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: {} }),
    xeroPost: async (path: string, body: Record<string, unknown>) => {
      calls.push({ method: 'POST', path, body })
      return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-external-1', CreditNoteNumber: String(body.CreditNoteNumber), Status: 'AUTHORISED' }] } }
    },
    xeroPut: async (path: string, body: Record<string, unknown>) => {
      calls.push({ method: 'PUT', path, body })
      return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-external-1', CreditNoteNumber: String(body.CreditNoteNumber), Status: 'AUTHORISED' }] } }
    },
  },
})
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: { findOrCreateContact: async () => ({ success: true, contactId: 'contact-1' }) },
})

const creditNotes = () => import('@/lib/connectors/xero/credit-notes')

const base: CreditNoteData = {
  creditNoteNumber: 'SCN-scn-2',
  contactName: 'Freight Co',
  date: '2026-08-20',
  currency: 'GBP',
  lines: [{ description: 'Duplicate freight bill credit', quantity: 1, unitAmount: 120, accountCode: '6200', taxType: 'NONE' }],
  reference: 'PO-ABC',
}

test('a SUPPLIER credit note is created with PUT, so a duplicate number is refused not absorbed (o3d-tfri)', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base)

  assert.equal(result.success, true)
  assert.equal(result.creditNoteId, 'cn-external-1')
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].method,
    'PUT',
    'POST /CreditNotes is upsert-on-CreditNoteNumber: a second credit note on the same PO would REPLACE the first',
  )
  assert.equal(calls[0].path, 'CreditNotes')
  assert.equal(calls[0].body.Type, 'ACCPAYCREDIT')
  assert.equal(calls[0].body.CreditNoteNumber, 'SCN-scn-2')
})

test('two blank-numbered supplier credits on ONE purchase order post as two distinct documents', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  // What `buildSupplierCreditNoteSyncPayload` now produces for two blank-numbered credits recorded
  // against PO-ABC: the same Reference, different CreditNoteNumbers.
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-2' })
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-9' })

  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'PUT'])
  assert.deepEqual(calls.map((c) => c.body.CreditNoteNumber), ['SCN-scn-2', 'SCN-scn-9'])
  assert.deepEqual(calls.map((c) => c.body.Reference), ['PO-ABC', 'PO-ABC'], 'both still carry the PO reference')
})

test('a SALES credit note stays on POST, so a re-post replaces its OWN document (o3d-tfri)', async () => {
  calls.length = 0
  const { pushCreditNote } = await creditNotes()
  const data: CreditNoteData = {
    ...base,
    creditNoteNumber: 'CN2026-00042', // minted by nextCreditNoteNumber — unique by construction
    lines: [{ description: 'Refund', quantity: 1, unitAmount: 50, accountCode: '200', taxType: 'OUTPUT2' }],
  }
  const result = await pushCreditNote(data)

  assert.equal(result.success, true)
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].method,
    'POST',
    'the sales number cannot collide across documents, and the upsert is what lets a retry after a lost ' +
      'response converge instead of stranding a credit note in the ledger with no id in IMS',
  )
  assert.equal(calls[0].body.Type, 'ACCRECCREDIT')
})

test('a supplier credit note missing an account code is refused before any call is made', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote({
    ...base,
    lines: [{ description: 'Freight credit', quantity: 1, unitAmount: 120, accountCode: '' }],
  })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing a purchase\/expense account code/)
  assert.equal(calls.length, 0, 'the verb change must not have moved the pre-flight validation')
})
