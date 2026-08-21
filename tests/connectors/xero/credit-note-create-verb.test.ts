import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { CreditNoteData } from '@/lib/connectors/types'
import type { PurchaseCreditNoteLookup } from '@/lib/domain/purchasing/supplier-credit-note'

/**
 * o3d-tfri. A SUPPLIER credit note must post EXACTLY ONCE, and the case that breaks it is a LOST
 * RESPONSE: the request may have landed, IMS has no id to prove it, and the row retries.
 *
 * ROUND 1 posted create-only (`PUT`), so the replay did not collide — ACCPAYCREDIT numbers need not
 * be unique in Xero — it CREATED A SECOND CREDIT NOTE and understated payables by the duplicate.
 * ROUND 2 went back to `POST` on the reasoning that create-or-update on `CreditNoteNumber` would
 * replace the document with itself and converge. THE VERB CANNOT CARRY THAT: a number Xero does not
 * require to be unique is not a key Xero can be assumed to match on, and settling it means a live
 * call against an organisation holding real payables.
 *
 * ROUND 3 STOPS RESTING ON THE VERB. The replay is recognised BEFORE the create, by asking the
 * ledger whether `SCN-<primary key>` is already there — answerable only because round 1's other half
 * makes that number ours and unique by construction. Found → adopt. Absent on a first attempt →
 * create. Absent on a replay, or unanswerable → REFUSE and name the remedy. These tests pin which of
 * the four happens, because the difference is invisible in the payload.
 */

const calls: Array<{ method: 'GET' | 'POST' | 'PUT'; path: string; body?: Record<string, unknown> }> = []
let getResponse: { ok: boolean; status: number; data?: unknown; error?: string } = {
  ok: true, status: 200, data: { CreditNotes: [] },
}

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      calls.push({ method: 'GET', path })
      return getResponse
    },
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
/**
 * The contact resolve is a WRITE — `findOrCreateContact` creates the supplier in Xero when it is not
 * there — so "nothing was sent" has to include it. Counted separately because it does not go through
 * the api module the `calls` log watches (o3d-tfri r4).
 */
let contactResolves = 0
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: {
    findOrCreateContact: async () => { contactResolves += 1; return { success: true, contactId: 'contact-1' } },
  },
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

/** A lookup that answers without a wire call, for the decisions that are not about the wire. */
const says = (lookup: PurchaseCreditNoteLookup) => async () => lookup
const NOT_IN_LEDGER = says({ ok: true, claims: [] })

/** The sync row's own identity — `SCN-scn-2` is exactly what this primary key mints. */
const CN = { referenceType: 'SupplierCreditNote', referenceId: 'scn-2' }

function reset(response = { ok: true, status: 200, data: { CreditNotes: [] } as unknown }) {
  calls.length = 0
  contactResolves = 0
  getResponse = response
}

// --- the four outcomes -------------------------------------------------------------------------

test('a supplier credit note the ledger does not hold is CREATED, with POST (o3d-tfri r3)', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', { firstAttempt: true, creditNote: CN, lookup: NOT_IN_LEDGER })

  assert.equal(result.success, true)
  assert.equal(result.creditNoteId, 'cn-external-1')
  assert.equal(result.adopted, undefined, 'nothing was there to adopt')
  assert.deepEqual(calls.map((c) => c.method), ['POST'])
  assert.equal(calls[0].path, 'CreditNotes')
  assert.equal(calls[0].body?.Type, 'ACCPAYCREDIT')
  assert.equal(calls[0].body?.CreditNoteNumber, 'SCN-scn-2')
})

test('a replay whose document IS in the ledger adopts its id and sends NOTHING', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', {
    firstAttempt: false,
    creditNote: CN,
    lookup: says({ ok: true, claims: [{ creditNoteId: 'cn-already-there', creditNoteNumber: 'SCN-scn-2', status: 'AUTHORISED' }] }),
  })

  assert.equal(result.success, true)
  assert.equal(result.creditNoteId, 'cn-already-there',
    'the ledger already holds this credit note; IMS was only missing its id')
  assert.equal(result.adopted, true)
  assert.deepEqual(calls, [], 'a second ACCPAYCREDIT would understate payables by the duplicate')
})

test('a replay the ledger cannot vouch for REFUSES rather than creating a second credit note', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', { firstAttempt: false, creditNote: CN, lookup: NOT_IN_LEDGER })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /NOTHING WAS SENT/)
  assert.match(result.error ?? '', /already been dispatched to Xero and its outcome is unknown/)
  assert.match(result.error ?? '', /Check Xero for SCN-scn-2/, 'the refusal must name the remedy, not just the problem')
  assert.deepEqual(calls, [], 'an empty answer is not proof the earlier attempt failed')
})

test('a lookup that could not be answered refuses too — not knowing is not permission', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', {
    firstAttempt: true,
    creditNote: CN,
    lookup: says({ ok: false, error: 'credit-note lookup failed with HTTP 503' }),
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /could not establish whether credit note SCN-scn-2 is already in the ledger/)
  assert.match(result.error ?? '', /HTTP 503/)
  assert.deepEqual(calls, [], 'even on a FIRST attempt: the number may belong to a document a previous row created')
})

test('the ledger holding TWO documents under our number refuses and says payables is understated', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', {
    firstAttempt: false,
    creditNote: CN,
    lookup: says({ ok: true, claims: [
      { creditNoteId: 'cn-a', creditNoteNumber: 'SCN-scn-2', status: 'AUTHORISED' },
      { creditNoteId: 'cn-b', creditNoteNumber: 'SCN-scn-2', status: 'AUTHORISED' },
    ] }),
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /already holds 2 credit notes numbered SCN-scn-2/)
  assert.match(result.error ?? '', /Void the extras in Xero/)
  assert.deepEqual(calls, [])
})

test('a VOIDED document under our number is never adopted — that is a human decision', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', {
    firstAttempt: false,
    creditNote: CN,
    lookup: says({ ok: true, claims: [{ creditNoteId: 'cn-void', creditNoteNumber: 'SCN-scn-2', status: 'VOIDED' }] }),
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /status VOIDED/)
  assert.deepEqual(calls, [], 'linking IMS to a voided document would report a credit the ledger no longer carries')
})

// --- the wire lookup ---------------------------------------------------------------------------

test('the lookup asks for the exact number, as ACCPAYCREDIT, on an explicitly paged request', async () => {
  reset({ ok: true, status: 200, data: { CreditNotes: [] } })
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('SCN-scn-2')

  assert.deepEqual(lookup, { ok: true, claims: [] })
  assert.equal(calls.length, 1)
  assert.equal(
    decodeURIComponent(calls[0].path),
    'CreditNotes?where=Type=="ACCPAYCREDIT" AND CreditNoteNumber=="SCN-scn-2"&page=1&pageSize=100',
    'an unpaged Xero list silently stops at 100, so the page must be asked for explicitly',
  )
})

test('a FULL page is a lookup failure, not an answer', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ CreditNoteID: `cn-${i}`, CreditNoteNumber: 'SCN-scn-2', Type: 'ACCPAYCREDIT', Status: 'AUTHORISED' }))
  reset({ ok: true, status: 200, data: { CreditNotes: hundred } })
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('SCN-scn-2')

  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /filled its page \(100 documents at pageSize 100\)/)
})

test('a body with no CreditNotes array is a lookup failure, never "nobody holds it"', async () => {
  reset({ ok: true, status: 200, data: {} })
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('SCN-scn-2')

  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /returned no CreditNotes array/)
})

test('a row that came back under a DIFFERENT number or type is not a claim on ours', async () => {
  reset({ ok: true, status: 200, data: { CreditNotes: [
    { CreditNoteID: 'cn-other', CreditNoteNumber: 'SCN-scn-20', Type: 'ACCPAYCREDIT', Status: 'AUTHORISED' },
    { CreditNoteID: 'cn-sales', CreditNoteNumber: 'SCN-scn-2', Type: 'ACCRECCREDIT', Status: 'AUTHORISED' },
    { CreditNoteID: 'cn-ours', CreditNoteNumber: 'scn-scn-2', Type: 'ACCPAYCREDIT', Status: 'authorised' },
  ] } })
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('SCN-scn-2')

  assert.deepEqual(lookup, {
    ok: true,
    claims: [{ creditNoteId: 'cn-ours', creditNoteNumber: 'scn-scn-2', status: 'AUTHORISED' }],
  }, 'the filter is Xero\'s; the match is ours, and Xero\'s numbers are case-insensitive')
})

test('a number IMS did not mint is refused as unaskable, and no request is built at all', async () => {
  // The fence rests on SCN-<primary key> being unique by construction. A payload queued before
  // o3d-tfri carries the PURCHASE ORDER's reference, which every credit note on that PO shares —
  // so a document found under it need not be this one, and adopting it would link the wrong id.
  reset()
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('PO-ABC')

  assert.equal(lookup.ok, false)
  assert.equal(lookup.ok === false ? lookup.unaskable : undefined, true, 'no retry can turn a foreign number into ours')
  assert.match(lookup.ok === false ? lookup.error : '', /was not minted by IMS/)
  assert.deepEqual(calls, [], 'nothing may be asked about a number whose answer could not be trusted')
})

test('a number carrying a where-clause quote is refused before anything is sent', async () => {
  reset()
  const { lookupXeroPurchaseCreditNoteByNumber } = await creditNotes()
  const lookup = await lookupXeroPurchaseCreditNoteByNumber('SCN-a"b')

  assert.equal(lookup.ok, false)
  assert.equal(lookup.ok === false ? lookup.unaskable : undefined, true)
  assert.match(lookup.ok === false ? lookup.error : '', /would change the meaning of Xero's quoted where-clause/)
  assert.deepEqual(calls, [])
})

test('the poster runs the LIVE lookup when no seam is supplied, and posts only after it answers', async () => {
  reset({ ok: true, status: 200, data: { CreditNotes: [] } })
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', { firstAttempt: true, creditNote: CN })

  assert.equal(result.success, true)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'], 'the ledger is asked BEFORE the create, never after')
  assert.match(decodeURIComponent(calls[0].path), /CreditNoteNumber=="SCN-scn-2"/)
})

// --- what must not move ------------------------------------------------------------------------

test('a SALES credit note stays on POST and is not fenced (o3d-tfri)', async () => {
  reset()
  const { pushCreditNote } = await creditNotes()
  const data: CreditNoteData = {
    ...base,
    creditNoteNumber: 'CN2026-00042', // minted by nextCreditNoteNumber — unique by construction
    lines: [{ description: 'Refund', quantity: 1, unitAmount: 50, accountCode: '200', taxType: 'OUTPUT2' }],
  }
  const result = await pushCreditNote(data)

  assert.equal(result.success, true)
  assert.deepEqual(calls.map((c) => c.method), ['POST'],
    'Xero ENFORCES ACCRECCREDIT number uniqueness, so a duplicate create is refused by the ledger itself — '
    + 'the sales failure mode is a strand, not a duplicate, and it is unchanged here')
  assert.equal(calls[0].body?.Type, 'ACCRECCREDIT')
})

test('two supplier credits on ONE purchase order still post as two distinct documents', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-2' }, 'AUTHORISED', { firstAttempt: true, creditNote: CN, lookup: NOT_IN_LEDGER })
  await pushPurchaseCreditNote({ ...base, creditNoteNumber: 'SCN-scn-9' }, 'AUTHORISED', {
    firstAttempt: true,
    creditNote: { referenceType: 'SupplierCreditNote', referenceId: 'scn-9' },
    lookup: NOT_IN_LEDGER,
  })

  assert.deepEqual(calls.map((c) => c.body?.CreditNoteNumber), ['SCN-scn-2', 'SCN-scn-9'],
    'distinct numbers, so neither fence nor upsert can make one stand for the other')
  assert.deepEqual(calls.map((c) => c.body?.Reference), ['PO-ABC', 'PO-ABC'], 'both still carry the PO reference')
})

test('a supplier credit note missing an account code is refused before any call is made', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  // Deliberately NO lookup seam, so a fence that ran ahead of the validation would show up as a GET.
  const result = await pushPurchaseCreditNote({
    ...base,
    lines: [{ description: 'Freight credit', quantity: 1, unitAmount: 120, accountCode: '' }],
  }, 'AUTHORISED', { firstAttempt: true, creditNote: CN })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing a purchase\/expense account code/)
  assert.deepEqual(calls, [], 'the fence must not have moved the pre-flight validation, or spent a read before it')
})

// --- o3d-tfri ROUND 4: the number must be PROVED ours, not merely prefixed ----------------------

/**
 * The fence is answerable ONLY because the number is ours and unique by construction — round 3's
 * stated premise. Round 3 tested that premise by asking whether the number `startsWith('SCN-')`,
 * which is a fact about four characters rather than about who minted it.
 *
 * The supplier credit-note number field is optional free text. A supplier's own reference of the
 * shape `SCN-2026-114`, or a purchase-order reference an operator typed as `SCN-1` (and every credit
 * against that PO shares it), passes a prefix test while breaking the premise completely — so the
 * ledger's answer about it is meaningless in BOTH directions: a document found under it may be
 * somebody else's, and one not found says nothing about a replay of ours.
 */
test('r4: an OPERATOR-entered number that merely starts with the prefix is refused, and nothing is sent', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  // Deliberately no lookup seam: a fence that asked the ledger anyway would show up as a GET.
  const result = await pushPurchaseCreditNote(
    { ...base, creditNoteNumber: 'SCN-2026-114' },
    'AUTHORISED',
    { firstAttempt: true, creditNote: CN },
  )

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /NOTHING WAS SENT/)
  assert.match(result.error ?? '', /"SCN-2026-114" was NOT minted by IMS for this credit note/,
    'the refusal names the number that was not ours')
  assert.match(result.error ?? '', /the number IMS mints for it is "SCN-scn-2"/,
    'and the one that would have been, so an operator can see the mismatch')
  assert.deepEqual(calls, [],
    'no lookup and no create: an answer about a number that is not ours cannot license either')
  assert.equal(contactResolves, 0,
    'and not even the contact resolve, which CREATES the supplier in Xero — "nothing sent" means nothing')
})

test('r4: a PO reference shared by every credit on the order is refused rather than adopted', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  // The ledger DOES hold a document under this number — a sibling credit note on the same PO. Round
  // 3's poster would have adopted its id as this credit note's.
  const result = await pushPurchaseCreditNote(
    { ...base, creditNoteNumber: 'SCN-1' },
    'AUTHORISED',
    {
      firstAttempt: false,
      creditNote: CN,
      lookup: says({ ok: true, claims: [{ creditNoteId: 'cn-someone-elses', creditNoteNumber: 'SCN-1', status: 'AUTHORISED' }] }),
    },
  )

  assert.equal(result.success, false, 'a document IMS cannot show is its own is never adopted')
  assert.equal(result.creditNoteId, undefined, 'and no foreign ledger id is handed back to be stored')
  assert.match(result.error ?? '', /was NOT minted by IMS for this credit note/)
  assert.deepEqual(calls, [])
  assert.equal(contactResolves, 0)
})

test('r4: a sync row that does not name a SupplierCreditNote is refused, not looked up', async () => {
  reset()
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', {
    firstAttempt: true,
    // A legacy/mis-queued row: the number cannot be proved against an id that is not a credit note's.
    creditNote: { referenceType: 'PurchaseOrder', referenceId: 'po-9' },
    lookup: NOT_IN_LEDGER,
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /does not identify the IMS supplier credit note it posts/)
  assert.match(result.error ?? '', /referenceType "PurchaseOrder"/)
  assert.deepEqual(calls, [])
  assert.equal(contactResolves, 0)
})

test('r4 control: the genuinely minted number still reaches the ledger and posts', async () => {
  reset({ ok: true, status: 200, data: { CreditNotes: [] } })
  const { pushPurchaseCreditNote } = await creditNotes()
  const result = await pushPurchaseCreditNote(base, 'AUTHORISED', { firstAttempt: true, creditNote: CN })

  assert.equal(result.success, true, 'the proof must not have turned into a blanket refusal')
  assert.equal(result.creditNoteId, 'cn-external-1')
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'],
    'the lookup still runs before the create — the proof is a precondition of the fence, not a replacement for it')
  assert.equal(contactResolves, 1)
})

test('r4: the mint and the proof are ONE definition — the payload builder produces exactly what the poster demands', async () => {
  const { buildSupplierCreditNoteSyncPayload, proveSupplierCreditNoteNumberIsMinted } =
    await import('@/lib/domain/purchasing/supplier-credit-note')
  const payload = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'ckz9abc123',
    creditNoteNumber: 'SCN-2026-114', // the operator's own reference, still deliberately unread
    reference: 'PO-ABC',
    reason: 'Duplicate freight bill',
    supplierName: 'Freight Co',
    supplierId: 'sup-1',
    currency: 'GBP',
    fxRateToBase: 1,
    amountForeign: 120,
    transitAccount: '6200',
    taxType: 'NONE',
    date: '2026-08-20',
  })

  assert.equal(payload.creditNoteNumber, 'SCN-ckz9abc123',
    'the operator-entered number is still not the document number — that is round 2 and it stands')
  const proof = proveSupplierCreditNoteNumberIsMinted({
    creditNoteNumber: payload.creditNoteNumber as string,
    referenceType: 'SupplierCreditNote',
    referenceId: 'ckz9abc123',
  })
  assert.deepEqual(proof, { ok: true, number: 'SCN-ckz9abc123' },
    'what the mint produces is what the proof accepts; if these ever disagree every credit note stops posting')
  const impostor = proveSupplierCreditNoteNumberIsMinted({
    creditNoteNumber: 'SCN-2026-114',
    referenceType: 'SupplierCreditNote',
    referenceId: 'ckz9abc123',
  })
  assert.equal(impostor.ok, false, 'and the operator-shaped number is rejected by the same one definition')
})
