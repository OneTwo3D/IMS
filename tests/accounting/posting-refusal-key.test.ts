import assert from 'node:assert/strict'
import test from 'node:test'

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
    accountingPostingKey({ type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'update:hash-a' }).scope,
    accountingPostingKey({ type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', idempotencyKey: 'update:hash-b' }).scope,
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
  return alternatives.every((alt) =>
    isWholeDerivation(alt)
    || /^[\w$]+(\??\.[\w$]+)*$/.test(alt)
    || /^[\w$]+(\??\.[\w$]+)*\(\)$/.test(alt))
}

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
  assert.ok(sites.length >= 6, `expected the refusal writers, found ${sites.length}`)

  const handBuilt = sites.filter((site) => !keyExpressionIsDerived(site.key))
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
