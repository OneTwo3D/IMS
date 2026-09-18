import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'

import { balancedFrom, blankNonCode, productionSources } from './paid-provenance-scan'

/**
 * o3d-j625 r5 (independent review HIGH 1, HIGH 2, HIGH 3) — THE ROW'S KEY IS THE POSTING'S KEY.
 *
 * r4 had each reporting site hand-write the key its inbox row was written under, while the CLEAR was fed
 * the enqueue's own params. Eleven of fourteen matched. The three that did not were not typos:
 *
 *   HIGH 1  the bill create recorded `PURCHASE_INVOICE/PurchaseOrder/<po id>` for a posting enqueued as
 *           `PURCHASE_INVOICE/PurchaseInvoice/<bill id>` — a row nothing could ever clear, under section
 *           copy promising that it clears.
 *   HIGH 2  the supplier return recorded the key the PO CANCELLATION's posting uses, so a successful
 *           cancellation stamped `resolvedAt` over a supplier-return reversal that was never written.
 *   HIGH 3  payments were keyed per DOCUMENT where the obligation is per RECEIPT, so a refused deposit's
 *           row was resolved by a later balance succeeding.
 *
 * The fix is structural — one function over the enqueue's own params — and this file is the part that
 * keeps it structural: the key function's rules, and a census that no site builds a key of its own.
 */

test('[o3d-j625 r5 HIGH 1] a posting is keyed on the reference its OWN enqueue uses', async () => {
  const { accountingPostingKey } = await import('@/lib/accounting')
  // The bill create enqueues `PURCHASE_INVOICE` against the BILL. r4's row named the purchase ORDER.
  assert.deepEqual(
    accountingPostingKey({ type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', idempotencyKey: 'purchase-invoice:bill-1:hash' }),
    { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', scope: '' },
  )
  // Document-scoped: the idempotency key is a CONTENT HASH, so keying on it would strand the previous
  // attempt's row for ever — which is HIGH 1 again in a new form.
  assert.equal(
    accountingPostingKey({ type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'update:hash-a', payload: { accountingInvoiceId: 'xero-bill-A' } }).scope,
    accountingPostingKey({ type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'update:hash-b', payload: { accountingInvoiceId: 'xero-bill-A' } }).scope,
    'two edits of one bill are one obligation, so the second clears the first',
  )
})

test('[o3d-j625 r5 HIGH 2] two DIFFERENT postings cannot share a key', async () => {
  const { accountingPostingKey } = await import('@/lib/accounting')
  // The two postings r4 collided: a supplier RETURN reversal and a PO CANCELLATION reversal.
  const supplierReturn = accountingPostingKey({
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'PurchaseReturn', referenceId: 'return-1',
    idempotencyKey: 'purchase-return:return-1',
  })
  const poCancellation = accountingPostingKey({
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'PurchaseOrder', referenceId: 'po-1',
    idempotencyKey: 'purchase-order-cancel:po-1:cost-layer-reversal',
  })
  assert.notDeepEqual(supplierReturn, poCancellation)
  assert.notEqual(
    `${supplierReturn.referenceType}/${supplierReturn.referenceId}`,
    `${poCancellation.referenceType}/${poCancellation.referenceId}`,
    'r4 recorded the return under the cancellation’s key, so a successful cancellation resolved it',
  )
  // And two runs of the SAME cancellation are one obligation.
  assert.deepEqual(poCancellation, accountingPostingKey({
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'PurchaseOrder', referenceId: 'po-1',
    idempotencyKey: 'purchase-order-cancel:po-1:cost-layer-reversal',
  }))
})

test('[o3d-j625 r5 HIGH 3] a posting finer than its document gets its own key', async () => {
  const { accountingPostingKey } = await import('@/lib/accounting')
  const deposit = accountingPostingKey({ type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { paymentId: 'pay-A' } })
  const balance = accountingPostingKey({ type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { paymentId: 'pay-B' } })
  assert.notEqual(deposit.scope, balance.scope, 'one receipt is one obligation (invoice-payment-capacity.ts)')
  assert.equal(deposit.scope, 'payment:pay-A')

  // Receipts of two DIFFERENT stock receipts against one PO, likewise.
  const first = accountingPostingKey({ type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'purchase-receipt:po-1:GRN-1' })
  const second = accountingPostingKey({ type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'purchase-receipt:po-1:GRN-2' })
  assert.notEqual(first.scope, second.scope)

  // A payload that names no receipt shares ONE row rather than a wrong one.
  assert.equal(accountingPostingKey({ type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', payload: {} }).scope, '')
})

// ---------------------------------------------------------------------------------------------------
// o3d-j625 r6 (review H2) — PER TYPE: TWO DIFFERENT POSTINGS NEVER COLLIDE, AND A RETRY NEVER DIVERGES.
//
// One case per AccountingSyncType, modelled on that type's real producers (named in each case). `a` and
// `b` are two DIFFERENT postings a producer can raise; `retryOfA` is the same posting raised again the way
// its retry path would raise it (for a DOCUMENT-scoped type, with a different content-hash key, because
// that is what a re-save produces). `retryDiverges` marks the types whose retry is NOT the same key, with
// the reason — those are the review-H4 cases, asserted as divergent so a change to them is seen.
// ---------------------------------------------------------------------------------------------------
type Params = { type: string; referenceType: string; referenceId: string; idempotencyKey?: string; payload?: Record<string, unknown> }
type Case = { a: Params; b: Params; retryOfA: Params; retryDiverges?: string }
const doc = (type: string, referenceType: string): Case => ({
  a: { type, referenceType, referenceId: 'doc-1', idempotencyKey: `${type}:doc-1:hash-1` },
  b: { type, referenceType, referenceId: 'doc-2', idempotencyKey: `${type}:doc-2:hash-1` },
  retryOfA: { type, referenceType, referenceId: 'doc-1', idempotencyKey: `${type}:doc-1:hash-2` },
})
const keyed = (type: string, referenceType: string, a: string, b: string): Case => ({
  a: { type, referenceType, referenceId: 'ref-1', idempotencyKey: a },
  b: { type, referenceType, referenceId: 'ref-1', idempotencyKey: b },
  retryOfA: { type, referenceType, referenceId: 'ref-1', idempotencyKey: a },
})
const CASES: Record<string, Case> = {
  SALES_INVOICE: doc('SALES_INVOICE', 'SalesOrder'),
  SALES_INVOICE_UPDATE: doc('SALES_INVOICE_UPDATE', 'SalesOrder'),
  PURCHASE_INVOICE: doc('PURCHASE_INVOICE', 'PurchaseInvoice'),
  // purchase-invoice-update-sync.ts: two bills on ONE purchase order — the review's counter-example.
  PURCHASE_INVOICE_UPDATE: {
    a: { type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'upd:A:h1', payload: { accountingInvoiceId: 'xero-bill-A' } },
    b: { type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'upd:B:h1', payload: { accountingInvoiceId: 'xero-bill-B' } },
    retryOfA: { type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'upd:A:h2', payload: { accountingInvoiceId: 'xero-bill-A' } },
  },
  CREDIT_NOTE: doc('CREDIT_NOTE', 'SalesOrderRefund'),
  PURCHASE_CREDIT_NOTE: doc('PURCHASE_CREDIT_NOTE', 'SupplierCreditNote'),
  PURCHASE_CREDIT_NOTE_ALLOCATION: doc('PURCHASE_CREDIT_NOTE_ALLOCATION', 'SupplierCreditNote'),
  BILL_PAYMENT: doc('BILL_PAYMENT', 'PurchaseInvoice'),
  INVOICE_PAYMENT: {
    a: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { paymentId: 'pay-A' } },
    b: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { paymentId: 'pay-B' } },
    retryOfA: { type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', idempotencyKey: 'redrive', payload: { paymentId: 'pay-A', amount: 1 } },
  },
  BILL_ATTACHMENT: doc('BILL_ATTACHMENT', 'PurchaseInvoice'),
  INVOICE_PDF: doc('INVOICE_PDF', 'SalesOrder'),
  INVOICE_EMAIL: doc('INVOICE_EMAIL', 'SalesOrder'),
  WC_INVOICE_NOTE: doc('WC_INVOICE_NOTE', 'SalesOrder'),
  TAX_RATE_SYNC: doc('TAX_RATE_SYNC', 'TaxRate'),
  // StockMovement, PurchaseReturn and the PO cancellation — each reference is one posting.
  INVENTORY_ADJUSTMENT: doc('INVENTORY_ADJUSTMENT', 'StockMovement'),
  // allocation-service.ts: two trims of ONE order — the review's second counter-example.
  ALLOCATION_REVERSAL: {
    a: { type: 'ALLOCATION_REVERSAL', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { _reversalToken: 'tok-1' } },
    b: { type: 'ALLOCATION_REVERSAL', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { _reversalToken: 'tok-2' } },
    retryOfA: { type: 'ALLOCATION_REVERSAL', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { _reversalToken: 'tok-1' } },
  },
  STOCK_RECEIPT: keyed('STOCK_RECEIPT', 'PurchaseOrder', 'purchase-receipt:po-1:GRN-1:h', 'purchase-receipt:po-1:GRN-2:h'),
  COGS_JOURNAL: keyed('COGS_JOURNAL', 'PurchaseOrder', 'landed-cost:cogs:po-1:h1', 'landed-cost:cogs:po-1:h2'),
  STOCK_IN_TRANSIT: keyed('STOCK_IN_TRANSIT', 'PurchaseOrder', 'landed-cost:inventory:po-1:h1', 'landed-cost:inventory:po-1:h2'),
  COGS_REVERSAL: keyed('COGS_REVERSAL', 'Shipment', 'shipment-cogs-revalue:s1:l1:1:2', 'shipment-cogs-revalue:s1:l2:1:2'),
  UNEARNED_REV_REVERSAL: {
    a: { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'r-1', idempotencyKey: 'sales-order-refund:r-1:unearned-reversal' },
    b: { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'r-2', idempotencyKey: 'sales-order-refund:r-2:unearned-reversal' },
    retryOfA: { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'r-1', idempotencyKey: 'sales-order-refund:r-1:unearned-reversal' },
  },
  UNREALISED_FX_JOURNAL: keyed('UNREALISED_FX_JOURNAL', 'FxRevaluation', 'unrealised-fx:revaluation:2026-09-01:receivable', 'unrealised-fx:revaluation:2026-09-01:payable'),
  REALISED_FX_JOURNAL: doc('REALISED_FX_JOURNAL', 'Payment'),
  MANUFACTURING_JOURNAL: doc('MANUFACTURING_JOURNAL', 'ProductionOrder'),
  MANUFACTURING_RECLASS: {
    ...keyed('MANUFACTURING_RECLASS', 'ProductionOrder', 'MFG_RECLASS:po-1:edit-1', 'MFG_RECLASS:po-1:edit-2'),
    // A re-save of the SAME edit hashes the same; the case where the retry is a DIFFERENT later edit is the
    // review-H4 case (a reclass the earlier refusal does not describe), held for the owner's decision.
  },
  DAILY_BATCH_REVENUE_DEFERRAL: doc('DAILY_BATCH_REVENUE_DEFERRAL', 'DailyBatch'),
  DAILY_BATCH_INVENTORY_ALLOC: doc('DAILY_BATCH_INVENTORY_ALLOC', 'DailyBatch'),
  DAILY_BATCH_GROUP_B: doc('DAILY_BATCH_GROUP_B', 'DailyBatch'),
  DAILY_BATCH_INVENTORY_RECONCILIATION: doc('DAILY_BATCH_INVENTORY_RECONCILIATION', 'DailyBatch'),
  DAILY_BATCH_COGS_RECONCILIATION: doc('DAILY_BATCH_COGS_RECONCILIATION', 'DailyBatch'),
  DAILY_BATCH_TRANSIT_RECONCILIATION: doc('DAILY_BATCH_TRANSIT_RECONCILIATION', 'DailyBatch'),
  STOCK_ALLOCATION: doc('STOCK_ALLOCATION', 'SalesOrder'),
}

function enumMembers(): string[] {
  const schema = readFileSync(`${process.cwd()}/prisma/schema.prisma`, 'utf8')
  const body = schema.match(/enum AccountingSyncType \{([\s\S]*?)\}/)?.[1] ?? ''
  return body.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter((line) => /^[A-Z_]+$/.test(line))
}

test('[o3d-j625 r6 H2] every AccountingSyncType has a case — a new type cannot join without one', () => {
  const members = enumMembers()
  assert.ok(members.length >= 30, `PRECONDITION: the enum was read (found ${members.length})`)
  assert.deepEqual(members.filter((member) => !(member in CASES)), [], 'types with no collision/retry case')
  assert.deepEqual(Object.keys(CASES).filter((key) => !members.includes(key)), [], 'cases for types that no longer exist')
})

for (const [type, c] of Object.entries(CASES)) {
  test(`[o3d-j625 r6 H2] ${type}: two different postings get different keys, and a retry of one gets the same key`, async () => {
    const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
    assert.notDeepEqual(accountingPostingKey(c.a), accountingPostingKey(c.b), `${type}: two distinct postings collided`)
    if (c.retryDiverges) {
      assert.notDeepEqual(accountingPostingKey(c.a), accountingPostingKey(c.retryOfA), c.retryDiverges)
    } else {
      assert.deepEqual(accountingPostingKey(c.retryOfA), accountingPostingKey(c.a), `${type}: a retry of one posting diverged`)
    }
  })
}

test('[o3d-j625 r6 H3] a STORED ROW yields the key its enqueue params do — for every case', async () => {
  const { accountingPostingKey, accountingPostingKeyForRow } = await import('@/lib/accounting/posting-key')
  for (const [type, c] of Object.entries(CASES)) {
    for (const params of [c.a, c.b]) {
      // What both connector queues and the in-transaction enqueue store: the payload, stamped verbatim
      // with `_idempotencyKey` when one was given.
      const payload = { ...(params.payload ?? {}), ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}) }
      assert.deepEqual(
        accountingPostingKeyForRow({ type: params.type, referenceType: params.referenceType, referenceId: params.referenceId, payload }),
        accountingPostingKey(params),
        `${type}: the row-creating primitive would clear a different key than the refusal was recorded under`,
      )
    }
  }
})

// ---------------------------------------------------------------------------------------------------
// NO SITE BUILDS A KEY OF ITS OWN
// ---------------------------------------------------------------------------------------------------

/**
 * A key expression is DERIVED when every alternative in it is: `accountingPostingKey(…)` over the enqueue's
 * params, a forwarded reference (`params.posting`, `outcome?.posting`), or a local deriver call
 * (`receiptPostingKey()`). Alternatives are split on a top-level `??` only — so "the enqueue's own reported
 * key, else the same derivation" passes, and "…, else a literal" does not.
 */
function keyExpressionIsDerived(key: string): boolean {
  const alternatives: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]!
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (depth === 0 && ch === '?' && key[i + 1] === '?') { alternatives.push(current.trim()); current = ''; i++; continue }
    current += ch
  }
  alternatives.push(current.trim())
  // The derivation must be the WHOLE alternative: `accountingPostingKey(…) && { … }` starts the same way.
  const isWholeDerivation = (alt: string): boolean => {
    if (!alt.startsWith('accountingPostingKey(')) return false
    let d = 0
    for (let i = 'accountingPostingKey'.length; i < alt.length; i++) {
      if ('([{'.includes(alt[i]!)) d++
      else if (')]}'.includes(alt[i]!)) d--
      if (d === 0) return i === alt.length - 1
    }
    return false
  }
  // r6: a named key function exported beside an enqueue (`purchaseInvoiceUpdatePostingKey(…)`), which derives
  // from the same identity that enqueue is called with — its equality is pinned behaviourally.
  const isNamedKeyFunction = (alt: string): boolean => {
    const m = alt.match(/^([\w$]+PostingKey)\(/)
    if (!m || m[1] === 'accountingPostingKey') return false
    let d = 0
    for (let i = m[1]!.length; i < alt.length; i++) {
      if ('([{'.includes(alt[i]!)) d++
      else if (')]}'.includes(alt[i]!)) d--
      if (d === 0) return i === alt.length - 1
    }
    return false
  }
  return alternatives.every((alt) =>
    isWholeDerivation(alt)
    || isNamedKeyFunction(alt)
    || /^[\w$]+(\??\.[\w$]+)*$/.test(alt)
    || /^[\w$]+(\??\.[\w$]+)*\(\)$/.test(alt))
}

/** The refusal writers in app/ and lib/ — the count, not a margin below it (review L2). */
const REFUSAL_WRITE_SITES = 9

/**
 * o3d-j625 r6 (review M1) — THE FORM CHECK WAS NOT A MATCH CHECK. Two shapes passed it:
 *
 *   M1a  `accountingPostingKey({ type: 'PURCHASE_INVOICE', … })` — a derivation, over a RE-TYPED literal that
 *        can name a different posting than the enqueue beside it.
 *   M1b  `const handKey = { type: …, scope: '' }` passed as a bare identifier, read as "forwarded".
 *
 * So a key may be derived only from an IDENTITY the enqueue also reads: `accountingPostingKey(<identifier>)`
 * where that identifier is spread into, or has its fields passed to, a call elsewhere in the file; and a
 * bare identifier is rejected when the file binds it to an object literal. Whether an identity names the
 * RIGHT posting is behaviour, and each refusal site has a test that drives it and compares keys (listed in
 * the report; the bill update, allocation and held release are in this round).
 */
function keyIsHandBuiltInFile(key: string, code: string): boolean {
  const alternatives = key.split('??').map((alt) => alt.trim())
  return alternatives.some((alt) => {
    const derived = alt.match(/^accountingPostingKey\(([\s\S]*)\)$/)
    if (derived) {
      const argument = derived[1]!.trim()
      if (!/^[\w$]+$/.test(argument)) return true // M1a: an inline literal (or anything but an identity)
      const escaped = argument.replace(/\$/g, '\\$')
      const usedByAnEnqueue = new RegExp(`\\.\\.\\.${escaped}\\b|\\b${escaped}\\.(?:type|referenceId)\\b`).test(code)
      return !usedByAnEnqueue
    }
    const bare = alt.match(/^([\w$]+)$/)
    if (bare) {
      const escaped = bare[1]!.replace(/\$/g, '\\$')
      return new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*\\{`).test(code) // M1b
    }
    return false
  })
}

test('[o3d-j625 r6 M1] the census FIRES on both surviving shapes and accepts a shared identity', () => {
  const file = `
    const handKey = { type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: poId, scope: '' }
    const identity = { type: 'X', referenceType: 'Y', referenceId: z }
    await queueAccountingSync({ ...identity, payload, chartConnector })
    const lonely = { type: 'X', referenceType: 'Y', referenceId: z }
  `
  const code = blankNonCode(file)
  assert.equal(keyIsHandBuiltInFile(`accountingPostingKey({ type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: poId })`, code), true, 'M1a')
  assert.equal(keyIsHandBuiltInFile('handKey', code), true, 'M1b')
  assert.equal(keyIsHandBuiltInFile('accountingPostingKey(lonely)', code), true, 'an identity no enqueue reads')
  assert.equal(keyIsHandBuiltInFile('accountingPostingKey(identity)', code), false, 'the identity the enqueue spreads')
  assert.equal(keyIsHandBuiltInFile('outcome?.posting ?? accountingPostingKey(identity)', code), false)
  assert.equal(keyIsHandBuiltInFile('params.posting', code), false, 'a forwarded key')
})

test('[o3d-j625 r5] every refusal write takes its key from accountingPostingKey or forwards one', () => {
  const NEEDLE = 'recordAccountingPostingRefusal('
  const sites: Array<{ file: string; line: number; key: string }> = []
  for (const [file, source] of productionSources()) {
    if (file === 'lib/domain/accounting/posting-refusal-inbox.ts') continue // the declaration itself
    const code = blankNonCode(source)
    let from = 0
    for (;;) {
      const at = code.indexOf(NEEDLE, from)
      if (at === -1) break
      from = at + NEEDLE.length
      const argument = balancedFrom(code, at + NEEDLE.length - 1)
      // The SECOND argument is the key: `(client, key, record, options?)`.
      const inner = argument.slice(1, -1)
      let depth = 0
      const args: string[] = []
      let current = ''
      for (const ch of inner) {
        if ('([{'.includes(ch)) depth++
        else if (')]}'.includes(ch)) depth--
        if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue }
        current += ch
      }
      args.push(current.trim())
      sites.push({ file, line: source.slice(0, at).split('\n').length, key: args[1] ?? '' })
    }
  }
  console.log(`[o3d-j625 r5] refusal-write sites examined: ${sites.length}`)
  // review L2: the floor IS the count, so a writer that stops being found is a failure, not a margin.
  assert.ok(sites.length >= REFUSAL_WRITE_SITES, `expected ${REFUSAL_WRITE_SITES} refusal writers, found ${sites.length}`)

  const sourceOf = new Map(productionSources())
  const handBuilt = sites.filter((site) => !keyExpressionIsDerived(site.key) || keyIsHandBuiltInFile(site.key, blankNonCode(sourceOf.get(site.file) ?? '')))
  assert.deepEqual(
    handBuilt.map((site) => `${site.file}:${site.line} ${site.key.slice(0, 60)}`),
    [],
    'these refusal writes build their own key. It must come from `accountingPostingKey` over the ENQUEUE’s '
    + 'params (or be forwarded from something that did), or the row and the clear can disagree — which is '
    + 'exactly HIGH 1/2/3 of the r4 review.',
  )
})

test('[o3d-j625 r5] the detector FIRES on a hand-built key and ACCEPTS the derived and forwarded forms', () => {
  // The fixture proves the census above can fail: r4's own shape is the first case.
  const fixture = `
    await recordAccountingPostingRefusal(db, { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseOrder', referenceId: poId, scope: '' }, record)
    await recordAccountingPostingRefusal(db, accountingPostingKey({ type: 'X', referenceType: 'Y', referenceId: z }), record)
    await recordAccountingPostingRefusal(db, params.posting, record)
    await recordAccountingPostingRefusal(db, receiptPostingKey(), record)
    await recordAccountingPostingRefusal(db, outcome?.posting ?? accountingPostingKey({ type: 'X', referenceType: 'Y', referenceId: z }), record)
    await recordAccountingPostingRefusal(db, outcome?.posting ?? { type: 'X', referenceType: 'Y', referenceId: z, scope: '' }, record)
    await recordAccountingPostingRefusal(db, accountingPostingKey({ type: 'X', referenceType: 'Y', referenceId: z }) && { type: 'X', scope: 'y' }, record)
  `
  const code = blankNonCode(fixture)
  const keys: string[] = []
  let from = 0
  for (;;) {
    const at = code.indexOf('recordAccountingPostingRefusal(', from)
    if (at === -1) break
    from = at + 1
    const argument = balancedFrom(code, at + 'recordAccountingPostingRefusal('.length - 1)
    const inner = argument.slice(1, -1)
    let depth = 0
    const args: string[] = []
    let current = ''
    for (const ch of inner) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
      if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue }
      current += ch
    }
    args.push(current.trim())
    keys.push(args[1] ?? '')
  }
  assert.equal(keys.length, 7)
  const handBuilt = keys.filter((key) => !keyExpressionIsDerived(key))
  assert.equal(handBuilt.length, 3, `the literal object is caught, bare and as a ?? fallback. Caught: ${JSON.stringify(handBuilt)}`)
  assert.match(handBuilt[1]!, /^outcome\?\.posting \?\? \{/, 'the fallback literal is caught even behind a forwarded key')
  assert.match(handBuilt[2]!, /^accountingPostingKey\([\s\S]*\) && \{/, 'and a derivation that is only the PREFIX of the expression is not one')
  // `blankNonCode` empties string BODIES, so the shape is what identifies it — an object literal.
  assert.match(handBuilt[0]!, /^\{ type: '\s*', referenceType: '\s*', referenceId: poId, scope: '' \}$/)
})
