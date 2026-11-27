/** Per-event FX, before the flip: the non-IMS-bills command's argument rules, the read-only Xero bill read, the switch-on bill-writer refusal, the RC fold. */
import assert from 'node:assert/strict'
import test from 'node:test'

// [mutation: accept an unknown flag, a value starting with --, an empty --bill or a malformed --expect]
test('the command refuses unknown flags and bad values, and reads repeated --bill / --expect', async () => {
  const { parseArgs } = await import('../../../scripts/purchase-fx-non-ims-bills')
  assert.deepEqual(parseArgs(['--frobnicate']), { error: 'Unknown argument "--frobnicate".' })
  assert.match((parseArgs(['--by', '--yes']) as { error: string }).error, /--by needs a value/)
  assert.match((parseArgs(['--bill', '  ']) as { error: string }).error, /non-empty/)
  assert.match((parseArgs(['--bill']) as { error: string }).error, /--bill needs a value/)
  assert.match((parseArgs(['--expect', 'abc']) as { error: string }).error, /<bill id>=<amount>/)
  const ok = parseArgs(['--yes', '--confirm-admin', '--by', 'Jan', '--reason', 'r', '--bill', 'a', '--bill', 'b', '--expect', 'a=-26.04', '--expect', 'b=0'])
  assert.ok(!('error' in ok))
  assert.deepEqual(ok.bills, ['a', 'b'])
  assert.deepEqual([...ok.expect], [['a', '-26.04'], ['b', '0']])
  assert.equal(ok.all, false)
})

// [mutation: trust an incomplete Xero answer, or read something other than Invoices/<id>]
test('the Xero bill read is one GET of Invoices/<id>, fail-closed on an incomplete answer', async () => {
  const { readXeroBillById } = await import('@/lib/connectors/xero/bill-read')
  const paths: string[] = []
  const id = '00000000-0000-4000-8000-000000000001'
  const answer = (invoice: Record<string, unknown>) => ({ get: async <T,>(path: string) => { paths.push(path); return { ok: true, status: 200, tenantId: 't', data: { Invoices: [invoice] } as T } } })
  const good = await readXeroBillById(id, answer({ InvoiceID: id, Type: 'ACCPAY', Status: 'PAID', CurrencyCode: 'usd', CurrencyRate: 1.35265, LineItems: [{ AccountCode: '631', LineAmount: 100, TaxAmount: 0 }] }))
  assert.ok(good.ok)
  assert.equal(good.bill.currencyRate.toString(), '1.35265')
  assert.equal(good.bill.currencyCode, 'USD')
  assert.deepEqual(paths, [`Invoices/${id}`])
  const noRate = await readXeroBillById(id, answer({ InvoiceID: id, Type: 'ACCPAY', Status: 'PAID', CurrencyCode: 'USD', LineItems: [] }))
  assert.equal(noRate.ok, false)
  assert.equal((await readXeroBillById('not-a-guid', answer({}))).ok, false)
})

// [mutation: let the switch turn on while the producer-side hold shadows supplier bills]
test('turning the switch on is refused while PURCHASE_INVOICE is shadowed (Qoblex writes bills); without the hold there is no refusal', async () => {
  const { purchaseFxSwitchOnRefusal } = await import('@/lib/domain/purchasing/purchase-event-fx-switch-on')
  assert.equal(purchaseFxSwitchOnRefusal({ env: {} }), null, 'the hold not enforced')
  assert.match(purchaseFxSwitchOnRefusal({ env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' } }) ?? '', /shadows supplier bills/)
})

// [mutation: send a zero stock line, or drop its rounding penny of VAT]
test('a reverse-charge plan line that is all price variance sends no stock line, and its VAT penny goes on the PPV line', async () => {
  const { buildSupplierCreditNoteSyncPayload } = await import('@/lib/domain/purchasing/supplier-credit-note')
  const payload = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'cn3', creditNoteNumber: null, reference: 'PO-1', reason: 'Supplier return', supplierName: 'S', supplierId: 's', currency: 'EUR',
    fxRateToBase: 1.6, amountForeign: 0, transitAccount: '631', taxType: undefined, date: '2026-11-27',
    reverseChargePlan: { lines: [{ net: 10.03, vat: 2.01, taxType: 'INPUT2', reverseCharge: false, billLineIndex: 0 }], netTotal: 10.03, xeroTotal: 12.04 },
    ppvSplit: { account: '5050', plan: [{ ppvNet: 10.03, ppvVat: 2, stockVat: 0.01 }] },
  }) as { lines: Array<{ accountCode: string; unitAmount: number; taxAmount?: number }> }
  assert.deepEqual(payload.lines.map((l) => [l.accountCode, l.unitAmount, l.taxAmount]), [['5050', 10.03, 2.01]])
})
