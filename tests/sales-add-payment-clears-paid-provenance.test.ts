import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-psrx r5 (Codex HIGH 1, second half) — A RECEIPT REPLACES THE OFF-LEDGER PROVENANCE, INCLUDING
 * ON AN ORDER THAT WAS ALREADY PAID.
 *
 * `SalesOrder.unregisteredPaidAt` means "this paid flag was entered with no ledger receipt behind it
 * and none coming". r2 wrote, in `addPayment`, that "an order marked paid by hand and THEN given a
 * receipt must lose the marker" — and put the clearing write inside `if (becamePaid)`, which requires
 * `!so.paidAt`. The one order that sentence is about takes the other branch: it is ALREADY paid, so
 * the receipt lands, an INVOICE_PAYMENT is registered for it moments later, and the marker stands.
 *
 * WHAT IT COSTS. That marker is the paid-episode fence's lower bound and it is what makes
 * `PAID_WITHOUT_LEDGER_RECEIPT` reachable. A sale with a real, posted, ledger-visible receipt
 * therefore kept answering "IMS was never going to tell the ledger about a payment here", and a
 * genuine chargeback against it was never recognised — indefinitely, because nothing else clears the
 * column.
 *
 * WHY THIS DRIVES THE ACTION RATHER THAN RE-STATING ITS SHAPE. The defect was entirely in the WIRING:
 * the rule was written down correctly, in a branch that the case it was written for cannot reach. A
 * test that rebuilt `addPayment`'s writes by hand would have sailed straight over it, exactly as the
 * r2 concurrency test did. So the real action runs, with the database recorded rather than mocked
 * away per-call, and the assertions are on the writes it actually issues.
 *
 * r6 (Codex HIGH 2) — AND THE REPLACEMENT IS BY COVERAGE, NOT BY EXISTENCE.
 *
 * r5 cleared the marker on ANY non-refund receipt. `addPayment` explicitly permits PARTIAL receipts —
 * its only amount guard rejects an over-payment — so a GBP 1 receipt on a GBP 100 order marked paid by
 * hand erased the evidence that the other GBP 99 was settled off-ledger, which is a statement about the
 * whole balance and was still true. The rule is now the one `becamePaid` already applied: the
 * non-refund receipts on the order, this one included, must COVER its total. The two arms below —
 * partial leaves it standing, cumulative cover clears it — are the halves of that sentence, and
 * tests/accounting/partial-receipt-paid-provenance.test.ts is what the surviving marker then buys.
 */

type Row = Record<string, unknown>

const state = {
  order: null as Row | null,
  payments: [] as Row[],
  created: [] as Row[],
  updates: [] as { where: Row; data: Row }[],
  updateManys: [] as { where: Row; data: Row }[],
  registered: [] as Row[],
}

function reset(order: Row) {
  state.order = order
  state.payments = []
  state.created = []
  state.updates = []
  state.updateManys = []
  state.registered = []
}

const tx = {
  $queryRaw: async () => [],
  $executeRaw: async () => 0,
  salesOrder: {
    findUnique: async () => state.order,
    update: async (args: { where: Row; data: Row }) => {
      state.updates.push(args)
      return { id: 'so-1' }
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      state.updateManys.push(args)
      return { count: 1 }
    },
  },
  payment: {
    findMany: async () => state.payments,
    create: async (args: { data: Row }) => {
      state.created.push(args.data)
      return { id: 'pay-1', paidAt: args.data.paidAt }
    },
  },
  salesOrderRefund: { findFirst: async (): Promise<{ totalForeign: number } | null> => null },
  fxRate: { findFirst: async () => null },
  activityLog: { create: async () => ({}) },
}

mock.module('next/cache', {
  namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requirePermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    redactActivityLogText: (value: string) => value,
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
  namedExports: {
    registerInvoicePaymentWithLedger: async (args: Row) => { state.registered.push(args) },
    loadInvoicePaymentSyncRows: async () => [],
    payloadPaymentId: () => null,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...tx,
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      setting: { findUnique: async () => null },
    },
  },
})

async function addPayment(input: Row) {
  const mod = await import('../app/actions/sales.ts')
  return mod.addPayment(input as never)
}

/** The order this finding is about: paid by hand, no receipt, provenance recorded. */
const HAND_MARKED_PAID = {
  id: 'so-1',
  orderNumber: 'SO-1',
  externalOrderNumber: null,
  status: 'SHIPPED',
  refundStatus: null,
  currency: 'GBP',
  totalForeign: 100,
  totalBase: 100,
  fxRateToBase: 1,
  paidAt: new Date('2026-08-20T09:00:00.000Z'),
  invoiceNumber: 'INV-1',
}

test('[o3d-psrx r5] a COVERING receipt on an ALREADY-paid order clears its off-ledger provenance', async () => {
  reset({ ...HAND_MARKED_PAID })

  const result = await addPayment({ orderId: 'so-1', amount: 100, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))

  // THE PRECONDITION. This case only exists on the branch `becamePaid` cannot reach, so the test is
  // worthless unless the action really did take that branch: the receipt was written, and the
  // becamePaid `update` (which writes paidAt) was NOT issued.
  assert.equal(state.created.length, 1, 'the receipt must actually have been recorded')
  assert.equal(state.updates.length, 0,
    'the order was already paid, so the becamePaid path must NOT have run — that is the whole finding')

  const cleared = state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data)
  assert.equal(cleared.length, 1, 'the receipt must replace the off-ledger provenance')
  assert.deepEqual(cleared[0].data, { unregisteredPaidAt: null },
    'and it must clear ONLY the provenance — re-stamping paidAt would move a settlement date')
  assert.deepEqual(cleared[0].where, { id: 'so-1', unregisteredPaidAt: { not: null } })

  // And the receipt really is registered with the ledger, which is what makes the stale marker a lie.
  assert.equal(state.registered.length, 1)
})

test('[o3d-psrx r5] CONTROL: a receipt that MAKES the order paid still clears it in the paid write', async () => {
  reset({ ...HAND_MARKED_PAID, paidAt: null })

  const result = await addPayment({ orderId: 'so-1', amount: 100, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))

  assert.equal(state.updates.length, 1, 'the becamePaid path must have run')
  assert.deepEqual(state.updates[0].data.unregisteredPaidAt, null)
  assert.equal(state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data).length, 0,
    'and it must not ALSO issue the second write — one paid transition, one provenance write')
})

test('[o3d-psrx r5] CONTROL: a REFUND receipt does not touch the invoice-side provenance', async () => {
  reset({ ...HAND_MARKED_PAID })
  // A refund receipt settles a credit note, not the invoice, so it says nothing about whether the
  // ledger was ever told about the invoice payment.
  const withRefund = { ...tx.salesOrderRefund }
  tx.salesOrderRefund.findFirst = async () => ({ totalForeign: 100 })

  const result = await addPayment({ orderId: 'so-1', refundId: 'ref-1', amount: 100, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.created.length, 1, 'the refund receipt must actually have been recorded')
  assert.equal(state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data).length, 0)
  assert.equal(state.registered.length, 0, 'and no INVOICE_PAYMENT is raised for a refund receipt')

  tx.salesOrderRefund.findFirst = withRefund.findFirst
})

test('[o3d-psrx r6] a PARTIAL receipt on an already-paid order leaves the provenance STANDING', async () => {
  reset({ ...HAND_MARKED_PAID })

  // A penny of a hundred pounds. The action accepts it — its only amount guard is against an
  // OVER-payment — and that acceptance is the whole finding: r5 treated the receipt's EXISTENCE as
  // the replacement, so this write erased the evidence that the other GBP 99 was settled off-ledger.
  const result = await addPayment({ orderId: 'so-1', amount: 1, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))

  // THE PRECONDITIONS, so this cannot pass by refusing the receipt or by taking the paid branch.
  assert.equal(state.created.length, 1, 'the partial receipt must actually have been recorded')
  assert.equal(Number(state.created[0].amount), 1)
  assert.equal(state.updates.length, 0, 'the order was already paid — the becamePaid path must not run')

  assert.deepEqual(state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data), [],
    'GBP 1 does not settle GBP 100, so the marker — which speaks for the WHOLE paid balance — stands')

  // And the receipt is still registered with the ledger. Withholding the provenance change is not
  // withholding the registration; the two are different facts.
  assert.equal(state.registered.length, 1)
})

test('[o3d-psrx r6] the receipt that COMPLETES the cover clears it — cumulatively, not on its own size', async () => {
  reset({ ...HAND_MARKED_PAID })
  // GBP 99 already recorded against this order. The receipt below is GBP 1 — identical in size to the
  // one above, and this time it is the one that finishes the job.
  state.payments = [{ amount: 99, currency: 'GBP' }]

  const result = await addPayment({ orderId: 'so-1', amount: 1, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))

  assert.equal(state.created.length, 1, 'the receipt must actually have been recorded')
  assert.equal(state.updates.length, 0, 'still the already-paid branch — paidAt must not be re-stamped')

  const cleared = state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data)
  assert.equal(cleared.length, 1, 'the receipts now cover the total, so nothing is settled off-ledger')
  assert.deepEqual(cleared[0].data, { unregisteredPaidAt: null })
  assert.deepEqual(cleared[0].where, { id: 'so-1', unregisteredPaidAt: { not: null } })
})

test('[o3d-psrx r6] CONTROL: a partial receipt that MAKES the order paid is not a thing', async () => {
  reset({ ...HAND_MARKED_PAID, paidAt: null })

  const result = await addPayment({ orderId: 'so-1', amount: 1, currency: 'GBP' })
  assert.equal(result.success, true, JSON.stringify(result))

  // The unpaid arm was always coverage-tested; this states that r6 did not loosen it. GBP 1 neither
  // sets `paidAt` nor touches the provenance of a flag that is not set.
  assert.equal(state.created.length, 1)
  assert.equal(state.updates.length, 0, 'GBP 1 of GBP 100 is not a paid transition')
  assert.deepEqual(state.updateManys.filter((u) => 'unregisteredPaidAt' in u.data), [])
})
