import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { CreditNoteData } from '@/lib/connectors/types'

/**
 * o3d-tfri. Xero's `POST /CreditNotes` is CREATE-OR-UPDATE on `CreditNoteNumber`, exactly as
 * `POST /Invoices` is on `InvoiceNumber` (the defect o3d-6l3 fixed for bills by switching to PUT).
 *
 * ROUND 1 gave the two posters OPPOSITE verbs: PUT for the supplier credit note, whose number was
 * whatever the supplier or the operator typed and which nothing made unique, and POST for the sales
 * one, whose number is minted under an advisory lock. The verb is invisible in the payload — it is
 * only the HTTP method — so these tests pin it.
 *
 * ROUND 2 CONVERGED THEM, by removing the premise rather than by analogy. The supplier credit note's
 * ledger number is now `SCN-<primary key>` ALWAYS, so two DIFFERENT supplier credits can no longer
 * reach one number — and once that is true, create-only is the WRONG verb, because Xero's idempotency
 * key expires after six minutes and ACCPAYCREDIT numbers need not be unique: a queued retry after a
 * LOST RESPONSE creates a SECOND credit note and understates payables by the duplicate. Upserting
 * replaces the document with itself and converges, which is verbatim the argument round 1 used to keep
 * the sales side on POST.
 *
 * What is NOT converged is the rule: a poster whose document number is not minted by us belongs on
 * PUT. `pushPurchaseBill` (o3d-6l3) still does, and must.
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

test('a SUPPLIER credit note is posted with POST, so a retry after a lost response converges (o3d-tfri r2)', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base)

  assert.equal(result.success, true)
  assert.equal(result.creditNoteId, 'cn-external-1')
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].method,
    'POST',
    'PUT is create-only, and ACCPAYCREDIT numbers need not be unique in Xero — so a retry after a lost '
      + 'response would CREATE A SECOND credit note and understate payables by the duplicate',
  )
  assert.equal(calls[0].path, 'CreditNotes')
  assert.equal(calls[0].body.Type, 'ACCPAYCREDIT')
  assert.equal(calls[0].body.CreditNoteNumber, 'SCN-scn-2')
})

test('the SAME supplier credit note re-posting after a lost response replaces its own document', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  // The retry sends the identical body — the number comes from the credit note's primary key, so a
  // retry cannot mint a new one. One document number reaching Xero twice is an upsert of itself.
  const first = await pushPurchaseCreditNote(base)
  const retry = await pushPurchaseCreditNote(base)

  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST'])
  assert.deepEqual(calls.map((c) => c.body.CreditNoteNumber), ['SCN-scn-2', 'SCN-scn-2'])
  assert.equal(retry.creditNoteId, first.creditNoteId,
    'the ledger converges on ONE credit note, and IMS gets the id it was missing')
})

test('two supplier credits on ONE purchase order post as two distinct documents', async () => {
  calls.length = 0
  const { pushPurchaseCreditNote } = await creditNotes()
  // What `buildSupplierCreditNoteSyncPayload` produces for two credits recorded against PO-ABC:
  // the same Reference, different CreditNoteNumbers — whatever the operator typed or left blank.
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-2' })
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-9' })

  assert.deepEqual(calls.map((c) => c.body.CreditNoteNumber), ['SCN-scn-2', 'SCN-scn-9'],
    'distinct numbers, so the upsert can never make one replace the other')
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
      'response converge instead of stranding a credit note in the ledger with no id in IMS — the ' +
      'reasoning the supplier side now shares',
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
