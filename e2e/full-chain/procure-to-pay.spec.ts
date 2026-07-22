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
  cancelPurchaseOrder, createAndSendPo, createBill, openPurchaseOrder, postSupplierCreditNote,
  processPendingXeroSyncViaUi, receiveGoods, recordFreightCreditNote, returnItems, setPostingMode,
} from './harness/ims.ts'
import { createInventoryProduct } from '../helpers.ts'
import {
  billIdsForPo, expectJournalLine, expectLine, externalIdFor, externalIdsFor, getCreditNote,
  getInvoice, getManualJournal, trackDocument,
} from './harness/xero.ts'

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

/** Read rows from this instance. */
async function queryRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const { Client } = await import('pg')
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<T>(sql, params)
    return r.rows
  } finally {
    await db.end()
  }
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