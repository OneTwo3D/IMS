/**
 * Procure-to-pay, full chain (o3d-lgo.6).
 *
 * PO -> receive -> supplier bill, driven through the real IMS UI, posted to the real
 * Xero Demo ledger, and asserted by READING THE BILL BACK OUT OF XERO.
 *
 * No WooCommerce here: this half of the chain starts in the IMS, so it needs no webhook
 * and runs faster than order-to-cash.
 *
 * Like OC-01, the value is in the read-back. e2e/xero.spec.ts:126 already checks that a
 * PURCHASE INVOICE log row appears — which proves the IMS SENT something, not that Xero
 * holds an ACCPAY bill with the right account, supplier and amount.
 */
import { expect, test } from '@playwright/test'
import { currentRunId } from './harness/global-setup.ts'
import { runTag, taggedSku } from './harness/tag.ts'
import {
  cancelPurchaseOrder, createAndSendPo, createBill, markBillPaidViaUi, openPurchaseOrder,
  postSupplierCreditNote, processPendingXeroSyncViaUi, receiveGoods, recordFreightCreditNote,
  returnItems, setPostingMode,
} from './harness/ims.ts'
import { createInventoryProduct } from '../helpers.ts'
import { deleteFxRate, queryRows, seedFxRateAt } from './harness/fx-fixture.ts'
import {
  billIdsForPo, expectJournalLine, expectLine, externalIdFor, externalIdsFor, getCreditNote,
  getInvoice, getInvoiceAttachments, getManualJournal, getPayment, syncLogRowsFor, trackDocument,
} from './harness/xero.ts'
import type { XeroInvoice } from './harness/xero.ts'

test.describe.serial('@full-chain @xero procure to pay', () => {
  let runId: string

  test.beforeAll(async () => {
    runId = currentRunId()
  })

  test.afterAll(async () => {
    // Leave the rig disarmed whatever happened; Xero documents are voided globally.
    await setPostingMode({ sync: false, dailyBatch: false }).catch(() => {})
  })

  test('PP-01: PO -> full receipt -> bill -> ACCPAY bill verified IN Xero', async ({ page }) => {
    test.setTimeout(600_000)

    const sku = taggedSku(runId, 'PP01')
    const reference = `${runTag(runId)}-PP01`
    const qty = 4
    const unitCost = '12.50'
    const expectedNet = Number(unitCost) * qty // 50.00

    // Arm BEFORE the bill is created: queueAccountingSync no-ops while disarmed
    // (accounting.ts:172), so a bill entered first would never queue and the test would
    // hunt a document that was never requested. Same trap as OC-01.
    await setPostingMode({ sync: true, dailyBatch: false })

    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP01`, price: '18.00' })

    const { poId, poReference } = await createAndSendPo(page, { sku, qty: String(qty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })
    await createBill(page, { reference })

    await processPendingXeroSyncViaUi(page)

    // THE POINT: the bill as Xero actually holds it.
    // Resolve the BILL, then its document — PURCHASE_INVOICE is keyed on the bill, not the PO
    // (o3d-9oq), because a sync log that only knows the PO cannot say which bill it is for.
    const [billRecordId] = await billIdsForPo(poId)
    const billId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId })
    trackDocument('Invoices', billId, `PP-01 bill ${runTag(runId)}`)

    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY') // a payable, not a receivable — the mirror of OC-01
    // AUTHORISED, not merely "not DELETED" — that also accepts DRAFT and VOIDED, neither of
    // which is a payable the supplier will ever be paid from.
    expect(bill.Status).toBe('AUTHORISED')
    expect(bill.CurrencyCode).toBe('GBP')
    // Assert the ACTUAL figure, not merely "> 0". The first run of this test posted a
    // £0 bill to Xero because the PO line had no cost, and every structural assertion
    // still passed — a zero-value document is exactly the kind of thing that sails
    // through a "did it sync?" check.
    expect(Number(bill.SubTotal)).toBeCloseTo(expectedNet, 2)

    // Goods received but not yet consumed sit in the transit/clearing account, not
    // straight to COGS — the bill posts EXCLUSIVE of tax against it
    // (transit-gl-reconciliation.ts enumerates PURCHASE_BILL as a transit debit).
    const transitAccount = await settingValue('xero_transit_account')
    expectLine(bill.LineItems, { accountCode: transitAccount, lineAmount: expectedNet })

    // Both of our numbers must survive, in the RIGHT fields (o3d-6l3). Xero's ACCPAY
    // InvoiceNumber means the SUPPLIER's document — and it is the natural key Xero upserts on,
    // so putting our PO reference there let a second instalment overwrite the first. The PO
    // reference belongs in Reference, which is what ties the bill back to the PO from the ledger.
    expect(bill.InvoiceNumber ?? '').toBe(reference)
    // THIS PO's reference, not merely something PO-shaped. `toContain('PO-')` would accept
    // another order's reference and pass while the bill was cross-wired to the wrong PO.
    expect(bill.Reference ?? '').toBe(poReference)

    // --- the STOCK_RECEIPT journal (closes the e2e/xero.spec.ts:134 fixme) -------------
    //
    // That fixme blamed the demo tenant for never surfacing a successful STOCK RECEIPT.
    // It was not the tenant: the journal's Idempotency-Key was 156 chars and Xero 400'd
    // EVERY one, so stock receipt journals never posted on any instance. The 400 body was
    // being discarded, so it only ever read as "HTTP 400".
    //
    // Assert the journal is IN the ledger and balances, so a regression cannot hide as a
    // vague sync error again.
    const journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId })
    trackDocument('ManualJournals', journalId, `PP-01 stock receipt ${runTag(runId)}`)

    const journal = await getManualJournal(journalId)
    // POSTED, not merely "not DELETED" — that accepts DRAFT, and a DRAFT journal is not in the
    // ledger at all. resolveJournalStatus (sync-processor.ts:1025) drafts when the posting mode
    // says so, so a regression that silently drafted everything would satisfy every line and
    // sum assertion below while the books never moved.
    expect(journal.Status).toBe('POSTED')

    // Goods received: stock ASSET up, stock-in-transit down. Receipt and bill are separate
    // events, so the transit account is the hinge between them — get this backwards and
    // inventory and transit both drift, silently.
    const inventoryAccount = await settingValue('xero_inventory_account')
    expectJournalLine(journal.JournalLines, { accountCode: inventoryAccount, debit: expectedNet })
    expectJournalLine(journal.JournalLines, { accountCode: transitAccount, credit: expectedNet })
  })

  test('PP-02: PARTIAL receipt -> Partially Received -> bill the RECEIVED qty only, transit nets to zero', async ({ page }) => {
    test.setTimeout(600_000)

    // Order 4, receive 2. The whole point is that everything downstream follows the RECEIVED
    // quantity, not the ordered one.
    const sku = taggedSku(runId, 'PP02')
    const reference = `${runTag(runId)}-PP02`
    const orderedQty = 4
    const receivedQty = 2
    const unitCost = '12.50'
    const receivedNet = Number(unitCost) * receivedQty // 25.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP02`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(orderedQty), unitCost })

    // A short receipt must land PARTIALLY_RECEIVED, not RECEIVED. receiveGoods asserts the
    // status itself, so a partial that silently books as complete fails here rather than
    // surfacing later as an inexplicable accounting gap.
    await receiveGoods(page, { expectStatus: 'Partially Received', qty: String(receivedQty) })

    await createBill(page, { reference })
    await processPendingXeroSyncViaUi(page)

    // --- the bill: RECEIVED value, never the ordered value.
    //
    // Billing the full order against a part receipt is the classic over-accrual: the supplier
    // has not delivered 2 of the 4, so debiting transit for all 4 leaves 25.00 of goods the
    // ledger believes are in transit and which no receipt will ever clear.
    //
    // TWO defences, and it is worth knowing which is which. The UI merely DEFAULTS the bill to
    // the received qty (po-detail-client.tsx:790-798 — billableCap is bounded by qtyRemaining,
    // which is NET RECEIVED despite the name, not the outstanding order). The real guarantee is
    // SERVER-SIDE: I proved it by breaking the client to demand the ordered qty, and the action
    // refused with "exceeds net received qty 2 — only received, un-returned goods can be billed".
    // So this assertion pins the default; the server is what makes over-accrual impossible.
    const [billRecordId] = await billIdsForPo(poId)
    const billId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId })
    trackDocument('Invoices', billId, `PP-02 bill ${runTag(runId)}`)

    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY')
    expect(bill.Status).toBe('AUTHORISED')
    // Just the one assertion: a subtotal within 0.005 of 25.00 cannot also be within 0.005 of
    // 50.00, so a companion `not.toBeCloseTo(orderedNet)` could never fail on its own. It read
    // as a second safeguard while being dead weight — exactly the kind of assertion this suite
    // exists to distrust.
    expect(Number(bill.SubTotal)).toBeCloseTo(receivedNet, 2)

    const transitAccount = await settingValue('xero_transit_account')
    const inventoryAccount = await settingValue('xero_inventory_account')
    expectLine(bill.LineItems, { accountCode: transitAccount, lineAmount: receivedNet })

    // --- the receipt journal: also the received value only.
    const journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId })
    trackDocument('ManualJournals', journalId, `PP-02 stock receipt ${runTag(runId)}`)

    const journal = await getManualJournal(journalId)
    expect(journal.Status).toBe('POSTED') // see PP-01: "not DELETED" would accept a DRAFT
    expectJournalLine(journal.JournalLines, { accountCode: inventoryAccount, debit: receivedNet })
    expectJournalLine(journal.JournalLines, { accountCode: transitAccount, credit: receivedNet })

    // --- THE POINT: transit nets to ZERO across the pair.
    //
    // The receipt CREDITS transit and the bill DEBITS it, so for goods both received and
    // billed the account must drain completely. A non-zero residue here is exactly what the
    // transit GL reconciliation sweep would later flag as a material gap — and asserting the
    // two documents separately would not catch a sign error or an ordered/received mismatch
    // that happens to balance each document on its own.
    const journalTransitLines = journal.JournalLines.filter((l) => l.AccountCode === transitAccount)
    const billTransitLines = bill.LineItems.filter((l) => l.AccountCode === transitAccount)

    // Prove the filters MATCHED before trusting their sum. Two empty arrays reduce to 0 + 0 = 0
    // and would sail through the balance assertion below — a wrong account code, or a renamed
    // setting, would then read as perfect books. A test that cannot fail is worse than no test.
    expect(journalTransitLines.length, 'the receipt journal must touch transit').toBeGreaterThan(0)
    expect(billTransitLines.length, 'the bill must touch transit').toBeGreaterThan(0)

    const transitFromJournal = journalTransitLines.reduce((sum, l) => sum + l.LineAmount, 0) // Xero signs credits negative
    const transitFromBill = billTransitLines.reduce((sum, l) => sum + (l.LineAmount ?? 0), 0)
    expect(transitFromJournal + transitFromBill).toBeCloseTo(0, 2)
  })

  // The test that found o3d-6l3, now green: every bill used to be sent with InvoiceNumber = the
  // PO's OWN reference, and Xero UPSERTS on InvoiceNumber — so the second instalment overwrote
  // the first and returned its id rather than creating a bill. This is the regression guard.
  test('PP-03: the REMAINDER arrives -> Received -> transit drains to zero across BOTH deliveries', async ({ page }) => {
    test.setTimeout(900_000)

    // Order 4, take delivery of 2 and bill it, then take the other 2 and bill that. The PO ends
    // fully received and fully billed, so by the end transit must hold NOTHING for it: every
    // pound that entered on a receipt has to leave on a bill.
    //
    // Self-contained rather than continuing PP-02's PO. These are describe.serial, so leaning on
    // PP-02's leftovers would make PP-03 pass or fail for reasons in another test — and the
    // couple of seconds saved are not worth a test that cannot be run or diagnosed on its own.
    const sku = taggedSku(runId, 'PP03')
    const orderedQty = 4
    const firstDelivery = 2
    const secondDelivery = 2
    const unitCost = '12.50'
    const perDeliveryNet = Number(unitCost) * firstDelivery // 25.00
    const orderedNet = Number(unitCost) * orderedQty // 50.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP03`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(orderedQty), unitCost })

    // --- delivery 1 of 2, posted before the second arrives.
    //
    // Syncing after EACH delivery rather than batching both at the end, because that is what
    // actually happens: the deliveries are days apart and the 5-minute sync runs in between.
    // Queueing both and draining once compresses into one pass what production never does.
    await receiveGoods(page, { expectStatus: 'Partially Received', qty: String(firstDelivery) })
    await createBill(page, { reference: `${runTag(runId)}-PP03-A`, expectBillCount: 1 })
    await processPendingXeroSyncViaUi(page)

    // --- delivery 2 of 2: the PO completes.
    // Back to the PO first — the sync above navigated to the connector dashboard.
    await openPurchaseOrder(page, poId)
    await receiveGoods(page, { expectStatus: 'Received', qty: String(secondDelivery) })
    await createBill(page, { reference: `${runTag(runId)}-PP03-B`, expectBillCount: 2 })
    await processPendingXeroSyncViaUi(page)

    const transitAccount = await settingValue('xero_transit_account')
    const inventoryAccount = await settingValue('xero_inventory_account')

    // BOTH receipt journals, not "the" one. STOCK_RECEIPT keys on the PO id, so both deliveries
    // file under the same referenceId — externalIdFor would hand back only the later journal and
    // this test would then verify half a story and call it balanced.
    const journalIds = await externalIdsFor({ type: 'STOCK_RECEIPT', referenceId: poId, expected: 2 })
    expect(journalIds.length, 'each delivery books its own receipt journal').toBe(2)
    const journals = []
    for (const [i, id] of journalIds.entries()) {
      trackDocument('ManualJournals', id, `PP-03 receipt ${i + 1} ${runTag(runId)}`)
      const j = await getManualJournal(id)
      expect(j.Status).toBe('POSTED')
      // Each journal carries ITS OWN delivery, not the running total: 25 and 25, never 25 and 50.
      expectJournalLine(j.JournalLines, { accountCode: inventoryAccount, debit: perDeliveryNet })
      expectJournalLine(j.JournalLines, { accountCode: transitAccount, credit: perDeliveryNet })
      journals.push(j)
    }

    // Each bill resolved through ITS OWN id (o3d-9oq), which is stronger than asking the PO for
    // "its bills": it proves bill A's sync log points at bill A's document. Under the old
    // PO-keyed write-back, A and B could be handed each other's Xero ids and a PO-level lookup
    // would still have returned two ids and looked perfect.
    const billRecordIds = await billIdsForPo(poId)
    expect(billRecordIds.length, 'two deliveries, two bills in the IMS').toBe(2)
    const billIds: string[] = []
    for (const rec of billRecordIds) {
      billIds.push(await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: rec }))
    }
    expect(new Set(billIds).size, 'each bill must own a DISTINCT Xero document').toBe(2)
    const bills = []
    for (const [i, id] of billIds.entries()) {
      trackDocument('Invoices', id, `PP-03 bill ${i + 1} ${runTag(runId)}`)
      const b = await getInvoice(id)
      expect(b.Type).toBe('ACCPAY')
      expect(b.Status).toBe('AUTHORISED')
      expect(Number(b.SubTotal)).toBeCloseTo(perDeliveryNet, 2)
      bills.push(b)
    }

    // --- THE POINT: transit holds nothing once everything is received and billed.
    //
    // Four documents, two in each direction. A residue here is precisely what the transit GL
    // reconciliation sweep reports as a material gap — and it is the sweep's whole premise that
    // this account is transient. Summing all four catches what per-document assertions cannot:
    // a second receipt that re-books the first delivery, or a bill that quietly covers the whole
    // order, would leave each document internally balanced and the account wrong.
    const transitLines = [
      ...journals.flatMap((j) => j.JournalLines.filter((l) => l.AccountCode === transitAccount).map((l) => l.LineAmount)),
      ...bills.flatMap((b) => b.LineItems.filter((l) => l.AccountCode === transitAccount).map((l) => l.LineAmount ?? 0)),
    ]
    expect(transitLines.length, 'all four documents must touch transit').toBe(4)
    expect(transitLines.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 2)

    // And the goods really did all land in stock: two debits of 25 make the full order value.
    const inventoryTotal = journals
      .flatMap((j) => j.JournalLines.filter((l) => l.AccountCode === inventoryAccount).map((l) => l.LineAmount))
      .reduce((a, b) => a + b, 0)
    expect(inventoryTotal).toBeCloseTo(orderedNet, 2)
  })

  test('PP-03b: TWO bills drained in ONE sync pass each keep their OWN Xero document', async ({ page }) => {
    test.setTimeout(900_000)

    // The BATCHED case, and the one PP-03 structurally cannot reach: it syncs after each bill,
    // so its two bills never share a sync pass. Production batches by default — the sweep runs
    // every five minutes, so two bills raised in one window post together.
    //
    // That ordering is what o3d-9oq was about. Write-back used to guess "the newest bill on this
    // PO with no external id yet", so with A and B in flight together:
    //   A posts, Xero returns XA -> the guess picks B, and B gets XA
    //   B posts, Xero returns XB -> the guess picks A, and A gets XB
    // The ids end up SWAPPED, silently, and every later edit to A rewrites B's document.
    //
    // A PO-level lookup would still find two ids here and look perfect. Only asking each BILL for
    // its own document catches it — which is why the assertion below is per-bill and compares the
    // reference that identifies that bill.
    const sku = taggedSku(runId, 'PP03B')
    const unitCost = '12.50'
    const refA = `${runTag(runId)}-PP03B-A`
    const refB = `${runTag(runId)}-PP03B-B`

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP03B`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: '4', unitCost })

    // Two deliveries, two bills, NO sync in between — both sit in the queue together.
    await receiveGoods(page, { expectStatus: 'Partially Received', qty: '2' })
    await createBill(page, { reference: refA, expectBillCount: 1 })
    await receiveGoods(page, { expectStatus: 'Received', qty: '2' })
    await createBill(page, { reference: refB, expectBillCount: 2 })

    await processPendingXeroSyncViaUi(page) // one pass, both bills

    const billRecordIds = await billIdsForPo(poId)
    expect(billRecordIds.length).toBe(2)

    // Each IMS bill must resolve to the document that IS that bill. Under the swap, bill A's
    // record pointed at bill B's document — both bills exist, both are 25.00, and only the
    // reference distinguishes them. So the reference is the assertion that matters.
    const seenIds = new Set<string>()
    const expectedRefs = [refA, refB]
    for (const [i, rec] of billRecordIds.entries()) {
      const xeroId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: rec })
      trackDocument('Invoices', xeroId, `PP-03b bill ${i + 1} ${runTag(runId)}`)
      seenIds.add(xeroId)

      const bill = await getInvoice(xeroId)
      expect(bill.Type).toBe('ACCPAY')
      expect(Number(bill.SubTotal)).toBeCloseTo(Number(unitCost) * 2, 2)
      expect(
        bill.InvoiceNumber ?? '',
        `IMS bill ${i + 1} must point at ITS OWN Xero document, not its sibling's`,
      ).toBe(expectedRefs[i])
    }
    expect(seenIds.size, 'two bills must not share one ledger document').toBe(2)
  })

  test('PP-04: cancelling a part-received PO reverses the stock — inventory AND transit unwind to zero', async ({ page }) => {
    test.setTimeout(900_000)

    // Cancellation is gated to DRAFT or PARTIALLY_RECEIVED (po-detail-client.tsx:1924), so the
    // case with any accounting in it is the partial one: goods have arrived, and cancelling has
    // to put the books back exactly as they were.
    //
    // NOTE ON NAMING — the plan calls this "PURCHASE_ORDER_CANCEL postings", which is not what
    // the code does. PURCHASE_ORDER_CANCEL is the TRANSIT SUBLEDGER's sourceType
    // (transit-subledger-movement.ts:33); the journal itself is queued as an
    // INVENTORY_ADJUSTMENT (cancellation-service.ts:208). Asserting the plan's name would hunt a
    // sync type that never gets written.
    const sku = taggedSku(runId, 'PP04')
    const orderedQty = 4
    const receivedQty = 2
    const unitCost = '12.50'
    const receivedNet = Number(unitCost) * receivedQty // 25.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP04`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(orderedQty), unitCost })
    await receiveGoods(page, { expectStatus: 'Partially Received', qty: String(receivedQty) })

    // Post the receipt BEFORE cancelling, and PROVE it landed before going on.
    //
    // An earlier draft merely drained here and asserted the receipt at the end, with a comment
    // claiming the ordering. That claim was untrue: processPendingXeroSyncViaUi only waits for a
    // generic "Sync complete", so a first pass that quietly left the receipt PENDING would post
    // both documents together in the second drain and every assertion below would still pass.
    // "Two journals that cancel out" is exactly as true when neither happened, so the receipt has
    // to be IN the ledger before the cancel for the reversal to mean anything.
    await processPendingXeroSyncViaUi(page)
    const receiptId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId })
    trackDocument('ManualJournals', receiptId, `PP-04 receipt ${runTag(runId)}`)
    const receipt = await getManualJournal(receiptId)
    expect(receipt.Status, 'the receipt must be in the ledger BEFORE the cancel').toBe('POSTED')

    await openPurchaseOrder(page, poId)

    await cancelPurchaseOrder(page, { expectStatus: 'Cancelled' })
    await processPendingXeroSyncViaUi(page)

    const transitAccount = await settingValue('xero_transit_account')
    const inventoryAccount = await settingValue('xero_inventory_account')

    // The receipt (already fetched and proven POSTED above): DR inventory / CR transit.
    expectJournalLine(receipt.JournalLines, { accountCode: inventoryAccount, debit: receivedNet })
    expectJournalLine(receipt.JournalLines, { accountCode: transitAccount, credit: receivedNet })

    // The cancellation: the mirror image, DR transit / CR inventory.
    //
    // EXACTLY ONE, not "the newest". externalIdFor takes `limit 1 ORDER BY createdAt DESC`, so a
    // regression that queued a spurious adjustment ALONGSIDE the correct one would hand back only
    // the correct one — every assertion here would pass while the ignored journal left inventory
    // and transit non-zero in the real ledger. The sync has drained by now, so any sibling would
    // already be SYNCED and counted.
    const reversalIds = await externalIdsFor({ type: 'INVENTORY_ADJUSTMENT', referenceId: poId, expected: 1 })
    expect(reversalIds.length, 'a cancellation books ONE reversal, not several').toBe(1)
    const [reversalId] = reversalIds
    trackDocument('ManualJournals', reversalId, `PP-04 cancel reversal ${runTag(runId)}`)
    const reversal = await getManualJournal(reversalId)
    expect(reversal.Status).toBe('POSTED')
    // Distinct documents. Not guaranteed by the types differing: externalTransactionId is
    // nullable and carries no cross-type uniqueness, so two logs CAN be cross-wired to one id.
    expect(reversalId).not.toBe(receiptId)
    expectJournalLine(reversal.JournalLines, { accountCode: transitAccount, debit: receivedNet })
    expectJournalLine(reversal.JournalLines, { accountCode: inventoryAccount, credit: receivedNet })

    // --- THE POINT: the cancelled PO leaves NOTHING behind in either account.
    //
    // Goods that arrived and then un-arrived must not linger as stock the IMS believes it owns,
    // nor as value stranded in transit. Asserting each journal alone would miss a reversal that
    // balances internally while hitting the wrong pair of accounts — it is the SUM across both
    // documents, per account, that has to be zero.
    const sumFor = (account: string) =>
      [receipt, reversal]
        .flatMap((j) => j.JournalLines.filter((l) => l.AccountCode === account))
        .reduce((a, l) => a + l.LineAmount, 0)

    const inventoryLines = [receipt, reversal].flatMap((j) => j.JournalLines.filter((l) => l.AccountCode === inventoryAccount))
    const transitLines = [receipt, reversal].flatMap((j) => j.JournalLines.filter((l) => l.AccountCode === transitAccount))
    expect(inventoryLines.length, 'both journals must touch inventory').toBe(2)
    expect(transitLines.length, 'both journals must touch transit').toBe(2)

    expect(sumFor(inventoryAccount)).toBeCloseTo(0, 2)
    expect(sumFor(transitAccount)).toBeCloseTo(0, 2)
  })

  test('PP-05: returning goods to the supplier posts an ACCPAYCREDIT and ALLOCATES it to the bill', async ({ page }) => {
    test.setTimeout(900_000)

    // The first case in this suite where the credit has to LAND ON something: an ACCPAYCREDIT
    // that exists but is not allocated leaves the bill fully payable, so the supplier gets paid
    // for goods that went back. Asserting the credit document alone would pass in exactly that
    // situation — the allocation is the point.
    const sku = taggedSku(runId, 'PP05')
    const reference = `${runTag(runId)}-PP05`
    const orderedQty = 4
    const returnedQty = 2
    const unitCost = '12.50'
    const orderedNet = Number(unitCost) * orderedQty // 50.00
    const returnedNet = Number(unitCost) * returnedQty // 25.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP05`, price: '18.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(orderedQty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })
    await createBill(page, { reference })

    // DRAIN BEFORE RETURNING, and this ordering is load-bearing rather than tidiness.
    //
    // postSupplierCreditNote threads allocateToInvoiceId from the bill's accountingInvoiceId
    // (purchase-orders.ts:3749), and enqueuePurchaseCreditNoteFollowUps bails outright when it is
    // null (sync-processor.ts:1731). So a bill that has not yet reached Xero when the credit is
    // posted yields NO allocation at all — the credit note would post, this test would find it,
    // and the bill would quietly stay fully due. The bill must own a Xero id first.
    await processPendingXeroSyncViaUi(page)
    // billIdsForPo returns the IMS purchase_invoices.id; the Xero InvoiceID (a GUID) is resolved
    // from it via externalIdFor, exactly as PP-01/PP-02 do. Tracking or GETting the IMS cuid
    // straight from Xero 404s — which is how this first showed up.
    const [billRecordId] = await billIdsForPo(poId)
    const billId = await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId })
    trackDocument('Invoices', billId, `PP-05 bill ${runTag(runId)}`)
    const billBefore = await getInvoice(billId)
    expect(billBefore.Status, 'the bill must be in the ledger BEFORE the credit is posted').toBe('AUTHORISED')
    expect(Number(billBefore.SubTotal)).toBeCloseTo(orderedNet, 2)
    const billTotal = Number(billBefore.Total)

    await openPurchaseOrder(page, poId)
    await returnItems(page, {
      qty: String(returnedQty),
      reason: 'Damaged on arrival',
      expectStatus: 'Partially Returned', // 2 of 4 back: partially, not fully, returned
    })

    // The return only DRAFTS the credit note; an operator posts it. Both are needed, and the
    // draft only happens at all because the PO is already billed (purchase-orders.ts:2405).
    await postSupplierCreditNote(page)

    // TWO passes, not one. Both sync processors snapshot their batch at run start, and the
    // ALLOCATION is only enqueued as a follow-up DURING the credit note's own pass
    // (sync-processor.ts:1715). A single drain posts the ACCPAYCREDIT and leaves the allocation
    // sitting pending — which is precisely the failure this test exists to catch, so it must not
    // be the failure the test itself causes.
    await processPendingXeroSyncViaUi(page)
    await processPendingXeroSyncViaUi(page)

    const transitAccount = await settingValue('xero_transit_account')
    const inventoryAccount = await settingValue('xero_inventory_account')

    // --- the return's stock reversal: DR transit / CR inventory.
    //
    // Keyed on the RETURN's id, not the PO's — unlike PP-04's cancellation adjustment, which
    // keys on poId (purchase-orders.ts:2458). Same AccountingSyncType, different referenceId;
    // passing poId here finds nothing and times out looking like a missing journal.
    const returnId = await purchaseReturnIdFor(poId)
    const adjustmentId = await externalIdFor({ type: 'INVENTORY_ADJUSTMENT', referenceId: returnId })
    trackDocument('ManualJournals', adjustmentId, `PP-05 return reversal ${runTag(runId)}`)

    const adjustment = await getManualJournal(adjustmentId)
    expect(adjustment.Status).toBe('POSTED')
    // The FIFO-consumed cost of the returned units, which for a single-receipt PO at one unit
    // cost is simply qty x cost. Transit is DEBITED: the goods are heading back out.
    expectJournalLine(adjustment.JournalLines, { accountCode: transitAccount, debit: returnedNet })
    expectJournalLine(adjustment.JournalLines, { accountCode: inventoryAccount, credit: returnedNet })

    // --- the ACCPAYCREDIT itself.
    const creditNoteRowId = await supplierCreditNoteIdFor(poId)
    const creditNoteId = await externalIdFor({ type: 'PURCHASE_CREDIT_NOTE', referenceId: creditNoteRowId })
    trackDocument('CreditNotes', creditNoteId, `PP-05 supplier credit ${runTag(runId)}`)

    const creditNote = await getCreditNote(creditNoteId)
    expect(creditNote.Type).toBe('ACCPAYCREDIT') // payable credit — the mirror of OC-05's ACCRECCREDIT
    // PAID, not AUTHORISED: this credit (25.00) is fully consumed by its allocation to the larger
    // bill (50.00), and Xero moves a fully-allocated credit note to PAID — which is itself proof the
    // allocation landed, the whole point of PP-05. AUTHORISED would be the status of a credit that
    // posted but never allocated, i.e. the bug this test guards against. (Still not DRAFT/DELETED.)
    expect(creditNote.Status).toBe('PAID')
    expect(creditNote.CurrencyCode).toBe('GBP')
    // The credit lands on TRANSIT, not inventory (supplier-credit-note.ts:153): the stock left
    // via the adjustment above, and this is the money leg catching up with it.
    expectLine(creditNote.LineItems, { accountCode: transitAccount })

    // --- THE POINT: the credit is ALLOCATED, so the bill is no longer fully payable.
    //
    // Asserted by reading the BILL back, not by looking up the allocation's own document, because
    // PURCHASE_CREDIT_NOTE_ALLOCATION stores NO externalTransactionId by design (sync-processor.ts:1334)
    // — externalIdFor would throw on it. The bill's AmountDue is the observable that actually
    // matters to whoever pays the supplier.
    // Pin the credit to the RETURNED half, absolutely — not merely > 0. A credit for the whole bill
    // (or any wrong amount) would otherwise slip through: the AmountDue check below subtracts the
    // SAME observed creditTotal, so it stays self-consistent whatever the credit is worth (Codex
    // review of PR #495). SubTotal ties it to returnedNet; the gross is the matching half of the
    // bill (2 of 4 units at one rate).
    const creditTotal = Number(creditNote.Total)
    expect(Number(creditNote.SubTotal), 'the credit is for the returned 2 units, not the whole order')
      .toBeCloseTo(returnedNet, 2)
    expect(creditTotal, 'gross credit is the returned half of the bill').toBeCloseTo(billTotal / 2, 2)

    const billAfter = await getInvoice(billId)
    expect(Number(billAfter.Total), 'allocating a credit must not alter the bill itself').toBeCloseTo(billTotal, 2)
    // Absolute expected balance: full bill minus the (now-pinned) returned-half credit.
    expect(
      Number(billAfter.AmountDue),
      'the allocation must reduce AmountDue by exactly the returned-half credit',
    ).toBeCloseTo(billTotal - creditTotal, 2)
  })

  test('PP-07: an inline landed cost distributes BY VALUE across SKUs and ties transit out to zero', async ({ page }) => {
    test.setTimeout(600_000)

    // A PO can carry landed costs (freight, duty) on top of goods; on receipt they must distribute across the
    // received cost layers BY_VALUE (by EXTENDED line value = qty × unit cost) so each SKU is valued at its
    // TRUE landed cost, not the bare goods price.
    //
    // The lines use UNEQUAL QUANTITIES so the extended-value ratio differs from the unit-cost ratio — a bug
    // that weighted by unit price instead of qty × unit price would land a DIFFERENT (wrong) per-SKU cost and
    // be caught, and so would dump-on-one-line or equal-split:
    //   A: 2 @ £30 = £60 goods   B: 4 @ £10 = £40 goods   goods total £100   freight £40 (BY_VALUE)
    //   correct (extended value): A = 40 × 60/100 = £24 -> A unit = (60+24)/2 = £42
    //                             B = 40 × 40/100 = £16 -> B unit = (40+16)/4 = £14
    //   (a unit-price-basis bug would give A £45 / B £12.50 — distinct, so it fails here.)
    // Aggregate: inventory DR £140, stock-in-transit CR £140 at receipt; the bill debits transit £140; so
    // transit NETS TO ZERO across the two Xero documents (the imbalance an unbilled freight would strand).
    const skuA = taggedSku(runId, 'PP07A')
    const skuB = taggedSku(runId, 'PP07B')
    const reference = `${runTag(runId)}-PP07`
    const qtyA = 2
    const qtyB = 4
    const landedTotal = 60 + 40 + 40 // 140.00 — full landed value (goodsA + goodsB + freight)
    const expectedUnitA = (60 + 40 * (60 / 100)) / qtyA // (60 + 24) / 2 = 42.00
    const expectedUnitB = (40 + 40 * (40 / 100)) / qtyB // (40 + 16) / 4 = 14.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku: skuA, name: `${runTag(runId)} PP07A`, price: '60.00' })
    await createInventoryProduct(page, { sku: skuB, name: `${runTag(runId)} PP07B`, price: '25.00' })

    const { poId } = await createAndSendPo(page, {
      sku: skuA,
      qty: String(qtyA),
      unitCost: '30.00',
      extraLines: [{ sku: skuB, qty: String(qtyB), unitCost: '10.00' }],
      additionalCost: { description: 'Shipping', amount: '40', distributionMethod: 'BY_VALUE' },
    })
    await receiveGoods(page, { expectStatus: 'Received' })
    // Bill BOTH the goods AND the landed cost — the receipt credited transit for the full £140, so the bill
    // must debit transit for £140 too or a permanent transit balance is stranded.
    await createBill(page, { reference, includeAdditionalCosts: true })

    // Drain, then register BOTH posted documents in a FINALLY — the drain can post the bill + journal and
    // THEN throw on the UI confirmation, and teardown only voids tracked ids. The registration is the very
    // first thing to run afterwards (before any fallible settings read or assertion), and each lookup is
    // independent (.catch -> '') so a failed resolve of one still registers the other.
    let journalId = ''
    let billId = ''
    try {
      await processPendingXeroSyncViaUi(page)
    } finally {
      journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
      const billRecordId = (await billIdsForPo(poId).catch((): string[] => []))[0]
      billId = billRecordId ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId }).catch(() => '') : ''
      if (journalId) trackDocument('ManualJournals', journalId, `PP-07 stock receipt ${runTag(runId)}`)
      if (billId) trackDocument('Invoices', billId, `PP-07 bill ${runTag(runId)}`)
    }
    expect(journalId, 'the STOCK_RECEIPT journal posted to Xero').toBeTruthy()
    expect(billId, 'the ACCPAY bill posted to Xero').toBeTruthy()
    const inventoryAccount = await settingValue('xero_inventory_account')
    const transitAccount = await settingValue('xero_transit_account')

    // 1) Each SKU's cost layer carries its OWN landed unit cost — proving BY_VALUE distribution, not mere
    //    inclusion. A: £45, B: £15 (from the IMS subledger).
    const unitCostFor = async (sku: string, expectedQty: number): Promise<number> => {
      const rows = await queryRows<{ unitCostBase: string; receivedQty: string }>(
        `select cl."unitCostBase", cl."receivedQty" from cost_layers cl
           join products p on p.id = cl."productId"
          where p.sku = $1 order by cl."receivedAt" desc limit 1`,
        [sku],
      )
      expect(rows.length, `the receipt created a cost layer for ${sku}`).toBe(1)
      expect(Number(rows[0].receivedQty)).toBeCloseTo(expectedQty, 4)
      return Number(rows[0].unitCostBase)
    }
    expect(await unitCostFor(skuA, qtyA), 'A: landed unit = (goods 60 + BY_VALUE freight 24) / 2 = £42').toBeCloseTo(expectedUnitA, 2)
    expect(await unitCostFor(skuB, qtyB), 'B: landed unit = (goods 40 + BY_VALUE freight 16) / 4 = £14').toBeCloseTo(expectedUnitB, 2)

    // 2) The STOCK_RECEIPT journal moves the FULL LANDED value and BALANCES: the inventory-account lines total
    //    a £120 debit, the transit-account lines a £120 credit. Summed across ALL lines per account (not a
    //    single existential line) so an extra unexpected line cannot hide. (Already registered for teardown.)
    const journal = await getManualJournal(journalId)
    expect(journal.Status).toBe('POSTED')
    const journalSumFor = (account: string) =>
      journal.JournalLines.filter((l) => l.AccountCode === account).reduce((s, l) => s + l.LineAmount, 0)
    // ManualJournal LineAmount is signed: + = debit, − = credit (expectJournalLine convention).
    const journalInventory = journalSumFor(inventoryAccount)
    const journalTransit = journalSumFor(transitAccount)
    expect(journalInventory, 'receipt debits inventory for the full landed value').toBeCloseTo(landedTotal, 2)
    expect(journalTransit, 'receipt credits transit for the full landed value').toBeCloseTo(-landedTotal, 2)

    // 3) The ACCPAY bill covers the FULL £120 and DEBITS transit for £120 (goods + freight lines).
    //    (Already registered for teardown.)
    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY')
    expect(bill.Status).toBe('AUTHORISED')
    expect(Number(bill.SubTotal), 'bill covers goods + landed cost, not goods alone').toBeCloseTo(landedTotal, 2)
    const billTransit = bill.LineItems
      .filter((l) => l.AccountCode === transitAccount)
      .reduce((sum, l) => sum + (l.LineAmount ?? 0), 0)
    expect(billTransit, 'bill debits transit for the full landed value (goods + freight)').toBeCloseTo(landedTotal, 2)

    // 4) THE TIE-OUT: the receipt's signed transit credit (−£120) and the bill's transit debit (+£120) net to
    //    ZERO across both Xero documents. A goods-only bill (or a non-transit freight line) would leave a
    //    residual — this is the aggregate signed balance, not two existential checks.
    expect(journalTransit + billTransit, 'transit nets to zero across the receipt journal and the bill').toBeCloseTo(0, 2)
  })

  test('PP-10: a bill carrying a supplier-invoice PDF attaches it to the Xero bill', async ({ page }) => {
    test.setTimeout(600_000)

    // The BILL_ATTACHMENT follow-up: a supplier invoice PDF uploaded with the bill must ride the sync all the
    // way onto the Xero bill as an attachment, not merely sit in the IMS. enqueuePurchaseInvoiceFollowUps
    // enqueues it ONLY when the bill carries a supplierInvoicePath, and it uploads on a LATER drain — the
    // attachment needs the bill's Xero id first — so this drains twice and then reads the bill's Attachments
    // back out of Xero. A "did it sync?" check on the bill alone cannot see whether the file actually landed.
    const sku = taggedSku(runId, 'PP10')
    const reference = `${runTag(runId)}-PP10`
    const qty = 3
    const unitCost = '15.00'
    const expectedNet = Number(unitCost) * qty // 45.00

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP10`, price: '20.00' })

    const { poId, poReference } = await createAndSendPo(page, { sku, qty: String(qty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })
    // Attach the supplier invoice PDF as part of creating the bill.
    await createBill(page, { reference, attachPdf: true })

    let journalId = ''
    let billId = ''
    try {
      // First drain posts the bill + STOCK_RECEIPT journal and enqueues BILL_ATTACHMENT; the attachment uploads
      // on a later drain (it needs the bill's Xero id, like the payment follow-up), so drain twice.
      await processPendingXeroSyncViaUi(page)
      await processPendingXeroSyncViaUi(page)
    } finally {
      // Register both posted documents failure-safe (PP-07): the receipt journal is invisible to the straggler
      // scan, and the drain can post then throw. Each lookup independent so a failed resolve still registers
      // the other. The attachment is part of the bill and is voided with it — no separate teardown.
      //
      // GUARD before tracking the bill: only register an id we can INDEPENDENTLY confirm is THIS run's bill —
      // its supplier InvoiceNumber is our unique reference. externalTransactionId comes from the sync log,
      // which is part of the mapping under test; a stale/aliased id must never schedule an unrelated bill for
      // irreversible voiding in the Demo ledger shared with stage.
      journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
      const billRecordId = (await billIdsForPo(poId).catch((): string[] => []))[0]
      const candidateBillId = billRecordId
        ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId }).catch(() => '')
        : ''
      if (candidateBillId) {
        const confirm = await getInvoice(candidateBillId).catch(() => null)
        if (confirm?.InvoiceNumber === reference) billId = candidateBillId
      }
      if (journalId) trackDocument('ManualJournals', journalId, `PP-10 stock receipt ${runTag(runId)}`)
      if (billId) trackDocument('Invoices', billId, `PP-10 bill ${runTag(runId)}`)
    }
    expect(billId, 'the ACCPAY bill posted to Xero AND is confirmed to be this run\'s bill').toBeTruthy()

    const bill = await getInvoice(billId)
    expect(bill.Type).toBe('ACCPAY')
    expect(bill.Status).toBe('AUTHORISED')
    expect(Number(bill.SubTotal)).toBeCloseTo(expectedNet, 2)
    // Identity, so a stale/aliased external id cannot pass against another £45 bill (PP-01's discipline):
    // InvoiceNumber is our unique supplier reference, Reference is THIS PO's reference.
    expect(bill.InvoiceNumber ?? '', 'the bill carries our unique supplier reference').toBe(reference)
    expect(bill.Reference ?? '', 'the bill ties back to THIS PO').toBe(poReference)

    // THE POINT: the supplier invoice PDF is attached to the bill IN Xero. The attachment uploads
    // asynchronously on the follow-up drain, so poll the live ledger rather than reading once.
    await expect
      .poll(async () => (await getInvoiceAttachments(billId).catch(() => [])).length, {
        timeout: 60_000,
        message: 'the supplier-invoice PDF should be attached to the Xero bill',
      })
      .toBeGreaterThan(0)
    const attachments = await getInvoiceAttachments(billId)
    // OUR PDF specifically, not merely "a PDF": the upload sanitiser keeps the original base name
    // (`<timestamp>-<safeBase>.pdf`, upload-validation.ts), and we named the file with this run's unique
    // reference, so the Xero attachment name must contain it. Accepting any PDF would let an unrelated
    // attachment satisfy the test.
    const ours = attachments.find((a) => a.FileName.includes(reference))
    expect(ours, `an attachment named for this run (${reference}) is on the Xero bill`).toBeTruthy()
    expect(
      ours!.FileName.toLowerCase().endsWith('.pdf') || (ours!.MimeType ?? '').includes('pdf'),
      'the attached file is a PDF',
    ).toBe(true)
  })

  test('PP-06: a manually-recorded freight credit note posts an ACCPAYCREDIT on transit and allocates to the bill', async ({ page }) => {
    test.setTimeout(900_000)

    // PP-05 credited a GOODS return (a return-generated draft). PP-06 is the OTHER supplier-credit path: an
    // operator credits an over-charged / duplicate FREIGHT bill BY HAND (recordSupplierFreightCreditNote), with
    // no goods movement at all. It must still post as an ACCPAYCREDIT on the TRANSIT account — freight is
    // capitalised via transit (PP-07 bills it there), so its reversal lands there too — and, the point, ALLOCATE
    // to the bill so the supplier is not paid for freight that was refunded. A credit that posts but never
    // allocates leaves the bill fully payable, which is exactly the bug this guards.
    const sku = taggedSku(runId, 'PP06')
    const reference = `${runTag(runId)}-PP06`
    const goodsQty = 4
    const unitCost = '10.00'            // goods net 40.00
    const freight = '30.00'            // inline freight, billed with the goods (debits transit)
    const freightCreditGross = '30.00' // credit the whole freight back — GROSS, and <= the bill total

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP06`, price: '18.00' })

    const { poId } = await createAndSendPo(page, {
      sku, qty: String(goodsQty), unitCost,
      additionalCost: { description: 'Freight', amount: freight, distributionMethod: 'BY_VALUE' },
    })
    await receiveGoods(page, { expectStatus: 'Received' })
    await createBill(page, { reference, includeAdditionalCosts: true })

    // Drain to post the bill AND the landed-cost STOCK_RECEIPT journal, registering BOTH in a FINALLY first.
    // The inline freight makes the receipt journal post in sync mode too (PP-07), and the drain can post both
    // then throw on the UI confirmation; teardown only voids tracked ids and its straggler scan does not find
    // manual journals, so an untracked receipt journal leaks SILENTLY. Each lookup is independent (.catch) so a
    // failed resolve of one still registers the other. The bill must own a Xero id BEFORE the credit is posted
    // (PP-05's lesson): the allocation follow-up bails on a null accountingInvoiceId, leaving the credit posted
    // but the bill fully due.
    let journalId = ''
    let billId = ''
    try {
      await processPendingXeroSyncViaUi(page)
    } finally {
      journalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
      const billRecordId = (await billIdsForPo(poId).catch((): string[] => []))[0]
      billId = billRecordId ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId }).catch(() => '') : ''
      if (journalId) trackDocument('ManualJournals', journalId, `PP-06 stock receipt ${runTag(runId)}`)
      if (billId) trackDocument('Invoices', billId, `PP-06 bill ${runTag(runId)}`)
    }
    expect(journalId, 'the landed-cost STOCK_RECEIPT journal posted to Xero').toBeTruthy()
    expect(billId, 'the ACCPAY bill posted to Xero').toBeTruthy()
    const billBefore = await getInvoice(billId)
    expect(billBefore.Status, 'the bill must be in the ledger before the credit is posted').toBe('AUTHORISED')
    const billTotal = Number(billBefore.Total)

    // Record the freight credit BY HAND, then post it (PP-05: the draft exists, an operator posts it).
    await openPurchaseOrder(page, poId)
    await recordFreightCreditNote(page, { amount: freightCreditGross, creditNoteNumber: `CN-${reference}`, reason: 'Freight over-charged' })
    await postSupplierCreditNote(page)

    try {
      // TWO drains (PP-05): the ALLOCATION is a follow-up enqueued DURING the credit note's own pass, so a
      // single drain posts the ACCPAYCREDIT and leaves the allocation pending — the very failure under test.
      await processPendingXeroSyncViaUi(page)
      await processPendingXeroSyncViaUi(page)

      const transitAccount = await settingValue('xero_transit_account')

      // This is the MANUAL freight credit (isReturnGenerated=false), not a return-generated one, so it needs
      // its own oracle — supplierCreditNoteIdFor filters on isReturnGenerated=true and would not find it.
      const creditNoteId = await externalIdFor({ type: 'PURCHASE_CREDIT_NOTE', referenceId: await freightCreditNoteIdFor(poId) })
      trackDocument('CreditNotes', creditNoteId, `PP-06 freight credit ${runTag(runId)}`)

      const creditNote = await getCreditNote(creditNoteId)
      expect(creditNote.Type).toBe('ACCPAYCREDIT')
      // PAID, not AUTHORISED: the credit (30) is fully consumed by its allocation to the larger bill, and Xero
      // moves a fully-allocated credit note to PAID — itself proof the allocation landed. AUTHORISED would be an
      // unallocated credit, the bug this test guards against. (Still not DRAFT/DELETED.)
      expect(creditNote.Status).toBe('PAID')
      expect(creditNote.CurrencyCode).toBe('GBP')
      // The freight credit reverses on the TRANSIT account (supplier-credit-note.ts builds the line on transit),
      // mirroring where PP-07 billed the freight.
      expectLine(creditNote.LineItems, { accountCode: transitAccount })
      // The credit is the GROSS freight we entered. It posts tax-inclusive, so Total equals the entered gross
      // whatever VAT the bill's tax type mirrors — VAT-robust, no dependence on whether the bill was taxed.
      const creditTotal = Number(creditNote.Total)
      expect(creditTotal, 'the credit is the entered gross freight amount').toBeCloseTo(Number(freightCreditGross), 2)

      // THE POINT: the credit is ALLOCATED, so the bill is no longer fully payable — reduced by exactly the credit.
      const billAfter = await getInvoice(billId)
      expect(Number(billAfter.Total), 'allocating a credit must not alter the bill itself').toBeCloseTo(billTotal, 2)
      expect(
        Number(billAfter.AmountDue),
        'the allocation reduces AmountDue by exactly the freight credit',
      ).toBeCloseTo(billTotal - creditTotal, 2)
    } finally {
      // Failure-safe: if an assertion threw AFTER the ACCPAYCREDIT posted, register it anyway. An allocated
      // credit note left untracked strands BOTH documents — teardown then can't void the bill (Xero refuses a
      // bill that has an allocation) and never sees the credit. Registering both lets teardown un-allocate and
      // void the pair.
      const cnRow = await freightCreditNoteIdFor(poId).catch(() => null)
      if (cnRow) {
        const cnXero = await externalIdFor({ type: 'PURCHASE_CREDIT_NOTE', referenceId: cnRow }).catch(() => null)
        if (cnXero) trackDocument('CreditNotes', cnXero, `PP-06 freight credit ${runTag(runId)}`)
      }
    }
  })

  // This test surfaced o3d-lgo.6.1 and now guards its fix. Originally it asserted a POSTED
  // REALISED_FX_JOURNAL; that journal's control leg is getRealisedFxAccounts().controlAccount = the Accounts
  // Payable account (setting xero_accounts_payable_account = 800 on BOTH the rig and stage), and Xero 800 is
  // a SYSTEM control account (CURRLIAB). Xero refuses manual-journal lines to system accounts, so
  // pushManualJournal 400'd with "Account code '800' is not a valid code for this document" and the journal
  // never posted — on the rig AND on stage, unnoticed because no prior e2e test had posted an FX journal to
  // real Xero. The fix (o3d-lgo.6.1, Jan's call) is SUPPRESS-FOR-XERO: Xero auto-posts realised currency
  // gains/losses natively when a foreign bill settles, so an IMS journal for the same movement was both
  // illegal and double-counting.
  //
  // So the assertion inverts: with every condition for a material realised FX gain genuinely met, the
  // BILL_PAYMENT still settles the bill and NO REALISED_FX_JOURNAL is queued AT ALL. "Not queued" is the
  // claim — a FAILED row would mean the defect is back, and asserting only "no journal in Xero" would pass
  // for the broken state too (see syncLogRowsFor).
  test('PP-08: paying a EUR supplier bill at a different settlement rate settles it and SUPPRESSES the REALISED_FX_JOURNAL for Xero (o3d-lgo.6.1)', async ({ page }) => {
    test.setTimeout(900_000)

    // The AP mirror of OC-10's FX boundary, but the point is the SETTLEMENT, not the import: a EUR bill
    // booked at one rate and PAID at another realises an FX gain/loss on the payable. markBillPaid computes
    // it (computeRealisedFx, side 'payable') and queues a REALISED_FX_JOURNAL — DR/CR between accounts
    // payable and the realised FX gain/loss account — alongside the BILL_PAYMENT that settles the bill
    // (app/actions/purchase-orders.ts). It only fires when the bill currency != base AND both FX accounts are
    // configured (getRealisedFxAccounts), so this is otherwise unproven on the base-currency GBP path.
    //
    // Same load-bearing precondition as OC-10: with fx_rates EMPTY, createPurchaseOrder THROWS
    // "Missing … FX rate" (purchase-order-fx.ts) — a foreign PO cannot even be raised — so the BOOKED rate
    // must be seeded BEFORE the PO. The realised gain then needs a DIFFERENT settlement rate on the payment
    // date, so a second rate is seeded AFTER the bill is booked (a later fetchedAt) and the payment is dated
    // TOMORROW so resolveSettlementFxRateToBase (fetchedAt <= asOf, latest wins) resolves the settlement
    // rate, never the booked one. Seeding order + a future payment date make this independent of wall-clock.
    const sku = taggedSku(runId, 'PP08')
    const reference = `${runTag(runId)}-PP08`
    const qty = 4
    const unitCostEur = '25.00'
    const goodsEur = Number(unitCostEur) * qty // 100.00 EUR net
    const bookedRate = 1.15   // 1 GBP = 1.15 EUR at booking
    const settlementRate = 1.35 // EUR weakened by payment day: fewer GBP settle the EUR payable -> a GAIN
    // Payment date TOMORROW: its asOf (midnight) is >= the booked rate's fetchedAt yet the settlement rate
    // (seeded later, after the bill) has the latest fetchedAt, so it is the one resolved. See helper notes.
    const paymentDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

    await setPostingMode({ sync: true, dailyBatch: false })

    // Seed the BOOKED rate first (fetchedAt in the past) so the PO can be raised and books at ~1.15.
    const bookedRateId = await seedFxRateAt('EUR', bookedRate, "now() - interval '2 hours'")
    let settlementRateId = ''
    try {
      await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP08`, price: '60.00' })

      const { poId } = await createAndSendPo(page, {
        sku, qty: String(qty), unitCost: unitCostEur, currency: 'EUR', fxRate: String(bookedRate),
      })
      await receiveGoods(page, { expectStatus: 'Received' })
      await createBill(page, { reference })

      // First drain: the ACCPAY bill posts (writing back its accountingInvoiceId, the precondition for a
      // BILL_PAYMENT) and the base-currency STOCK_RECEIPT journal posts. Register both failure-safe (PP-07).
      let receiptJournalId = ''
      let billId = ''
      try {
        await processPendingXeroSyncViaUi(page)
      } finally {
        receiptJournalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
        const billRecordId = (await billIdsForPo(poId).catch((): string[] => []))[0]
        billId = billRecordId ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: billRecordId }).catch(() => '') : ''
        if (receiptJournalId) trackDocument('ManualJournals', receiptJournalId, `PP-08 stock receipt ${runTag(runId)}`)
        if (billId) trackDocument('Invoices', billId, `PP-08 bill ${runTag(runId)}`)
      }
      expect(billId, 'the EUR ACCPAY bill posted to Xero').toBeTruthy()

      const [billRecordId] = await billIdsForPo(poId)
      const bill = await getInvoice(billId)
      expect(bill.Type).toBe('ACCPAY')
      expect(bill.Status).toBe('AUTHORISED')
      expect(bill.CurrencyCode, 'the bill is denominated in EUR, not the base currency').toBe('EUR')
      expect(Number(bill.SubTotal), 'EUR net ties out to the goods value').toBeCloseTo(goodsEur, 2)

      // The stored booked figures the realised-FX maths measures against — read them rather than assume the
      // penny, so the expected gain ties to the ACTUAL AP carrying value (bookedBase = stored totalBase for a
      // full settlement; amountForeign = stored totalForeign).
      const [{ totalForeign, totalBase }] = await queryRows<{ totalForeign: string; totalBase: string }>(
        `select "totalForeign", "totalBase" from purchase_invoices where id = $1`, [billRecordId],
      )
      const amountForeign = Number(totalForeign)
      const bookedBase = Number(totalBase)
      // computeRealisedFx: payable gain = round(bookedBase - amountForeign/settlementRate). Non-zero and
      // material by construction (1.15 -> 1.35).
      const expectedGain = Math.round((bookedBase - amountForeign / settlementRate) * 100) / 100
      expect(expectedGain, 'the rate move realises a material FX gain').toBeGreaterThan(1)

      // Now seed the SETTLEMENT rate (a LATER fetchedAt than the booked rate) and pay the bill from a EUR
      // bank account (a EUR payment from a EUR account — no cross-currency payment leg to complicate teardown).
      settlementRateId = await seedFxRateAt('EUR', settlementRate, 'now()')
      const eurBankId = await bankAccountIdForName('Revolut (EUR)')

      await openPurchaseOrder(page, poId)
      await markBillPaidViaUi(page, { bankAccountId: eurBankId, reference, paymentDate })

      // Second drain: the BILL_PAYMENT settles the bill. Register the payment failure-safe (teardown must
      // delete it before voiding the bill — Xero refuses to void a bill that has a payment).
      try {
        await processPendingXeroSyncViaUi(page)

        // ANCHOR — and the reason the suppression assertion below is not a race. markBillPaid queues the
        // BILL_PAYMENT and then, in the same invocation, makes the FX-journal enqueue decision
        // (app/actions/purchase-orders.ts). Waiting for the payment to be SYNCED means that decision has
        // already been taken, so an empty FX-journal row list is an answer, not a "not yet".
        const payExtId = await billPaymentExternalId(billRecordId)
        expect(payExtId, 'the BILL_PAYMENT posted a Xero payment').toBeTruthy()
        trackDocument('Payments', payExtId!, `PP-08 bill payment ${runTag(runId)}`)
        const payment = await getPayment(payExtId!)
        expect(Number(payment.Amount), 'the payment settled the full EUR bill').toBeCloseTo(amountForeign, 2)

        // The settlement is real: Xero holds the bill as PAID with nothing outstanding. This is what makes
        // Xero post its OWN realised currency gain — the movement the IMS must therefore not duplicate.
        const paidBill = await getInvoice(billId)
        expect(paidBill.Status, 'the EUR bill is settled in Xero').toBe('PAID')
        expect(Number(paidBill.AmountDue), 'nothing outstanding on the settled bill').toBeCloseTo(0, 2)

        // PRECONDITIONS — without these the "no FX journal" assertion below would be vacuous: it would pass
        // on a fixture where no FX gain arose at all. Each is a condition markBillPaid tests before queuing:
        //   1. both FX accounts configured (getRealisedFxAccounts returns null otherwise) — settingValue
        //      throws when a key is unset or empty, so reading them IS the assertion;
        const apAccount = await settingValue('xero_accounts_payable_account')
        const fxAccount = await settingValue('xero_realised_fx_gain_loss_account')
        expect(apAccount && fxAccount, 'realised-FX accounts are configured, so the journal would be built').toBeTruthy()
        //   2. bill currency != base (asserted above: CurrencyCode EUR on a GBP-base instance);
        //   3. a settlement rate DIFFERENT from the booked rate resolves as of the payment date —
        //      resolveSettlementFxRateToBase takes the latest fetchedAt <= asOf, so assert that is the 1.35
        //      seed and not the 1.15 booking. Without this the payment could have settled at the booked rate
        //      and realised nothing.
        // Mirrors resolveSettlementFxRateToBase exactly: latest fetchedAt <= asOf, where asOf is
        // `new Date(input.paymentDate)` — a bare YYYY-MM-DD, so UTC midnight. Spelling the instant out in
        // full avoids a ::date cast resolving against the session timezone and quietly shifting the boundary.
        const [resolvedRate] = await queryRows<{ rate: string }>(
          `select rate from fx_rates
            where "fromCurrency" = 'GBP' and "toCurrency" = 'EUR' and "fetchedAt" <= $1::timestamptz
            order by "fetchedAt" desc limit 1`,
          [`${paymentDate}T00:00:00Z`],
        )
        expect(Number(resolvedRate?.rate), 'the payment date resolves the SETTLEMENT rate, not the booked one')
          .toBeCloseTo(settlementRate, 4)
        //   4. and the resulting gain is material (asserted at expectedGain above, > 1 GBP).

        // THE POINT (o3d-lgo.6.1): every condition for a REALISED_FX_JOURNAL is met, and it is still never
        // QUEUED for Xero. Not "queued and rejected" — the defect state, a FAILED row carrying "Account code
        // '800' is not a valid code for this document" — and not "queued and posted", which would
        // double-count Xero's own realised-FX posting. No row at all.
        const fxRows = await syncLogRowsFor({ type: 'REALISED_FX_JOURNAL', referenceId: billRecordId })
        expect(
          fxRows,
          `REALISED_FX_JOURNAL must be suppressed for Xero, but ${fxRows.length} sync-log row(s) exist: ` +
            `${JSON.stringify(fxRows)}. A FAILED row means the o3d-lgo.6.1 defect is back (the control leg ` +
            `targets SYSTEM account ${apAccount}); a SYNCED row means IMS is double-counting Xero's native ` +
            `currency gain/loss posting.`,
        ).toEqual([])
      } finally {
        // Failure-safe: if an assertion threw after the payment posted, register it so teardown can delete it
        // before voiding the bill (Xero refuses to void a bill that has a payment).
        const payExtId = await billPaymentExternalId(billRecordId).catch(() => null)
        if (payExtId) trackDocument('Payments', payExtId, `PP-08 bill payment ${runTag(runId)}`)
        // And if suppression ever regressed into a POSTED journal, register that too — an untracked manual
        // journal would be stranded in the Demo ledger by a test whose whole point is that it must not exist.
        // Read the rows directly rather than externalIdFor: that helper WAITS for a SYNCED row, so asking it
        // for a document expected not to exist would stall the teardown for its whole timeout on every run.
        const strayRows = await syncLogRowsFor({ type: 'REALISED_FX_JOURNAL', referenceId: billRecordId })
          .catch((): Array<{ status: string; externalTransactionId: string | null }> => [])
        for (const row of strayRows) {
          if (row.externalTransactionId) {
            trackDocument('ManualJournals', row.externalTransactionId, `PP-08 UNEXPECTED realised FX ${runTag(runId)}`)
          }
        }
      }
    } finally {
      await deleteFxRate(bookedRateId)
      if (settlementRateId) await deleteFxRate(settlementRateId)
    }
  })

  test('PP-09: paying a supplier bill records a BILL_PAYMENT that settles it in Xero from the mapped bank account', async ({ page }) => {
    test.setTimeout(900_000)

    // The procure-to-pay MIRROR of OC-15 (INVOICE_PAYMENT -> BILL_PAYMENT; accounts payable, not receivable):
    // a supplier bill, once paid, should not merely sit AUTHORISED but be SETTLED in Xero — the payable
    // discharged, the bill PAID with a zero balance, drawn from the operator's chosen bank account.
    //
    // NOTE ON THE TRIGGER (differs from OC-15, deliberately). On the SALES side the payment auto-registers
    // from the Woo order via the payment-account map (enqueueSalesInvoiceFollowUps). The AP side has no such
    // map path — enqueuePurchaseInvoiceFollowUps never reads accounting_payment_account_map — so a bill
    // payment is an OPERATOR action: markBillPaid against an EXPLICIT bank account queues the BILL_PAYMENT
    // (app/actions/purchase-orders.ts). There is therefore no per-test map to configure or restore here; the
    // "mapped bank account" is the one selected in the Pay Bill dialog, asserted below by the drawn-from code.
    const sku = taggedSku(runId, 'PP09')
    const reference = `${runTag(runId)}-PP09`
    const qty = 2
    const unitCost = '40.00'
    const expectedNet = Number(unitCost) * qty // 80.00 GBP
    const bankCode = '090' // Demo "Business Bank Account" (GBP)

    await setPostingMode({ sync: true, dailyBatch: false })
    await createInventoryProduct(page, { sku, name: `${runTag(runId)} PP09`, price: '55.00' })

    const { poId } = await createAndSendPo(page, { sku, qty: String(qty), unitCost })
    await receiveGoods(page, { expectStatus: 'Received' })
    await createBill(page, { reference })

    // First drain: the ACCPAY bill posts and gets its accountingInvoiceId (the precondition for BILL_PAYMENT
    // — without it markBillPaid records only locally). Register the bill + receipt journal failure-safe.
    let receiptJournalId = ''
    let billId = ''
    try {
      await processPendingXeroSyncViaUi(page)
    } finally {
      receiptJournalId = await externalIdFor({ type: 'STOCK_RECEIPT', referenceId: poId }).catch(() => '')
      const rec = (await billIdsForPo(poId).catch((): string[] => []))[0]
      billId = rec ? await externalIdFor({ type: 'PURCHASE_INVOICE', referenceId: rec }).catch(() => '') : ''
      if (receiptJournalId) trackDocument('ManualJournals', receiptJournalId, `PP-09 stock receipt ${runTag(runId)}`)
      if (billId) trackDocument('Invoices', billId, `PP-09 bill ${runTag(runId)}`)
    }
    expect(billId, 'the ACCPAY bill posted to Xero').toBeTruthy()

    const [billRecordId] = await billIdsForPo(poId)
    const billBefore = await getInvoice(billId)
    expect(billBefore.Type).toBe('ACCPAY')
    expect(billBefore.Status, 'the bill is authorised (payable), not yet paid').toBe('AUTHORISED')
    expect(Number(billBefore.SubTotal)).toBeCloseTo(expectedNet, 2)
    const billTotal = Number(billBefore.Total)

    const bankAccountId = await bankAccountIdForCode(bankCode)

    await openPurchaseOrder(page, poId)
    await markBillPaidViaUi(page, { bankAccountId, reference })

    try {
      // The BILL_PAYMENT needs no CREATE-ordering deferral (the bill's CREATE is already live — its
      // accountingInvoiceId is set — see app/actions/purchase-orders.ts), so it posts on the next drain;
      // drainUntilBillPaid re-drains defensively and gates on the BILL_PAYMENT subledger truth.
      const bill = await drainUntilBillPaid(page, billId, billRecordId)

      expect(bill.Type).toBe('ACCPAY')
      // THE POINT: the bill is fully PAID in the ledger, not merely AUTHORISED. A dropped/skipped payment
      // would leave it AUTHORISED with the full AmountDue, and a structural check could not tell them apart.
      expect(bill.Status, 'the payable is settled, not just authorised').toBe('PAID')
      expect(Number(bill.AmountPaid), 'the whole bill is paid').toBeCloseTo(billTotal, 2)
      expect(Number(bill.AmountDue), 'nothing is left outstanding').toBeCloseTo(0, 2)

      // Exactly one payment, for the full amount, drawn from the CHOSEN bank account. The bill's Payments
      // sub-resource omits the account, so read the payment itself for the drawn-from code.
      expect(bill.Payments?.length, 'exactly one payment settles the bill').toBe(1)
      const payment = await getPayment(bill.Payments![0].PaymentID)
      expect(Number(payment.Amount), 'the payment is for the bill total').toBeCloseTo(billTotal, 2)
      expect(payment.Account?.Code, 'payment drawn from the chosen bank account (Business Bank Account 090)').toBe(bankCode)
    } finally {
      // Failure-safe: register the payment BEFORE the bill (VOID_ORDER deletes Payments first) so a post that
      // beat a later throw is reversed and the bill can then be voided. Use the BILL_PAYMENT sync log's own
      // externalTransactionId — the exact payment THIS bill recorded — never "every payment on the bill".
      const payExtId = await billPaymentExternalId(billRecordId).catch(() => null)
      if (payExtId) trackDocument('Payments', payExtId, `PP-09 bill payment ${runTag(runId)}`)
    }
  })
})

/** The PurchaseReturn row this PO produced. Its id — not the PO's — keys the return's journal. */
async function purchaseReturnIdFor(poId: string): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    `select id from purchase_returns where "poId" = $1 order by "createdAt" desc`,
    [poId],
  )
  if (!rows.length) throw new Error(`No purchase_returns row for PO ${poId} — the return never recorded.`)
  // One return, one credit: more than one means the dialog submitted twice and the amounts below
  // would be asserted against whichever happened to be newest.
  if (rows.length > 1) throw new Error(`Expected ONE return for PO ${poId}, found ${rows.length}.`)
  return rows[0].id
}

/** The return-generated SupplierCreditNote row. Keys both the credit note and its allocation. */
async function supplierCreditNoteIdFor(poId: string): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    `select id from supplier_credit_notes where "poId" = $1 and "isReturnGenerated" = true order by "createdAt" desc`,
    [poId],
  )
  if (!rows.length) {
    throw new Error(`No return-generated supplier_credit_notes row for PO ${poId}. A return only drafts a credit note when the PO is already billed.`)
  }
  if (rows.length > 1) throw new Error(`Expected ONE return credit note for PO ${poId}, found ${rows.length}.`)
  return rows[0].id
}

/** The MANUAL (freight/over-charge) SupplierCreditNote row — the counterpart that is NOT return-generated. */
async function freightCreditNoteIdFor(poId: string): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    `select id from supplier_credit_notes where "poId" = $1 and "isReturnGenerated" = false order by "createdAt" desc`,
    [poId],
  )
  if (!rows.length) {
    throw new Error(`No manually-recorded supplier_credit_notes row for PO ${poId} — recordSupplierFreightCreditNote never created it (needs a bill on the PO).`)
  }
  if (rows.length > 1) throw new Error(`Expected ONE freight credit note for PO ${poId}, found ${rows.length}.`)
  return rows[0].id
}

/** Read a setting from this instance (account codes are per-instance config). */
async function settingValue(key: string): Promise<string> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<{ value: string }>(`select value from settings where key = $1`, [key])
    if (!r.rows.length || !r.rows[0].value) throw new Error(`Setting ${key} is not configured on this instance.`)
    return r.rows[0].value
  } finally {
    await db.end()
  }
}

/** The connector-native id (Xero AccountID) of a synced bank account, resolved by its account CODE. */
async function bankAccountIdForCode(code: string): Promise<string> {
  const rows = await queryRows<{ externalAccountId: string }>(
    `select "externalAccountId" from accounting_accounts where connector = 'xero' and code = $1 and "externalAccountId" is not null limit 1`,
    [code],
  )
  if (!rows.length) throw new Error(`No synced Xero bank account with code ${code} — is the chart of accounts synced?`)
  return rows[0].externalAccountId
}

/** The connector-native id (Xero AccountID) of a synced bank account, resolved by its NAME (for code-less accounts). */
async function bankAccountIdForName(name: string): Promise<string> {
  const rows = await queryRows<{ externalAccountId: string }>(
    `select "externalAccountId" from accounting_accounts where connector = 'xero' and name = $1 and "externalAccountId" is not null limit 1`,
    [name],
  )
  if (!rows.length) throw new Error(`No synced Xero bank account named "${name}" — is the chart of accounts synced?`)
  return rows[0].externalAccountId
}

/** The Xero external id of the BILL_PAYMENT this bill recorded (once posted), or null. Keyed on the PurchaseInvoice id. */
async function billPaymentExternalId(invoiceRecordId: string): Promise<string | null> {
  const rows = await queryRows<{ externalTransactionId: string | null }>(
    `select "externalTransactionId" from accounting_sync_logs
      where connector = 'xero' and type = 'BILL_PAYMENT' and "referenceId" = $1 and "externalTransactionId" is not null
      order by "createdAt" desc limit 1`,
    [invoiceRecordId],
  )
  return rows.length ? rows[0].externalTransactionId : null
}

/** The latest BILL_PAYMENT sync-log status for a bill (its referenceId), or null. */
async function billPaymentLogStatus(invoiceRecordId: string): Promise<{ status: string; error: string | null } | null> {
  const rows = await queryRows<{ status: string; errorMessage: string | null }>(
    `select status, "errorMessage" from accounting_sync_logs
      where connector = 'xero' and type = 'BILL_PAYMENT' and "referenceId" = $1
      order by "createdAt" desc limit 1`,
    [invoiceRecordId],
  )
  return rows.length ? { status: rows[0].status, error: rows[0].errorMessage } : null
}

/**
 * Drain the Xero queue until the bill reads PAID — the AP mirror of order-to-cash's drainUntilInvoicePaid.
 * Gates on the BILL_PAYMENT subledger truth (FAILED -> fail loudly with the recorded error rather than spin
 * to a confusing timeout; SYNCED -> Xero accepted the POST) and, once SYNCED, polls getInvoice for PAID
 * because Xero can lag a beat reflecting the payment on the bill aggregate.
 */
async function drainUntilBillPaid(
  page: import('@playwright/test').Page,
  billXeroId: string,
  invoiceRecordId: string,
  maxDrains = 5,
): Promise<XeroInvoice> {
  let bill = await getInvoice(billXeroId)
  for (let i = 0; i < maxDrains && bill.Status !== 'PAID'; i++) {
    await processPendingXeroSyncViaUi(page)
    const pay = await billPaymentLogStatus(invoiceRecordId)
    if (pay?.status === 'FAILED') {
      throw new Error(`BILL_PAYMENT failed to post to Xero: ${pay.error ?? 'no error recorded'}`)
    }
    if (pay?.status === 'SYNCED') {
      for (let j = 0; j < 6 && bill.Status !== 'PAID'; j++) {
        bill = await getInvoice(billXeroId)
        if (bill.Status === 'PAID') break
        await new Promise((res) => setTimeout(res, 5_000))
      }
    } else {
      bill = await getInvoice(billXeroId)
    }
  }
  return bill
}