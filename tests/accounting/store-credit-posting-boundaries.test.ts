import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { storeCreditFollowUpPosterError } from '@/lib/domain/accounting/store-credit-invoice-refusal'

/**
 * Every Xero posting entry point, and whether it carries the store-credit refusal.
 *
 * The refusal was first put on the invoice create/update and the credit note, and Codex found INVOICE_PAYMENT
 * reaching the remote payment call through a capacity guard that never reads the order's store credit. The
 * lesson is that "the places someone remembered" is not a set. So this census reads the processor's switch,
 * requires EVERY case label to be classified here (GUARDED, with the guard named, or EXEMPT, with the reason),
 * and fails when a case appears that nobody classified, so a new entry point cannot be added unexamined.
 */

type Row = { guard: string | null; exempt: string | null; remote: string | null; returns: string | null }
// `returns` is the statement that makes the guard's answer BINDING: a guard whose answer is computed and then ignored is no guard.
const G = (guard: string, remote: string, returns: string | null = null): Row => ({ guard, exempt: null, remote, returns })
const E = (exempt: string): Row => ({ guard: null, exempt, remote: null, returns: null })
const JOURNAL = E('stock/cost/deferral/FX/manufacturing journal: not a receivable, payment, customer document or credit note for a sales order')
const PURCHASING = E('purchasing document: has no sales order')

const CENSUS: Record<string, Row> = {
  SALES_INVOICE: G('guardCancelledSalesOrderInvoice(', 'pushSalesInvoice({'),
  SALES_INVOICE_UPDATE: G('guardCancelledSalesOrderInvoice(', 'updateSalesInvoice('),
  INVOICE_PAYMENT: G("guardStoreCreditFollowUp(", 'guardInvoicePaymentCapacity(', 'if (creditRefusal) return creditRefusal'),
  INVOICE_EMAIL: G("guardStoreCreditFollowUp(orderId, 'invoice email')", 'sendAccountingInvoiceEmailInternal(', 'if (emailCreditRefusal) return emailCreditRefusal'),
  WC_INVOICE_NOTE: G("guardStoreCreditFollowUp(orderId, 'WooCommerce invoice note')", 'pushInvoiceNoteToWc(', 'if (noteCreditRefusal) return noteCreditRefusal'),
  CREDIT_NOTE: G('guardStoreCreditCreditNote(', 'pushCreditNote({', 'if (storeCreditRefusal) return storeCreditRefusal'),
  INVOICE_PDF: E('read-only: downloads a PDF Xero already holds; posts and sends nothing'),
  PURCHASE_INVOICE: PURCHASING,
  PURCHASE_INVOICE_UPDATE: PURCHASING,
  BILL_ATTACHMENT: PURCHASING,
  BILL_PAYMENT: PURCHASING,
  PURCHASE_CREDIT_NOTE: PURCHASING,
  PURCHASE_CREDIT_NOTE_ALLOCATION: PURCHASING,
  TAX_RATE_SYNC: E('tax-rate reference data: no order'),
  COGS_JOURNAL: JOURNAL, INVENTORY_ADJUSTMENT: JOURNAL, STOCK_IN_TRANSIT: JOURNAL, STOCK_RECEIPT: JOURNAL,
  COGS_REVERSAL: JOURNAL, STOCK_ALLOCATION: JOURNAL, DAILY_BATCH_REVENUE_DEFERRAL: JOURNAL,
  DAILY_BATCH_INVENTORY_ALLOC: JOURNAL, DAILY_BATCH_GROUP_B: JOURNAL, DAILY_BATCH_INVENTORY_RECONCILIATION: JOURNAL,
  DAILY_BATCH_COGS_RECONCILIATION: JOURNAL, DAILY_BATCH_TRANSIT_RECONCILIATION: JOURNAL, UNEARNED_REV_REVERSAL: JOURNAL,
  ALLOCATION_REVERSAL: JOURNAL, REALISED_FX_JOURNAL: JOURNAL, UNREALISED_FX_JOURNAL: JOURNAL,
  MANUFACTURING_JOURNAL: JOURNAL, MANUFACTURING_RECLASS: JOURNAL,
}

function processEntrySource(): string {
  const src = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const start = src.indexOf('async function processEntry(')
  const end = src.indexOf('export async function repairXeroBackReferences', start)
  assert.ok(start > 0 && end > start, 'the processor markers must both be present or this census measures nothing')
  return src.slice(start, end)
}

function caseRegion(body: string, label: string): string {
  const open = body.indexOf(`\n    case '${label}'`)
  assert.ok(open >= 0, `case ${label} must be found`)
  const next = body.slice(open + 1).search(/\n    case '|\n    default:/)
  return body.slice(open, next < 0 ? undefined : open + 1 + next)
}

test('CENSUS: every Xero posting entry point is classified, and every GUARDED one consults its guard BEFORE its remote call', () => {
  const body = processEntrySource()
  const labels = [...body.matchAll(/\n    case '([A-Z_]+)'/g)].map((m) => m[1])
  const guarded = Object.entries(CENSUS).filter(([, r]) => r.guard)
  const exempt = Object.entries(CENSUS).filter(([, r]) => r.exempt)
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION census: ${labels.length} case labels found, ${guarded.length} GUARDED (${guarded.map(([k]) => k).join(', ')}), ${exempt.length} EXEMPT`)
  assert.ok(labels.length >= 30, 'precondition: the scan found the processor switch, not an empty slice')
  assert.deepEqual([...new Set(labels)].sort(), Object.keys(CENSUS).sort(), 'a posting entry point is unclassified (or a classified one is gone)')
  assert.equal(guarded.length, 6)
  for (const [label, row] of guarded) {
    const region = caseRegion(body, label)
    const g = region.indexOf(row.guard!)
    const r = region.indexOf(row.remote!)
    assert.ok(g >= 0, `${label}: the store-credit guard ${row.guard} is missing`)
    assert.ok(r >= 0, `${label}: the remote call ${row.remote} is missing, so the order check below proves nothing`)
    assert.ok(g < r, `${label}: the guard must run before ${row.remote}`)
    if (row.returns) {
      const at = region.indexOf(row.returns)
      assert.ok(at >= 0 && at < r, `${label}: the guard's answer must be RETURNED (${row.returns}) before ${row.remote}`)
    }
  }
  for (const [label, row] of exempt) assert.ok(row.exempt!.length > 20, `${label} needs a real reason`)
})

test('INVOICE_PAYMENT is refused before the capacity guard, whichever way it was enqueued, revived or retried', () => {
  const region = caseRegion(processEntrySource(), 'INVOICE_PAYMENT')
  assert.match(region, /if \(creditRefusal\) return creditRefusal/)
  assert.ok(region.indexOf('guardStoreCreditFollowUp(') < region.indexOf('guardInvoicePaymentCapacity('))
  assert.ok(region.indexOf('guardStoreCreditFollowUp(') < region.indexOf('moneyPostDateToSend('))
})

const state: { row: { storeCreditForeign: unknown } | null | 'throw' } = { row: null }
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => {
          if (state.row === 'throw') throw new Error('connection reset')
          return state.row
        },
      },
    },
  },
})

test('the follow-up guard: credit refuses, none passes, unreadable / missing / unreadable-order all fail CLOSED', async () => {
  const { guardStoreCreditFollowUp } = await import('@/lib/connectors/xero/sync-processor')
  const cases: Array<[string, typeof state.row, 'refused' | 'pass', RegExp | null]> = [
    ['credit', { storeCreditForeign: '12.0000' }, 'refused', /belongs to an order paid in part with store credit/],
    ['no credit (control)', { storeCreditForeign: '0.0000' }, 'pass', null],
    ['unreadable amount', { storeCreditForeign: 'garbage' }, 'refused', /store credit/],
    ['order missing', null, 'refused', /not found/],
    ['read throws', 'throw', 'refused', /Could not read sales order/],
  ]
  for (const what of ['payment registration', 'invoice email', 'WooCommerce invoice note'] as const) {
    for (const [name, row, verdict, text] of cases) {
      state.row = row
      const result = await guardStoreCreditFollowUp('order-1', what)
      // eslint-disable-next-line no-console
      console.log(`PRECONDITION follow-up ${what} / ${name}: ${JSON.stringify(row)} -> ${result ? 'refused' : 'pass'}`)
      assert.equal(result ? 'refused' : 'pass', verdict, `${what} / ${name}`)
      if (text) assert.match(result?.error ?? '', text)
      if (name === 'credit') assert.equal(result?.error, storeCreditFollowUpPosterError(what), 'single-sourced text')
    }
  }
  assert.equal((await guardStoreCreditFollowUp(undefined, 'payment registration'))?.success, false, 'no order reference fails closed')
})
