import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

import type { BillData, CreditNoteData, InvoiceData } from '@/lib/connectors/types'
import { buildPurchaseBillPayload } from '@/lib/connectors/xero/bills'
import { buildXeroPurchaseCreditNote } from '@/lib/connectors/xero/credit-notes'
import { imsRateToXeroCurrencyRate, xeroCurrencyRateOrRefuse, xeroDocumentAmountToBase } from '@/lib/connectors/xero/fx'
import { buildSalesInvoicePayload } from '@/lib/connectors/xero/invoices'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * THE DIRECTION OF XERO'S `CurrencyRate`, PINNED TO WHAT XERO ITSELF HOLDS.
 *
 * Xero's CurrencyRate is units of the FOREIGN (document) currency per ONE unit of the organisation's base currency: the same convention as IMS's
 * fxRateToBase ("1 base = rate foreign"). IMS once sent the reciprocal; nothing foreign had been sent when that was found. This file makes an
 * inversion, anywhere it could re-enter, go red:
 *
 *  1. RECORDED: three foreign bills read (read-only, 2026-11-22) from the live organisation, base GBP, reduced to the fields this test needs. Each
 *     rate is the market quote of foreign per GBP; its reciprocal is not. IMS's own fx_rates USD rate of that day (1.3125) is sent as is and sits
 *     next to Xero's recorded USD rate, never next to its reciprocal.
 *  2. ARITHMETIC: a USD 1,000 bill at fxRateToBase 1.3125 carries CurrencyRate 1.3125 and is GBP 761.90 in Xero's arithmetic (amount / rate), the
 *     figure IMS books (amount / fxRateToBase). The reconciliation pack's read helper (R12) divides the same way.
 *  3. EVERY SENDER: the invoice, bill and supplier credit note builders and the payment/refund rate function (sales credit notes and payments
 *     are driven end to end in xero-foreign-document-rate.test.ts and xero-payment-currency-rate.test.ts) carry the rate as is.
 *  4. CENSUS: every place in lib/ that writes a Xero `CurrencyRate` field is listed, each takes its value from the one helper in fx.ts, and no
 *     reciprocal of a rate (`1 / rate` or `Decimal(1).div(rate)`) appears anywhere in lib/, app/ or scripts/.
 *
 * Named mutations (each shown red, restored from a copy):
 *  a  helper-inverts        imsRateToXeroCurrencyRate returns 1 / rate again: arms 1, 2 and 3 go red
 *  b  r12-multiplies        xeroDocumentAmountToBase multiplies by the rate again: arm 2 goes red
 *  c  sender-bypasses       a builder computes its own CurrencyRate (e.g. `1 / data.currencyRateToBase`): the census arm goes red
 */

// ---- 1. recorded Xero payloads -------------------------------------------------------------------------------------------------------

/** Xero-shaped (GET /Invoices) rows of the live organisation (base GBP), recorded 2026-11-22, only the fields the test uses. */
const RECORDED_XERO_BILLS = [
  { Type: 'ACCPAY', InvoiceNumber: 'PI260907OTD', DateString: '2026-09-07T00:00:00', CurrencyCode: 'USD', CurrencyRate: 1.352650993 },
  { Type: 'ACCPAY', InvoiceNumber: 'POQ468', CurrencyCode: 'EUR', CurrencyRate: 1.1835295458 },
  { Type: 'ACCPAY', InvoiceNumber: 'INV20261102001', CurrencyCode: 'CNY', CurrencyRate: 8.937375334 },
] as const

/** Broad bands for foreign units per ONE GBP in 2026 (and, by construction, far from the reciprocal of each). */
const FOREIGN_PER_GBP_BAND: Record<string, [number, number]> = { USD: [1.1, 1.6], EUR: [1.0, 1.35], CNY: [7.5, 11] }

/** IMS fx_rates, GBP to USD, 2026-11-22. */
const IMS_USD_RATE_TO_BASE = 1.3125

test('RECORDED: Xero holds foreign per GBP (the market quote), never its reciprocal', () => {
  for (const bill of RECORDED_XERO_BILLS) {
    const [low, high] = FOREIGN_PER_GBP_BAND[bill.CurrencyCode]!
    assert.ok(bill.CurrencyRate >= low && bill.CurrencyRate <= high, `${bill.InvoiceNumber}: ${bill.CurrencyRate} ${bill.CurrencyCode} per GBP`)
    const reciprocal = 1 / bill.CurrencyRate
    assert.ok(reciprocal < low || reciprocal > high, `${bill.InvoiceNumber}: the reciprocal ${reciprocal} is not a ${bill.CurrencyCode}-per-GBP rate`)
  }
})

test('RECORDED: the rate IMS sends for its own USD rate sits next to Xero\'s recorded USD rate, and the old inverted one does not', () => {
  const xeroUsd = RECORDED_XERO_BILLS.find((b) => b.CurrencyCode === 'USD')!.CurrencyRate
  const sent = imsRateToXeroCurrencyRate(IMS_USD_RATE_TO_BASE)!
  assert.equal(sent, 1.3125)
  assert.ok(Math.abs(sent / xeroUsd - 1) < 0.1, `IMS sends ${sent}, Xero holds ${xeroUsd} for USD: the same direction`)
  const inverted = 1 / IMS_USD_RATE_TO_BASE
  assert.ok(Math.abs(inverted / xeroUsd - 1) > 0.3, 'the reciprocal (the old, wrong direction) is nowhere near what Xero holds')
  // Every recorded rate goes round the helper unchanged (to Xero's six places): it is the convention Xero reads back.
  for (const bill of RECORDED_XERO_BILLS) assert.equal(imsRateToXeroCurrencyRate(bill.CurrencyRate), Math.round(bill.CurrencyRate * 1e6) / 1e6, bill.InvoiceNumber)
})

// ---- 2. Xero's arithmetic --------------------------------------------------------------------------------------------------------------

const bill = (extra: Partial<BillData> = {}): BillData => ({
  invoiceNumber: 'B-USD-1', contactName: 'Supplier', date: '2026-11-22', currency: 'USD',
  lines: [{ description: 'Goods', quantity: 1, unitAmount: 1000, accountCode: '630', taxType: 'INPUT2' }], ...extra,
}) as BillData

test('ARITHMETIC: a USD 1,000 bill at fxRateToBase 1.3125 carries CurrencyRate 1.3125 and books GBP 761.90 in Xero (amount / rate), as IMS does', () => {
  const payload = buildPurchaseBillPayload(bill({ currencyRateToBase: IMS_USD_RATE_TO_BASE }), 'AUTHORISED', 'c1', 'GBP')
  assert.equal(payload.CurrencyRate, 1.3125)
  const rate = String(payload.CurrencyRate)
  // Xero's base figure, by the pack's read helper, and IMS's own (foreign / fxRateToBase): the same GBP 761.90.
  const xeroGbp = xeroDocumentAmountToBase(toDecimal(1000), rate).toDecimalPlaces(2)
  const imsGbp = toDecimal(1000).div(IMS_USD_RATE_TO_BASE).toDecimalPlaces(2)
  assert.equal(xeroGbp.toFixed(2), '761.90')
  assert.equal(imsGbp.toFixed(2), '761.90')
  // The inverted rate (0.761905) would have booked GBP 1,312.50, and the multiplying read would have reported GBP 1,312.50 too.
  assert.notEqual(xeroDocumentAmountToBase(toDecimal(1000), String(Math.round((1 / IMS_USD_RATE_TO_BASE) * 1e6) / 1e6)).toDecimalPlaces(2).toFixed(2), '761.90')
  assert.equal(xeroDocumentAmountToBase(toDecimal(50), '1.25').toFixed(2), '40.00', 'EUR 50 at 1.25 is GBP 40')
})

// ---- 3. every sender ---------------------------------------------------------------------------------------------------------------------

test('EVERY SENDER carries the rate as is: invoice, bill, supplier credit note, and the payment / refund rate', () => {
  const invoice = { invoiceNumber: 'INV-1', contactName: 'Customer', date: '2026-11-22', currency: 'USD', currencyRateToBase: IMS_USD_RATE_TO_BASE, lines: [{ itemCode: 'SKU-1', description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }] } as unknown as InvoiceData
  const credit = { creditNoteNumber: 'SCN-1', contactName: 'Supplier', date: '2026-11-22', currency: 'USD', currencyRateToBase: IMS_USD_RATE_TO_BASE, lines: [{ description: 'Credit', quantity: 1, unitAmount: 10, accountCode: '630', taxType: 'INPUT2' }] } as unknown as CreditNoteData
  assert.equal(buildSalesInvoicePayload(invoice, 'AUTHORISED', 'c1', new Set(), 'GBP').CurrencyRate, 1.3125)
  assert.equal(buildPurchaseBillPayload(bill({ currencyRateToBase: IMS_USD_RATE_TO_BASE }), 'AUTHORISED', 'c1', 'GBP').CurrencyRate, 1.3125)
  assert.equal(buildXeroPurchaseCreditNote(credit, 'AUTHORISED', 'c1', 'GBP').CurrencyRate, 1.3125)
  // The function every payment, bill payment and credit-note refund payment takes its CurrencyRate from (sync-processor xeroPaymentCurrencyRate).
  for (const what of ['INVOICE_PAYMENT payment', 'BILL_PAYMENT payment', 'CREDIT_NOTE_ALLOCATION payment']) {
    assert.equal(xeroCurrencyRateOrRefuse({ currency: 'USD', baseCurrency: 'GBP', rateToBase: IMS_USD_RATE_TO_BASE, what }), 1.3125, what)
  }
})

// ---- 4. census ---------------------------------------------------------------------------------------------------------------------------

const ROOT = process.cwd()

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat) return []
    if (stat.isDirectory()) return entry === 'generated' || entry === 'node_modules' ? [] : tsFiles(full)
    return entry.endsWith('.ts') || entry.endsWith('.tsx') ? [full] : []
  })
}

/** The code of a file with block and line comments blanked (string contents kept: none of the patterns below occur in strings). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Every write of a Xero `CurrencyRate` field in lib/ (an object key or a property assignment), by file, and the exact count. */
const EXPECTED_CURRENCY_RATE_WRITES: Record<string, number> = {
  'lib/connectors/xero/bills.ts': 1,
  'lib/connectors/xero/credit-notes.ts': 3,
  'lib/connectors/xero/invoices.ts': 1,
  'lib/connectors/xero/sync-processor.ts': 2,
}

test('CENSUS: every Xero CurrencyRate write in lib/ is listed, and each file takes the value from the fx.ts helper', () => {
  const files = tsFiles(join(ROOT, 'lib'))
  const found: Record<string, number> = {}
  for (const file of files) {
    const rel = relative(ROOT, file)
    const n = (code(readFileSync(file, 'utf8')).match(/(?:\.CurrencyRate\s*=(?!=)|\bCurrencyRate\s*:)/g) ?? []).length
    if (n > 0) found[rel] = n
  }
  console.log(`precondition: ${files.length} lib files scanned, ${Object.values(found).reduce((a, b) => a + b, 0)} CurrencyRate writes in ${Object.keys(found).length} files`)
  assert.ok(files.length > 200, 'the scan saw the library')
  assert.deepEqual(found, EXPECTED_CURRENCY_RATE_WRITES, 'a new CurrencyRate write must take its value from xeroCurrencyRateOrRefuse and be listed here')
  for (const rel of Object.keys(EXPECTED_CURRENCY_RATE_WRITES)) {
    assert.match(code(readFileSync(join(ROOT, rel), 'utf8')), /xeroCurrencyRateOrRefuse\s*\(/, `${rel} takes its rate from the one helper`)
  }
})

/**
 * The two spellings of a rate's reciprocal: `1 / x.rate` and `Decimal(1).div(x.rate)` / `toDecimal(1).div(x.rate)`. The Decimal form is
 * qualified by what it divides by (a rate or a ...ToBase value): the bare `Decimal(1).div(` also builds one minor unit
 * (`toDecimal(1).div(toDecimal(10).pow(dp))`) or an equal share (`new Prisma.Decimal(1).div(lines.length)`), and about ten such legitimate
 * sites exist in lib/. Listing those would make the census flag correct code.
 */
const RECIPROCAL_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['1 / rate', /\b1\s*\/\s*\(?\s*[A-Za-z_$][\w$.!?]*(?:[Rr]ate|ToBase)\b/g],
  ['Decimal(1).div(rate)', /\b(?:Decimal|toDecimal)\(\s*1\s*\)\.div\(\s*[^)]*(?:[Rr]ate|ToBase)\b/g],
]

test('CENSUS: no reciprocal of a rate anywhere in lib/, app/ or scripts/, and the helper itself does not divide', () => {
  const dirs = ['lib', 'app', 'scripts']
  const scanned: Record<string, number> = {}
  for (const dir of dirs) {
    for (const file of tsFiles(join(ROOT, dir))) {
      scanned[dir] = (scanned[dir] ?? 0) + 1
      const text = code(readFileSync(file, 'utf8'))
      for (const [name, pattern] of RECIPROCAL_PATTERNS) {
        const hits = text.match(pattern)
        assert.equal(hits, null, `${relative(ROOT, file)} (${name}): ${hits?.join(', ')}`)
      }
    }
  }
  console.log(`precondition: reciprocal census scanned ${JSON.stringify(scanned)}`)
  assert.ok((scanned.lib ?? 0) > 200 && (scanned.app ?? 0) > 50 && (scanned.scripts ?? 0) > 20, `the scan saw the three trees (${JSON.stringify(scanned)})`)
  // The patterns catch what they are for (so a clean scan is not a vacuous one), and not a minor unit.
  const matches = (i: number, text: string) => new RegExp(RECIPROCAL_PATTERNS[i]![1].source).test(text)
  assert.ok(matches(0, 'const x = 1 / data.currencyRateToBase'))
  assert.ok(matches(1, 'const x = toDecimal(1).div(order.fxRateToBase)'))
  assert.ok(matches(1, 'new Prisma.Decimal(1).div(settlementRate)'))
  assert.ok(!matches(1, 'toDecimal(1).div(toDecimal(10).pow(dp))'), 'a minor unit is not a reciprocal of a rate')
  const helper = code(readFileSync(join(ROOT, 'lib/connectors/xero/fx.ts'), 'utf8'))
  const body = helper.slice(helper.indexOf('export function imsRateToXeroCurrencyRate'), helper.indexOf('export class XeroForeignCurrencyRateError'))
  assert.ok(body.length > 0)
  assert.doesNotMatch(body, /\/\s*n\b|1\s*\//, 'imsRateToXeroCurrencyRate never inverts')
  assert.match(helper, /documentAmount\.div\(/, 'the read direction divides by Xero\'s rate')
})
