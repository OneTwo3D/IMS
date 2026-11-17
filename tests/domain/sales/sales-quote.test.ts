import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_QUOTE_TEMPLATE,
  QUOTE_STATUS_MOVE_REFUSAL,
  addDaysYmd,
  decideQuoteConversion,
  isQuoteExpired,
  parseQuoteDate,
  quoteStatusMoveRefused,
  validateQuoteInput,
  ymdInZone,
} from '../../../lib/domain/sales/sales-quote.ts'
import { buildSalesOrderListWhere } from '../../../lib/domain/lists/order-list-query.ts'
import { orderListHref } from '../../../lib/domain/lists/order-list-url.ts'
import { WMS_CREATE_READY_STATUSES, wmsCreateEligibleOrderWhere } from '../../../lib/domain/wms/create-eligibility.ts'
import { SALES_QUOTE_EMAIL_KIND } from '../../../lib/domain/sales/sales-quote.ts'
import { nextStatusActions } from '../../../lib/domain/sales/status-flow.ts'

const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8')
const TODAY = '2026-11-18'

test('dates: a validity date is a real calendar date, and arithmetic does not drift', () => {
  assert.equal(parseQuoteDate('2026-02-28'), '2026-02-28')
  assert.equal(parseQuoteDate('2026-02-30'), null)
  assert.equal(parseQuoteDate('18/11/2026'), null)
  assert.equal(parseQuoteDate(''), null)
  assert.equal(addDaysYmd('2026-11-18', 30), '2026-12-18')
  assert.equal(addDaysYmd('2026-12-20', 30), '2027-01-19')
  assert.equal(ymdInZone(new Date('2026-11-18T23:30:00Z'), 'Pacific/Auckland'), '2026-11-19')
  assert.equal(ymdInZone(new Date('2026-11-18T23:30:00Z'), 'Europe/London'), '2026-11-18')
})

test('a quote is valid THROUGH its date and expires the day after; only a quote can expire', () => {
  assert.equal(isQuoteExpired({ isQuote: true, quoteValidUntil: '2026-11-18' }, TODAY), false)
  assert.equal(isQuoteExpired({ isQuote: true, quoteValidUntil: '2026-11-17' }, TODAY), true)
  assert.equal(isQuoteExpired({ isQuote: true, quoteValidUntil: null }, TODAY), false)
  assert.equal(isQuoteExpired({ isQuote: false, quoteValidUntil: '2020-01-01' }, TODAY), false)
})

test('create/edit input: a quote is a draft with a real, not-past validity date; a plain order carries none', () => {
  assert.deepEqual(validateQuoteInput({ isQuote: true, isDraft: true, quoteValidUntil: '2026-12-01' }, TODAY), { ok: true, isQuote: true, quoteValidUntil: '2026-12-01' })
  assert.deepEqual(validateQuoteInput({ isDraft: true }, TODAY), { ok: true, isQuote: false, quoteValidUntil: null })
  assert.equal(validateQuoteInput({ isQuote: true, isDraft: false, quoteValidUntil: '2026-12-01' }, TODAY).ok, false, 'never a live order')
  assert.equal(validateQuoteInput({ isQuote: true, isDraft: true }, TODAY).ok, false, 'a date is required')
  assert.equal(validateQuoteInput({ isQuote: true, isDraft: true, quoteValidUntil: '2026-02-30' }, TODAY).ok, false)
  assert.equal(validateQuoteInput({ isQuote: true, isDraft: true, quoteValidUntil: '2026-11-17' }, TODAY).ok, false, 'past')
  assert.equal(validateQuoteInput({ isQuote: true, isDraft: true, quoteValidUntil: '2026-11-17' }, TODAY, { allowPastDate: '2026-11-17' }).ok, true, 'an edit that leaves an already-past date alone')
  assert.equal(validateQuoteInput({ isQuote: false, isDraft: true, quoteValidUntil: '2026-12-01' }, TODAY).ok, false, 'a date belongs to a quote only')
})

test('conversion: only a draft quote, never a storefront order; expired needs a note; unexpired takes none', () => {
  const quote = { isQuote: true, status: 'DRAFT', quoteValidUntil: '2026-12-01', hasExternalSource: false }
  assert.deepEqual(decideQuoteConversion(quote, TODAY), { ok: true, expired: false, overrideNote: null })
  assert.deepEqual(decideQuoteConversion(quote, TODAY, 'ignored'), { ok: true, expired: false, overrideNote: null })
  const expired = { ...quote, quoteValidUntil: '2026-11-01' }
  const refused = decideQuoteConversion(expired, TODAY)
  assert.equal(refused.ok, false)
  assert.match((refused as { error: string }).error, /expired on 2026-11-01/)
  assert.equal(decideQuoteConversion(expired, TODAY, '   ').ok, false, 'a blank note is no note')
  assert.deepEqual(decideQuoteConversion(expired, TODAY, ' customer confirmed the price by phone '), { ok: true, expired: true, overrideNote: 'customer confirmed the price by phone' })
  assert.equal(decideQuoteConversion(expired, TODAY, 'x'.repeat(501)).ok, false)
  assert.equal(decideQuoteConversion({ ...quote, isQuote: false }, TODAY).ok, false, 'not a quote')
  assert.equal(decideQuoteConversion({ ...quote, status: 'PROCESSING' }, TODAY).ok, false, 'not a draft')
  assert.equal(decideQuoteConversion({ ...quote, hasExternalSource: true }, TODAY).ok, false, 'storefront orders are never quotes')
})

test('a quote cannot leave the draft state except to be cancelled; an order is not constrained', () => {
  for (const target of ['PROCESSING', 'PENDING_PAYMENT', 'ON_HOLD', 'ALLOCATED', 'SHIPPED']) assert.equal(quoteStatusMoveRefused(true, target), QUOTE_STATUS_MOVE_REFUSAL, target)
  assert.equal(quoteStatusMoveRefused(true, 'CANCELLED'), null)
  assert.equal(quoteStatusMoveRefused(true, 'DRAFT'), null)
  for (const target of ['PROCESSING', 'ON_HOLD', 'CANCELLED']) assert.equal(quoteStatusMoveRefused(false, target), null)
})

test('the Quotes tab filters on the flag, combines with search, and is in the address', () => {
  assert.deepEqual(buildSalesOrderListWhere({ quotesOnly: true }), { AND: [{ archived: { not: true } }, { isQuote: true }, { status: { notIn: ['COMPLETED', 'DELIVERED'] } }] })
  assert.deepEqual(JSON.stringify(buildSalesOrderListWhere({ quotesOnly: false })).includes('isQuote'), false)
  assert.ok(JSON.stringify(buildSalesOrderListWhere({ quotesOnly: true, q: 'acme' })).includes('isQuote'))
  const state = { q: '', statuses: [], page: 1, showCompleted: false, includeArchived: false, invoiced: false, returned: false }
  assert.equal(orderListHref('/sales', { ...state, quotes: true }), '/sales?quotes=1')
  assert.equal(orderListHref('/sales', state), '/sales')
})

test('the default Quote template states no payment terms', () => {
  assert.equal(DEFAULT_QUOTE_TEMPLATE.showPaymentTerms, false)
  assert.equal(DEFAULT_QUOTE_TEMPLATE.paymentTermsText, '')
  assert.match(DEFAULT_QUOTE_TEMPLATE.footerNote, /not an order or an invoice/)
})

// ---- A quote behaves as a draft in every consumer -------------------------------------------------------------------------
// The flag is not an input to any of them, and the draft rule each applies is the one a quote inherits.

test('not pushed to the warehouse: the create pass reads PROCESSING and ALLOCATED only, whatever the flag', () => {
  assert.ok(!(WMS_CREATE_READY_STATUSES as readonly string[]).includes('DRAFT'))
  const where = wmsCreateEligibleOrderWhere(['wh-1'], null) as { status: { in: string[] } } & Record<string, unknown>
  assert.deepEqual(where.status.in, ['PROCESSING', 'ALLOCATED'])
  assert.equal('isQuote' in where, false, 'the predicate does not special-case a quote: it is excluded as the draft it is')
})

test('not allocated, reserves no stock: allocation skips a DRAFT under the order lock before its first write, and names no quote flag', () => {
  const src = read('lib/domain/sales/allocation-service.ts')
  const at = src.indexOf("if (!zeroDemand && lockedStatus === 'DRAFT')")
  assert.ok(at > 0, 'the DRAFT skip is present')
  assert.match(src.slice(at, at + 300), /skippedStatus: lockedStatus/)
  assert.doesNotMatch(src, /isQuote/, 'allocation does not know about quotes')
})

test('not invoiced: a draft is invoiced only when finalised, and a quote cannot be finalised nor numbered', () => {
  const sales = read('app/actions/sales.ts')
  // createSalesOrder queues the invoice only for a live order, never for isDraft (and a quote must be a draft).
  assert.match(sales, /if \(!input\.isDraft\) \{\s*\n\s*await lockSalesOrder\(tx, written\.id\)\s*\n\s*await queueSalesInvoiceForOrder/)
  // The status move is refused for a quote, before and under the order lock.
  assert.equal((sales.match(/quoteStatusMoveRefused\(/g) ?? []).length, 2)
  assert.match(sales, /if \(so\.isQuote\) throw new Error\('A quote is not invoiced/)
  assert.deepEqual(nextStatusActions('DRAFT', false), [{ label: 'Process', target: 'PROCESSING' }], 'the draft flow is unchanged; the detail page hides it for a quote')
})

test('a storefront order is never a quote: no importer names the flag, and the column defaults to false', () => {
  const schema = read('prisma/schema.prisma')
  assert.match(schema, /isQuote\s+Boolean\s+@default\(false\)\s+@map\("is_quote"\)/)
  for (const f of ['lib/connectors/woocommerce/sync/order-import.ts', 'lib/connectors/woocommerce/sync/completion-eligibility.ts']) assert.doesNotMatch(read(f), /isQuote|quoteValidUntil/, f)
  assert.match(read('app/actions/sales.ts'), /A quote has no external order number/)
})

test('the migration is additive and not before the floor', () => {
  const sql = read('prisma/migrations/20261118050000_sales_quotations/migration.sql')
  assert.match(sql, /ADD COLUMN "is_quote" BOOLEAN NOT NULL DEFAULT false/)
  assert.match(sql, /ADD COLUMN "quote_valid_until" DATE/)
  assert.match(sql, /ADD COLUMN "quote_sent_at" TIMESTAMP\(3\)/)
  assert.doesNotMatch(sql, /DROP|RENAME|UPDATE |DELETE /i)
})

test('the outbox kind spelled out where the document census reads it is the shared constant', () => {
  assert.equal(SALES_QUOTE_EMAIL_KIND, 'SALES_QUOTE')
  assert.match(read('lib/order-email.ts'), /kind === 'SALES_QUOTE'/)
  assert.match(read('app/actions/sales-quotes.ts'), /kind: 'SALES_QUOTE'/)
})
