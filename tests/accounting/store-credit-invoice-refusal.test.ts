import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { LEDGER_CHECK_PREAMBLE } from '@/lib/domain/accounting/hand-post-instruction'
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'
import {
  orderCarriesStoreCredit,
  storeCreditCreditNotePosterError,
  storeCreditInvoicePosterError,
  storeCreditInvoiceQueuedNotice,
  storeCreditInvoiceRefusalReason,
} from '@/lib/domain/accounting/store-credit-invoice-refusal'

/**
 * An order that carries store credit does not get a sales invoice (or a credit note) posted until the
 * 813/816 payment posting exists. The refusal is read from the ORDER, under the order lock, in the
 * poster's own guard, so it covers every producer (import, held release, manual re-queue, update).
 */

type Row = { customerId: string | null; status: string; storeCreditForeign: unknown }
const state: { row: Row | null; refundRow: { order: { storeCreditForeign: unknown } } | null | 'throw'; retired: number } = {
  row: null, refundRow: null, retired: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: async () => [],
          salesOrder: { findUnique: async () => state.row },
          accountingSyncLog: { updateMany: async () => { state.retired += 1; return { count: 1 } } },
          accountingEvent: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
          accountingEventLog: { createMany: async () => ({ count: 0 }) },
        }),
      salesOrderRefund: {
        findUnique: async () => {
          if (state.refundRow === 'throw') throw new Error('connection reset')
          return state.refundRow
        },
      },
    },
  },
})

const ATTEMPT = { id: 'sync-1', attemptRevision: 1 }
const HELD = claimHeldFrom(new Date('2026-04-01T11:58:00.000Z'))

async function processor() {
  return import('@/lib/connectors/xero/sync-processor')
}

function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

test.beforeEach(() => {
  state.row = { customerId: 'cust-1', status: 'PROCESSING', storeCreditForeign: '0.0000' }
  state.refundRow = null
  state.retired = 0
})

test('CONTROL: an order with NO store credit posts (the rig can say yes)', async () => {
  const { guardCancelledSalesOrderInvoice } = await processor()
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)
  precondition('no credit', { storeCreditForeign: state.row!.storeCreditForeign })
  assert.equal(result.post, true)
})

test('an order that carries store credit is REFUSED before posting, as an ordinary sync failure', async () => {
  const { guardCancelledSalesOrderInvoice } = await processor()
  state.row = { customerId: 'cust-1', status: 'PROCESSING', storeCreditForeign: '12.0000' }
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)
  precondition('credit order', { storeCreditForeign: state.row.storeCreditForeign, orderCarriesStoreCredit: orderCarriesStoreCredit(state.row.storeCreditForeign) })
  assert.equal(result.post, false)
  assert.equal(result.post === false && result.result.success, false, 'a failure the row shows, not a skip')
  assert.equal(result.post === false && result.result.error, storeCreditInvoicePosterError(), 'the single-sourced text')
  assert.equal(state.retired, 0, 'it does not retire the row: the posting is still owed')
})

test('a CANCELLED credit order is still just retired (cancellation wins over the refusal)', async () => {
  const { guardCancelledSalesOrderInvoice } = await processor()
  state.row = { customerId: 'cust-1', status: 'CANCELLED', storeCreditForeign: '12.0000' }
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)
  precondition('cancelled credit order', { status: state.row.status, storeCreditForeign: state.row.storeCreditForeign })
  assert.equal(result.post === false && result.result.skipped, true)
  assert.equal(state.retired, 1)
})

test('an UNREADABLE credit amount fails closed: it is not "no credit"', async () => {
  const { guardCancelledSalesOrderInvoice } = await processor()
  state.row = { customerId: 'cust-1', status: 'PROCESSING', storeCreditForeign: 'garbage' }
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)
  precondition('unreadable', { storeCreditForeign: 'garbage', carries: orderCarriesStoreCredit('garbage') })
  assert.equal(result.post, false)
})

test('REFUND of a credit order: its credit note is refused too; a no-credit refund, and other references, pass', async () => {
  const { guardStoreCreditCreditNote } = await processor()
  state.refundRow = { order: { storeCreditForeign: '12.0000' } }
  const refused = await guardStoreCreditCreditNote('SalesOrderRefund', 'refund-1')
  precondition('refund of credit order', { storeCreditForeign: '12.0000' })
  assert.equal(refused?.success, false)
  assert.equal(refused?.error, storeCreditCreditNotePosterError())

  state.refundRow = { order: { storeCreditForeign: '0.0000' } }
  assert.equal(await guardStoreCreditCreditNote('SalesOrderRefund', 'refund-1'), null, 'control: no credit posts')
  assert.equal(await guardStoreCreditCreditNote('SalesOrder', 'order-1'), null, 'not a refund-keyed note: not this guard')

  state.refundRow = null
  assert.equal((await guardStoreCreditCreditNote('SalesOrderRefund', 'refund-1'))?.success, false, 'a refund that cannot be found fails closed')
  state.refundRow = 'throw'
  const unreadable = await guardStoreCreditCreditNote('SalesOrderRefund', 'refund-1')
  assert.equal(unreadable?.success, false, 'an order that cannot be read is not "no store credit"')
  assert.match(unreadable?.error ?? '', /Could not read the order of refund refund-1/)
})

test('the poster consults the guards BEFORE it can send: create, update and credit note', () => {
  const src = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const region = (from: string, to: string) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + 1)
    assert.ok(a >= 0 && b > a, `markers ${from} .. ${to} must both be present or this scan measures nothing`)
    return src.slice(a, b)
  }
  const create = region("case 'SALES_INVOICE': {", "case 'SALES_INVOICE_UPDATE': {")
  const update = region("case 'SALES_INVOICE_UPDATE': {", "case 'PURCHASE_INVOICE': {")
  const note = region("case 'CREDIT_NOTE': {", "case 'PURCHASE_CREDIT_NOTE': {")
  const at = (text: string, needle: string) => text.indexOf(needle)
  precondition('wiring', {
    createGuard: at(create, 'guardCancelledSalesOrderInvoice('), createPost: at(create, 'pushSalesInvoice({'),
    updateGuard: at(update, 'guardCancelledSalesOrderInvoice('), updatePost: at(update, 'updateSalesInvoice('),
    noteGuard: at(note, 'guardStoreCreditCreditNote('), notePost: at(note, 'pushCreditNote({'),
  })
  for (const [name, text, guard, post] of [
    ['create', create, 'guardCancelledSalesOrderInvoice(', 'pushSalesInvoice({'],
    ['update', update, 'guardCancelledSalesOrderInvoice(', 'updateSalesInvoice('],
    ['credit note', note, 'guardStoreCreditCreditNote(', 'pushCreditNote({'],
  ] as const) {
    assert.ok(at(text, guard) > 0 && at(text, post) > 0, `${name}: guard and post are both present`)
    assert.ok(at(text, guard) < at(text, post), `${name}: the guard runs before the post`)
  }
  assert.match(note, /if \(storeCreditRefusal\) return storeCreditRefusal/, 'a credit-note refusal is returned, not swallowed')
})

test('operator text is single-sourced, conditional, and states nothing the evidence cannot support', () => {
  const reason = storeCreditInvoiceRefusalReason()
  const notice = storeCreditInvoiceQueuedNotice('1001', 'GBP 12.00')
  precondition('text', { reasonChars: reason.length })
  assert.ok(storeCreditInvoicePosterError().endsWith(reason), 'the poster error is the reason, verbatim')
  assert.ok(notice.includes(reason), 'the import notice carries the same reason, verbatim')
  // The queued notice is written before any attempt, so it must not claim anything was or was not sent.
  assert.doesNotMatch(notice, /NOTHING WAS SENT|was not sent|nothing was sent/i)
  assert.match(notice, /IMS will refuse the sales invoice queued for it when that invoice comes up for posting/)
  // The only instruction in the reason is conditional and names the check first.
  const instructions = reason.split(/(?<=[.!?])\s+/).filter((s) => /\braise\b/i.test(s))
  assert.equal(instructions.length, 1)
  assert.match(instructions[0], /^If this order must be invoiced now, first check the ledger/)
  for (const text of [reason, storeCreditCreditNotePosterError()]) {
    assert.doesNotMatch(text, /\b(reverse|void|re-?post|delete)\b/i, 'no destructive money instruction')
  }
  assert.match(storeCreditCreditNotePosterError(), /check the ledger first, then raise/)
  // Both hand-post instructions carry the repo's ledger-check preamble in front, by construction.
  for (const text of [reason, storeCreditCreditNotePosterError()]) {
    assert.ok(text.includes(LEDGER_CHECK_PREAMBLE), 'the ledger-check preamble is in front of the hand-post instruction')
  }
})
