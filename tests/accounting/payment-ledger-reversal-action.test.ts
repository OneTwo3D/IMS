import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-1vuv — deletePayment's fail-closed ledger check, and reverseLedgerPayment, the remedy that
// makes the refusal reachable.
//
// THE PROPERTY UNDER TEST, in one line: IMS never removes a local receipt while a real ledger still
// holds the payment, and never accepts an operator's word that it does not.
//
// Every refusal is asserted on its SPECIFIC code. "The delete failed" and "Xero says payment PAY-9
// is still AUTHORISED" send an operator to two completely different places.

class ForbiddenError extends Error {}
class FreshAuthRequiredError extends Error {
  readonly code = 'fresh_auth_required'
  readonly reason = 'stale'
}

type SyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  payload: unknown
}

/**
 * `amount` is `number | string` on purpose: the column is `Decimal(18, 4)` and Prisma hands back a
 * Decimal, not a double. A double is what a naive test would use, and it would never notice that
 * `100.0000` and `100` have to compare equal while `100.004` and `100` must not.
 */
type PaymentRow = { id: string; orderId: string; refundId: string | null; amount: number | string; currency: string }

const state = {
  permissions: new Set<string>(['sales.refund']),
  freshAuthFails: false,
  order: { id: 'order-1', orderNumber: 'SO-1001', externalOrderNumber: null as string | null, currency: 'GBP', totalForeign: 100, status: 'SHIPPED', paidAt: null as Date | null, accountingInvoiceId: 'INV-abc' as string | null },
  payments: [] as PaymentRow[],
  syncRows: [] as SyncRow[],
  activity: [] as Array<Record<string, unknown>>,
  /**
   * Every `where` the production code asked accountingSyncLog for. Recorded because the
   * classification is only half the guard: a status the QUERY does not ask for is invisible to the
   * classifier and reads as "no registration exists", so the query has to be asserted on directly.
   */
  registrationQueries: [] as Array<Record<string, unknown>>,
  /** Xero's answer per PaymentID. Absent => the GET fails. */
  xeroPayments: new Map<string, string>(),
  /**
   * The REST of what Xero returns for a payment — the parts an operator-supplied reference has to be
   * checked against. Defaulted to "on this order's invoice, for this receipt's amount", because that
   * is the ordinary case; a test that wants a payment on somebody else's invoice says so here.
   *
   * `omit` models an `ok` response carrying no payment at all, which is neither an error nor an
   * answer — and must not be read as one.
   */
  xeroPaymentDetails: new Map<string, { invoiceId?: string | null; amount?: number | null; omit?: boolean }>(),
  xeroError: null as string | null,
  /**
   * What the INVOICE says is still standing on it — the fourth fact an operator-supplied reference
   * has to clear (Codex round 3, finding 2). Defaulted to an invoice carrying nothing, because the
   * ordinary case is a payment that has been reversed and an invoice with nothing left on it.
   *
   * `null` models a response with NO payment list at all, which is a question unanswered rather than
   * an answer of "nothing" — a double that always sent `[]` could not tell those apart.
   */
  xeroInvoicePayments: [] as Array<{ PaymentID?: string; Amount?: number | null }> | null,
  /** The invoice GET fails while the payment GET succeeds — they are separate calls and can fail apart. */
  xeroInvoiceError: null as string | null,
  /** An `ok` response listing no invoice at all. */
  xeroInvoiceMissing: false,
  xeroCalls: [] as string[],
  /** Runs once inside the transaction, right after the order lock, to move the world under the write. */
  mutateUnderLock: null as (() => void) | null,
  /**
   * Runs once immediately AFTER the registrations are read — the only window in which the
   * compare-and-swap on the retirement can miss. mutateUnderLock fires before that read, so it
   * exercises the ledger-hold branch instead and cannot reach this one.
   */
  mutateAfterRegistrationRead: null as (() => void) | null,
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((b) => matches(row, b))) return false
      continue
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object') {
      const test = condition as Record<string, unknown>
      for (const op of Object.keys(test)) {
        if (op === 'in') {
          if (!(test.in as unknown[]).includes(value)) return false
        } else if (op === 'not') {
          if (test.not === null ? value === null : value === test.not) return false
        } else {
          throw new Error(`test double does not implement where operator ${op}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}

function makeClient() {
  return {
    salesOrder: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) =>
        where.id === state.order.id ? project(state.order as unknown as Record<string, unknown>, select) : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if ('paidAt' in data) state.order.paidAt = data.paidAt as Date | null
        return state.order
      },
    },
    payment: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = state.payments.find((p) => p.id === where.id)
        return row ? project(row as unknown as Record<string, unknown>, select) : null
      },
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        state.payments
          .filter((p) => matches(p as unknown as Record<string, unknown>, where))
          .map((p) => project(p as unknown as Record<string, unknown>, select)),
      delete: async ({ where }: { where: { id: string } }) => {
        const index = state.payments.findIndex((p) => p.id === where.id)
        if (index < 0) throw new Error('payment not found')
        return state.payments.splice(index, 1)[0]
      },
    },
    accountingSyncLog: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        state.registrationQueries.push(where)
        const rows = state.syncRows
          .filter((r) => matches(r as unknown as Record<string, unknown>, where))
          .map((r) => project(r as unknown as Record<string, unknown>, select))
        if (state.mutateAfterRegistrationRead) {
          const mutate = state.mutateAfterRegistrationRead
          state.mutateAfterRegistrationRead = null
          mutate()
        }
        return rows
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = state.syncRows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
        for (const hit of hits) Object.assign(hit, data)
        return { count: hits.length }
      },
    },
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ id: state.order.id }],
  }
}

const client = makeClient()

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'op-1', role: 'ADMIN' } }),
    requirePermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1', role: 'ADMIN' } }
    },
    requireFreshPermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      if (state.freshAuthFails) throw new FreshAuthRequiredError('Re-authentication required')
      return { user: { id: 'op-1', role: 'ADMIN' } }
    },
    freshAuthFailureResult: (error: unknown) =>
      error instanceof FreshAuthRequiredError
        ? { success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale' }
        : null,
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      // ROLLBACK IS REAL: the point of moving the ledger check inside the transaction is that a
      // refusal leaves NOTHING written, and a double that just runs the callback cannot tell the
      // difference.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = {
          payments: state.payments.map((p) => ({ ...p })),
          syncRows: state.syncRows.map((r) => ({ ...r })),
          paidAt: state.order.paidAt,
        }
        try {
          // A RETURN commits, exactly as Prisma does. That is deliberate and load-bearing: a refusal
          // that returns after a partial write must be visible as the half-write it is, so the
          // production code has to THROW to roll back. Restoring on a returned error here would have
          // hidden precisely that bug.
          return await fn(client)
        } catch (error) {
          state.payments = snapshot.payments
          state.syncRows = snapshot.syncRows
          state.order.paidAt = snapshot.paidAt
          throw error
        }
      },
    },
  },
})

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      state.xeroCalls.push(path)
      if (path.startsWith('Invoices/')) {
        if (state.xeroInvoiceError) return { ok: false, status: 0, error: state.xeroInvoiceError }
        if (state.xeroInvoiceMissing) return { ok: true, status: 200, data: { Invoices: [] } }
        const invoiceId = decodeURIComponent(path.replace('Invoices/', ''))
        return {
          ok: true,
          status: 200,
          data: {
            Invoices: [{
              InvoiceID: invoiceId,
              ...(state.xeroInvoicePayments === null ? {} : {
                Payments: state.xeroInvoicePayments.map((entry) => ({
                  ...(entry.PaymentID === undefined ? {} : { PaymentID: entry.PaymentID }),
                  ...(entry.Amount === null || entry.Amount === undefined ? {} : { Amount: entry.Amount }),
                })),
              }),
            }],
          },
        }
      }
      if (state.xeroError) return { ok: false, status: 0, error: state.xeroError }
      const id = decodeURIComponent(path.replace('Payments/', ''))
      const status = state.xeroPayments.get(id)
      if (!status) return { ok: false, status: 404, error: 'not found' }
      const detail = state.xeroPaymentDetails.get(id) ?? {}
      if (detail.omit) return { ok: true, status: 200, data: { Payments: [] } }
      const invoiceId = detail.invoiceId === undefined ? state.order.accountingInvoiceId : detail.invoiceId
      const amount = detail.amount === undefined ? 100 : detail.amount
      return {
        ok: true,
        status: 200,
        data: {
          Payments: [{
            PaymentID: id,
            Status: status,
            ...(amount === null ? {} : { Amount: amount }),
            ...(invoiceId === null ? {} : { Invoice: { InvoiceID: invoiceId } }),
          }],
        },
      }
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async () => {
      if (state.mutateUnderLock) {
        const mutate = state.mutateUnderLock
        state.mutateUnderLock = null
        mutate()
      }
    },
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function loadActions() {
  const mod = await import('@/app/actions/sales')
  return { deletePayment: mod.deletePayment, reverseLedgerPayment: mod.reverseLedgerPayment }
}

function syncRow(over: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    status: 'SYNCED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: 'PAY-9',
    errorMessage: null,
    payload: { paymentId: 'pay-1' },
    ...over,
  }
}

function paymentStillThere() {
  return state.payments.some((p) => p.id === 'pay-1')
}

function row(id = 'log-1') {
  const found = state.syncRows.find((r) => r.id === id)
  assert.ok(found, `sync row ${id} should exist`)
  return found
}

test.beforeEach(() => {
  state.permissions = new Set(['sales.refund'])
  state.freshAuthFails = false
  state.order = { id: 'order-1', orderNumber: 'SO-1001', externalOrderNumber: null, currency: 'GBP', totalForeign: 100, status: 'SHIPPED', paidAt: new Date('2026-08-01T00:00:00.000Z'), accountingInvoiceId: 'INV-abc' }
  state.payments = [{ id: 'pay-1', orderId: 'order-1', refundId: null, amount: 100, currency: 'GBP' }]
  state.syncRows = [syncRow()]
  state.activity = []
  state.registrationQueries = []
  state.xeroPayments = new Map([['PAY-9', 'AUTHORISED']])
  state.xeroPaymentDetails = new Map()
  state.xeroError = null
  state.xeroInvoicePayments = []
  state.xeroInvoiceError = null
  state.xeroInvoiceMissing = false
  state.xeroCalls = []
  state.mutateUnderLock = null
  state.mutateAfterRegistrationRead = null
})

// ---------------------------------------------------------------------------
// deletePayment now fails closed
// ---------------------------------------------------------------------------

test('deleting a receipt the ledger already holds is REFUSED, and nothing is written', async () => {
  const { deletePayment } = await loadActions()
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, false)
  assert.equal(result.code, 'ledger_holds_payment')
  assert.match(result.error ?? '', /payment PAY-9/)
  assert.ok(paymentStillThere(), 'the receipt must survive the refusal')
  assert.equal(row().status, 'SYNCED', 'and the registration must not be retired behind it')
  assert.notEqual(state.order.paidAt, null, 'and paidAt must not be cleared')
})

test('a FAILED registration that names a document still refuses the delete', async () => {
  // o3d-ju8t: FAILED is not proof that nothing posted. The old query did not even LOOK at FAILED
  // rows, so a payment that reached Xero and then failed its writeback was deleted here in silence.
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'FAILED', externalTransactionId: 'PAY-9' })]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.code, 'ledger_holds_payment')
  assert.ok(paymentStillThere())
})

test('a FAILED registration with NO document id refuses the delete — a failure is not proof', async () => {
  // THE DEFECT. A FAILED row carrying no document id used to satisfy no branch of the split at all,
  // so it was classified as nothing, the delete proceeded, and the receipt disappeared while a
  // payment the attempt may well have created stayed in Xero. The processor POSTS BEFORE IT
  // PERSISTS, so this row is precisely the shape of "we called Xero and never learned what
  // happened" — a timeout, a dropped response, a worker killed mid-call.
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, false)
  // Its OWN code, not the ledger-hold one: the remedies differ, and the ledger-hold remedy (the
  // verified reversal) cannot run without a document id.
  assert.equal(result.code, 'registration_attempt_undecided')
  assert.match(result.error ?? '', /A failure is not proof that nothing was posted/)
  assert.match(result.error ?? '', /log-7/)
  assert.ok(paymentStillThere(), 'the receipt must survive an attempt nobody can account for')
  assert.equal(row('log-7').status, 'FAILED', 'and the failed entry is left exactly as it was')
  assert.notEqual(state.order.paidAt, null, 'and paidAt must not be cleared')
})

test('a FAILED registration is READ at all — the query, not just the classification', async () => {
  // The failure mode this pins is silent: a status the query omits never reaches the classifier and
  // is indistinguishable from "there is no registration", which is the permissive answer. Widening
  // the classifier without widening the query would leave the receipt deletable exactly as before,
  // and every classifier-level test would still pass.
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  await deletePayment('pay-1', 'order-1')
  const readWithStatus = state.registrationQueries.some((where) => {
    const branches = (where.OR ?? []) as Array<Record<string, unknown>>
    return branches.some((branch) => {
      const status = branch.status as { in?: unknown[] } | undefined
      return Array.isArray(status?.in) && status.in.includes('FAILED')
    })
  })
  assert.ok(readWithStatus, 'the registration query must ask for FAILED rows, not only rows with a document id')
})

test('a CANCELLED registration with no document id still lets the receipt go', async () => {
  // The boundary of the change. CANCELLED is the one status IMS only writes where "nothing was
  // sent" has already been established, so widening FAILED must not sweep it up and make an
  // ordinary correction impossible.
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'CANCELLED', externalTransactionId: null })]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, true)
  assert.ok(!paymentStillThere())
})

test('a receipt with only a queued registration deletes, retiring it in the SAME transaction', async () => {
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'PENDING', externalTransactionId: null })]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, true)
  assert.ok(!paymentStillThere())
  assert.equal(row().status, 'CANCELLED')
  assert.match(row().errorMessage ?? '', /Retired: the local payment it registered was deleted/)
  assert.equal(state.order.paidAt, null, 'the order is no longer fully paid')
})

test('a registration claimed by a worker mid-delete ABORTS the delete instead of stranding it', async () => {
  // THE WINDOW the old code could only report on AFTERWARDS, once the receipt was already gone: the
  // row is PENDING when it is read and PROCESSING by the time the retirement runs, so the
  // compare-and-swap misses and the whole delete must be abandoned.
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'PENDING', externalTransactionId: null })]
  state.mutateAfterRegistrationRead = () => { state.syncRows[0].status = 'PROCESSING' }
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.code, 'registration_in_flight')
  assert.ok(paymentStillThere(), 'the receipt must survive a registration that moved under us')
  // Deliberately no assertion on the row's own status here: the worker's claim is simulated INSIDE
  // this transaction, so the double's rollback undoes it too. What matters — and what the sibling
  // test below pins — is that nothing this action wrote survives.
})

test('a registration already claimed before the read refuses on the ledger hold instead', async () => {
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'PENDING', externalTransactionId: null })]
  state.mutateUnderLock = () => { state.syncRows[0].status = 'PROCESSING' }
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.code, 'ledger_holds_payment')
  assert.ok(paymentStillThere())
})

test('a registration naming a DIFFERENT receipt never blocks this one', async () => {
  // An imported paid order carries a legitimate INVOICE_PAYMENT with no local Payment behind it, and
  // matching by amount instead of by paymentId is what used to retract it (Codex, PR #582 round 2).
  const { deletePayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'other', payload: { paymentId: 'pay-999' } })]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, true)
  assert.equal(row('other').status, 'SYNCED', 'and the other receipt\'s registration is untouched')
})

test('a refund receipt settles a credit note, so no INVOICE_PAYMENT hold applies to it', async () => {
  const { deletePayment } = await loadActions()
  state.payments = [{ id: 'pay-1', orderId: 'order-1', refundId: 'refund-1', amount: 100, currency: 'GBP' }]
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.success, true)
  assert.equal(row().status, 'SYNCED', 'the invoice registration belongs to a different receipt entirely')
})

// ---------------------------------------------------------------------------
// reverseLedgerPayment — the remedy, and its verification
// ---------------------------------------------------------------------------

test('the reversal takes a FRESH session, not merely the refund permission', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.freshAuthFails = true
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.deepEqual(result, { success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale' })
  assert.ok(paymentStillThere())
})

test('the reversal is REFUSED while Xero still reports the payment AUTHORISED', async () => {
  const { reverseLedgerPayment } = await loadActions()
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'ledger_still_holds_payment')
  assert.match((result as { error: string }).error, /PAY-9 \(status AUTHORISED\)/)
  assert.ok(paymentStillThere(), 'an operator saying "I reversed it" does not make it so')
  assert.equal(row().status, 'SYNCED')
})

test('once Xero reports the payment DELETED, the receipt goes and the registration is retired', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments.set('PAY-9', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.deepEqual(result, { success: true })
  assert.ok(!paymentStillThere())
  assert.equal(row().status, 'CANCELLED')
  // The document id STAYS. A CANCELLED row that still names PAY-9 is a complete account of a payment
  // that existed and was undone; clearing it would erase why the reversal was ever needed.
  assert.equal(row().externalTransactionId, 'PAY-9')
  assert.match(row().errorMessage ?? '', /IMS confirmed it \(PAY-9\) was DELETED there/)
  assert.equal(state.order.paidAt, null)
  assert.equal(state.xeroCalls[0], 'Payments/PAY-9')
})

test('a Xero lookup failure refuses by that name and deletes nothing', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.xeroError = 'Not connected to Xero'
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /Not connected to Xero/)
  assert.ok(paymentStillThere())
})

test('a registration with no document id cannot be checked, so the reversal refuses', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'PROCESSING', externalTransactionId: null })]
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'unverifiable_in_flight')
  assert.equal(state.xeroCalls.length, 0)
  assert.ok(paymentStillThere())
})

test('a FAILED attempt with no document id refuses the REVERSAL too, and asks Xero nothing', async () => {
  // The remedy must not become the way round the refusal. There is no document to look up, so
  // "check and delete" could only ever delete on the operator's unchecked word — which is the exact
  // outcome the delete refusal exists to prevent.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'FAILED', externalTransactionId: null })]
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'attempt_undecided')
  assert.equal(state.xeroCalls.length, 0, 'there is nothing to ask Xero about')
  assert.ok(paymentStillThere())
  assert.notEqual(state.order.paidAt, null)
})

test('an undecided attempt is NOT reported as "the ledger holds nothing"', async () => {
  // The ordering that matters. An undecided attempt puts nothing in the ledger-hold bucket, so an
  // emptiness check reached first would answer no_ledger_hold — a confident statement of precisely
  // the fact nobody knows — and send the operator to the ordinary delete, which refuses. One
  // question must not get two contradictory answers.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ status: 'FAILED', externalTransactionId: null })]
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.notEqual((result as { code?: string }).code, 'no_ledger_hold')
})

// ---------------------------------------------------------------------------
// THE UNDECIDED ATTEMPT'S REMEDY: the operator names the payment, IMS checks it
//
// Round 1 left this branch of the remedy pointing back at the refusal it came from: "if a payment IS
// there, reverse it and delete this receipt" — and that delete refuses again, because reversing a
// payment in Xero changes nothing about a FAILED row naming no document. The way out cannot be to
// believe the operator; it is to let them supply the one fact IMS is missing (WHICH payment) and to
// go on verifying everything that follows from it.
// ---------------------------------------------------------------------------

test('an operator who NAMES the reversed payment gets it CHECKED, and only then does the receipt go', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { success: boolean }).success, true)
  assert.deepEqual(
    state.xeroCalls,
    ['Payments/PAY-42', 'Invoices/INV-abc'],
    'the reference is a place to look, and IMS looks — then asks the invoice what is still standing on it',
  )
  assert.ok(!paymentStillThere())
  assert.equal(state.order.paidAt, null)
  // THE ROW IS DECIDED, not merely retired. The id the processor never wrote down is written down
  // now, sourced and dated, so the row stops saying "an attempt, outcome unknown" for ever.
  const decided = row('log-7')
  assert.equal(decided.status, 'CANCELLED')
  assert.equal(decided.externalTransactionId, 'PAY-42')
  assert.match(decided.errorMessage ?? '', /an operator identified this failed attempt as payment PAY-42/)
  assert.match(decided.errorMessage ?? '', /invoice INV-abc/)
})

test('a named payment sitting on somebody ELSE\'s invoice is refused, and nothing is deleted', async () => {
  // Without this check the remedy degrades into "name any deleted payment in the tenant" — and a
  // Xero tenant is full of deleted payments. The reference has to name one that was on THIS invoice.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroPaymentDetails.set('PAY-42', { invoiceId: 'INV-someone-else' })
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'asserted_payment_not_on_invoice')
  assert.match((result as { error: string }).error, /INV-someone-else/)
  assert.ok(paymentStillThere())
  assert.equal(row('log-7').status, 'FAILED', 'and the attempt stays undecided')
  assert.equal(row('log-7').externalTransactionId, null)
})

test('a named payment for a DIFFERENT amount is refused — an invoice can carry several', () => {
  return (async () => {
    const { reverseLedgerPayment } = await loadActions()
    state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
    state.xeroPayments.set('PAY-42', 'DELETED')
    state.xeroPaymentDetails.set('PAY-42', { amount: 40 })
    const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
    assert.equal((result as { code?: string }).code, 'asserted_payment_amount_mismatch')
    assert.match((result as { error: string }).error, /for 40 and this receipt is for 100/)
    assert.ok(paymentStillThere())
  })()
})

// ---------------------------------------------------------------------------
// THE AMOUNT IS A FILTER, NOT AN IDENTIFIER (Codex round 3, finding 2)
// ---------------------------------------------------------------------------

test('a payment a HAIR away from this receipt\'s amount is refused, not rounded into a match', async () => {
  // THE DEFECT. Round 3 required three facts — same invoice, same amount, deleted — and compared the
  // amount with `Math.abs(ledger - receipt) > 0.005`. A tolerance on an amount admits a DIFFERENT
  // payment of a near-identical value, which is the "two payments against one invoice" case this
  // whole area exists to prevent, arrived at through the check meant to stop it. Ten pounds four
  // thousandths is not ten pounds; the ledger states amounts exactly and so does the receipt.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroPaymentDetails.set('PAY-42', { amount: 100.004 })
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'asserted_payment_amount_mismatch')
  assert.match((result as { error: string }).error, /for 100\.004 and this receipt is for 100/)
  assert.ok(paymentStillThere(), 'the receipt must survive')
  assert.equal(row('log-7').status, 'FAILED', 'and the attempt stays undecided')
  assert.equal(row('log-7').externalTransactionId, null)
})

test('the same amount written differently is the SAME amount — a stored Decimal is not a double', async () => {
  // The other half of dropping the tolerance: exactness must not become pedantry. The column is
  // Decimal(18, 4), so the receipt arrives as `100.0000` while Xero states `100`. Comparing the two
  // renderings as text would refuse every genuine match, which is a refusal an operator cannot fix.
  const { reverseLedgerPayment } = await loadActions()
  state.payments = [{ id: 'pay-1', orderId: 'order-1', refundId: null, amount: '100.0000', currency: 'GBP' }]
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroPaymentDetails.set('PAY-42', { amount: 100 })
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { success: boolean }).success, true)
  assert.ok(!paymentStillThere())
})

test('a receipt whose OWN amount cannot be read matches nothing, and says so', async () => {
  // The other side of the comparison can fail too. Reading an unreadable receipt amount as zero (or
  // as NaN, which compares false against everything) would either match a payment for nothing or
  // produce a mismatch message with `NaN` in it; neither is a fact, so this refuses as a lookup that
  // could not be completed and Xero is never asked about the invoice.
  const { reverseLedgerPayment } = await loadActions()
  state.payments = [{ id: 'pay-1', orderId: 'order-1', refundId: null, amount: 'not-a-number', currency: 'GBP' }]
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /cannot read this receipt's own amount as a plain decimal/)
  assert.ok(paymentStillThere())
  assert.deepEqual(state.xeroCalls, ['Payments/PAY-42'], 'and the invoice is never asked')
})

test('a payment for this receipt\'s amount STILL on the invoice refuses, however deleted the named one is', async () => {
  // THE CASE THE THREE FACTS CANNOT SEE, and the one that costs money. Every fact passes: PAY-42 is
  // on this invoice, it is for exactly this receipt's amount, and Xero says it is DELETED. And the
  // receipt's OWN payment — PAY-77, the same £100 — is still sitting on the invoice. Retiring the
  // registration here deletes the local receipt while the ledger goes on showing the invoice settled,
  // with nothing local left to contradict it: the exact state o3d-1vuv exists to make unreachable,
  // reached through the remedy instead of the fault.
  //
  // An amount cannot tell two payments apart. So the invoice is asked what is still standing on it,
  // and a standing payment for this amount is a refusal — IMS does not know which of the two the
  // operator's reference describes, and guessing is what deletes the wrong one.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoicePayments = [{ PaymentID: 'PAY-77', Amount: 100 }]
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'asserted_payment_amount_ambiguous')
  assert.match((result as { error: string }).error, /STILL carries a payment for 100 \(PAY-77\)/)
  assert.match((result as { error: string }).error, /payment PAY-42 was for that same amount/)
  assert.ok(paymentStillThere(), 'the receipt must survive')
  assert.equal(state.order.paidAt !== null, true, 'and the order stays paid')
  assert.equal(row('log-7').status, 'FAILED', 'and the attempt stays undecided')
  assert.equal(row('log-7').externalTransactionId, null, 'and no id is written onto it')
})

test('a standing payment for a DIFFERENT amount is not a candidate, so the reversal proceeds', async () => {
  // The refusal above must not become "an invoice with any payment on it can never be resolved". A
  // £40 payment standing on the invoice cannot be the £100 this receipt registered, so it excludes
  // nothing and the verified reversal goes through.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoicePayments = [{ PaymentID: 'PAY-77', Amount: 40 }]
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { success: boolean }).success, true)
  assert.ok(!paymentStillThere())
  assert.equal(row('log-7').externalTransactionId, 'PAY-42')
})

test('the named payment still listed ON the invoice is reported as one the ledger holds', async () => {
  // Two answers from the same ledger: the payment GET says DELETED, the invoice still lists it. The
  // contradiction is resolved in favour of "still there", because that is the reading that refuses.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoicePayments = [{ PaymentID: 'pay-42', Amount: 100 }]
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_still_holds_payment')
  assert.match((result as { error: string }).error, /PAY-42 \(status still listed on that invoice\)/)
  assert.ok(paymentStillThere())
})

test('an invoice the accounting system cannot be asked about refuses, and deletes nothing', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoiceError = 'connection reset'
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /about payment INV-abc[\s\S]*connection reset/)
  assert.ok(paymentStillThere())
  assert.equal(row('log-7').status, 'FAILED')
})

test('an invoice that lists no payments AT ALL is a question unanswered, not an answer of "none"', async () => {
  // An unpaid invoice answers with an EMPTY list. A response carrying no list is a different thing,
  // and reading it as "nothing is standing there" would delete the receipt on the absence of a field.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoicePayments = null
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /did not list the payments standing on that invoice/)
  assert.ok(paymentStillThere())
})

test('an invoice the accounting system returns nothing for refuses too', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoiceMissing = true
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.ok(paymentStillThere())
})

test('a standing payment with no readable amount cannot be ruled out, so it refuses', async () => {
  // The one that must not be skipped: a payment whose amount cannot be read is a payment that might
  // be for this receipt's amount, and `continue` here would be the same defect as a silently dropped
  // row in the refund walk.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroInvoicePayments = [{ PaymentID: 'PAY-77', Amount: null }]
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /\(PAY-77\) carries no readable amount/)
  assert.ok(paymentStillThere())
})

test('a document id IMS recorded itself is never disambiguated against the invoice', async () => {
  // The extra request is the price of accepting an id a HUMAN typed. A row whose id the processor
  // read back off Xero's own response names one payment and only one, so there is nothing to tell
  // apart and no reason to pay for a second call.
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments.set('PAY-9', 'DELETED')
  state.xeroInvoicePayments = [{ PaymentID: 'PAY-77', Amount: 100 }]
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { success: boolean }).success, true)
  assert.deepEqual(state.xeroCalls, ['Payments/PAY-9'], 'one call, about the id IMS wrote down itself')
})

test('a named payment Xero still reports as AUTHORISED is refused by that name', async () => {
  // "I have reversed it" is exactly the claim this path must not accept on its own. The check is the
  // same one the checkable rows face; only the way the id was obtained differs.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'AUTHORISED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_still_holds_payment')
  assert.match((result as { error: string }).error, /PAY-42 \(status AUTHORISED\)/)
  assert.ok(paymentStillThere())
  assert.equal(row('log-7').status, 'FAILED')
})

test('a reference Xero cannot find is a lookup failure, not a licence to delete', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-TYPO')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.ok(paymentStillThere())
})

test('an OK response carrying no payment is not an answer either', async () => {
  // Neither an error nor a payment. Read as "nothing there", it would delete the receipt on the
  // absence of evidence — the same move as reading a FAILED row as "nothing posted".
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroPaymentDetails.set('PAY-42', { omit: true })
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.ok(paymentStillThere())
})

test('a payment Xero reports with no amount cannot be matched to this receipt, so it refuses', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.xeroPaymentDetails.set('PAY-42', { amount: null })
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'ledger_lookup_failed')
  assert.match((result as { error: string }).error, /no amount/)
  assert.ok(paymentStillThere())
})

test('with no ledger invoice recorded there is nothing to attribute the payment to', async () => {
  // "It is deleted" says nothing about THIS receipt unless it was on THIS document, and an invoice
  // that never posted cannot have carried it. Refused before Xero is troubled at all.
  const { reverseLedgerPayment } = await loadActions()
  state.order.accountingInvoiceId = null
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'asserted_payment_unattributable')
  assert.equal(state.xeroCalls.length, 0)
  assert.ok(paymentStillThere())
})

test('TWO undecided attempts cannot be settled by one reference', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [
    syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null }),
    syncRow({ id: 'log-8', status: 'FAILED', externalTransactionId: null }),
  ]
  state.xeroPayments.set('PAY-42', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'attempt_undecided_ambiguous')
  assert.equal(state.xeroCalls.length, 0)
  assert.ok(paymentStillThere())
  assert.equal(row('log-7').status, 'FAILED')
  assert.equal(row('log-8').status, 'FAILED')
})

test('an empty reference is the same as none, so it lands on the refusal rather than on a lookup', async () => {
  // A blank box must not become a GET for the empty string, which addresses Xero's WHOLE payment
  // collection rather than one payment.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  const result = await reverseLedgerPayment('pay-1', 'order-1', '   ')
  assert.equal((result as { code?: string }).code, 'attempt_undecided')
  assert.equal(state.xeroCalls.length, 0)
  assert.ok(paymentStillThere())
})

test('a reference cannot stand in for a row that HAS a document id of its own', async () => {
  // The checkable path must not become bypassable by naming a friendlier payment: a row that names
  // PAY-9 is checked as PAY-9, whatever the operator types.
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments.set('PAY-42', 'DELETED')
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.deepEqual(state.xeroCalls, ['Payments/PAY-9'])
  assert.equal((result as { code?: string }).code, 'ledger_still_holds_payment')
  assert.match((result as { error: string }).error, /PAY-9 \(status AUTHORISED\)/)
  assert.ok(paymentStillThere())
})

test('a retry that posts a document id while Xero is being asked aborts the asserted write', async () => {
  // The row was undecided when the reference was checked and carries a real payment id by the time
  // the write lands — a payment nobody has looked at. The compare-and-swap is on the ABSENCE of that
  // id as well as on the status, so the whole thing rolls back.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.mutateUnderLock = () => { row('log-7').externalTransactionId = 'PAY-99' }
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'hold_moved')
  assert.ok(paymentStillThere())
  // The mutation itself was made inside the transaction, so the rollback takes it with it — what
  // matters is that NOTHING this call intended to write survives: no CANCELLED, no asserted note.
  assert.equal(row('log-7').status, 'FAILED', 'nothing was retired')
  assert.equal(row('log-7').errorMessage, null, 'and no asserted-reversal note was left behind')
})

test('a SECOND undecided attempt appearing during the check still aborts the asserted reversal', async () => {
  // "Accounted for" is not "none": the asserted row is expected to be there, and a row this call
  // never checked with the ledger is not.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  state.mutateUnderLock = () => {
    state.syncRows.push(syncRow({ id: 'log-late', status: 'FAILED', externalTransactionId: null }))
  }
  const result = await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  assert.equal((result as { code?: string }).code, 'hold_moved')
  assert.ok(paymentStillThere())
  assert.equal(row('log-7').status, 'FAILED')
})

test('the audit says the reference came from a HUMAN, and which invoice it was checked against', async () => {
  // A reference IMS read off its own registration and one an operator typed are different kinds of
  // evidence. An audit trail that cannot tell them apart cannot answer "who said this was the right
  // payment" a year later.
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ id: 'log-7', status: 'FAILED', externalTransactionId: null })]
  state.xeroPayments.set('PAY-42', 'DELETED')
  await reverseLedgerPayment('pay-1', 'order-1', 'PAY-42')
  const entry = state.activity.find((a) => a.action === 'payment_ledger_reversal_confirmed')
  assert.ok(entry)
  const metadata = entry.metadata as Record<string, unknown>
  assert.equal(metadata.assertedPaymentReference, 'PAY-42')
  assert.deepEqual(metadata.assertedUndecidedLogIds, ['log-7'])
  assert.equal(metadata.ledgerInvoiceId, 'INV-abc')
  assert.match(entry.description as string, /identified by the operator/)
})

test('a failed attempt appearing DURING the reversal aborts it rather than deleting over it', async () => {
  // The per-row compare-and-swap can only fence rows this call already knows about. The Xero GETs
  // take as long as Xero takes — long enough for the processor to claim a queued sibling, post it,
  // and record a failure with no document id. Deleting on top of that is the same defect reached
  // through a race instead of a misclassification.
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments = new Map([['PAY-9', 'DELETED']])
  state.mutateUnderLock = () => {
    state.syncRows.push(syncRow({ id: 'log-late', status: 'FAILED', externalTransactionId: null }))
  }
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'hold_moved')
  assert.ok(paymentStillThere(), 'nothing may be deleted while an unaccountable attempt is present')
  assert.equal(row('log-1').status, 'SYNCED', 'and the verified row must roll back with it')
})

test('a connector this check cannot ask is refused rather than trusted', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [syncRow({ connector: 'quickbooks' })]
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'connector_not_supported')
  assert.equal(state.xeroCalls.length, 0)
  assert.ok(paymentStillThere())
})

test('with nothing holding the receipt, the reversal sends the operator back to the ordinary delete', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = []
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'no_ledger_hold')
  assert.ok(paymentStillThere())
})

test('a registration that moved between the Xero check and the write is refused, not overwritten', async () => {
  // The row was re-posted under a NEW document id after Xero told us the old one was deleted. The
  // conclusion was drawn about PAY-9; it must not land on PAY-10.
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments.set('PAY-9', 'DELETED')
  state.mutateUnderLock = () => { state.syncRows[0].externalTransactionId = 'PAY-10' }
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'hold_moved')
  assert.ok(paymentStillThere())
  assert.equal(row().status, 'SYNCED', 'nothing was retired')
})

test('the confirmation is recorded with the document it checked and who checked it', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.xeroPayments.set('PAY-9', 'DELETED')
  await reverseLedgerPayment('pay-1', 'order-1')
  const entry = state.activity.find((a) => a.action === 'payment_ledger_reversal_confirmed')
  assert.ok(entry, 'undoing a payment that reached a real ledger must be on the record')
  assert.equal(entry.level, 'WARNING')
  const metadata = entry.metadata as Record<string, unknown>
  assert.deepEqual(metadata.externalTransactionIds, ['PAY-9'])
  assert.deepEqual(metadata.priorStatuses, ['SYNCED'])
  assert.deepEqual(metadata.accountingSyncLogIds, ['log-1'])
  assert.equal(metadata.userId, 'op-1')
  assert.equal(metadata.paymentId, 'pay-1')
})


// ---------------------------------------------------------------------------
// A refusal after a partial write must leave NOTHING behind
// ---------------------------------------------------------------------------

test('a delete refused mid-retirement leaves NO registration cancelled behind it', async () => {
  // Returning a refusal out of a Prisma interactive transaction COMMITS it. With two queued
  // registrations and one claimed under the lock, a returned refusal would commit the other one's
  // cancellation while telling the operator nothing was changed — a receipt still present with one
  // of its ledger registrations silently retired.
  const { deletePayment } = await loadActions()
  state.syncRows = [
    syncRow({ id: 'log-a', status: 'PENDING', externalTransactionId: null }),
    syncRow({ id: 'log-b', status: 'PENDING', externalTransactionId: null }),
  ]
  state.mutateAfterRegistrationRead = () => { state.syncRows[1].status = 'PROCESSING' }
  const result = await deletePayment('pay-1', 'order-1')
  assert.equal(result.code, 'registration_in_flight')
  assert.ok(paymentStillThere())
  assert.equal(row('log-a').status, 'PENDING', 'the sibling registration must not be left CANCELLED')
})

test('a reversal refused between two registrations leaves NEITHER of them retired', async () => {
  const { reverseLedgerPayment } = await loadActions()
  state.syncRows = [
    syncRow({ id: 'log-a', status: 'SYNCED', externalTransactionId: 'PAY-9' }),
    syncRow({ id: 'log-b', status: 'SYNCED', externalTransactionId: 'PAY-8' }),
  ]
  state.xeroPayments = new Map([['PAY-9', 'DELETED'], ['PAY-8', 'DELETED']])
  // The second row is re-posted under a new id after Xero was asked; its compare-and-swap misses.
  state.mutateUnderLock = () => { state.syncRows[1].externalTransactionId = 'PAY-7' }
  const result = await reverseLedgerPayment('pay-1', 'order-1')
  assert.equal((result as { code?: string }).code, 'hold_moved')
  assert.ok(paymentStillThere())
  assert.equal(row('log-a').status, 'SYNCED', 'the first row must roll back with the refusal')
  assert.equal(row('log-b').status, 'SYNCED')
})

// ---------------------------------------------------------------------------
// THE LAST MILE: the refusal has to be answerable from the screen it appears on
//
// Asserted against the source rather than a rendered tree, on the same grounds as the recovery
// panel's label test in tests/refund-park-recovery-action.test.ts: what is being pinned is whether
// a control EXISTS and what it is wired to, and a DOM harness for this panel would mostly test the
// harness. The behaviour behind it is covered by the action tests above.
// ---------------------------------------------------------------------------

test('the receipt panel offers the undecided attempt somewhere to go, and refuses to submit nothing', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const panel = readFileSync(join(process.cwd(), 'app/(dashboard)/sales/[id]/so-detail-client.tsx'), 'utf8')

  // The control exists, and it is NOT the ledger-hold one: that button promises IMS checked a
  // document id, and this row has none.
  assert.match(panel, /Check that payment and delete/)
  assert.match(panel, /Payment reference from the accounting system/)
  // Nothing may be submitted without a reference — an empty box would reach the action as "no
  // reference", which is the refusal the operator is standing in front of.
  assert.match(panel, /disabled=\{isPending \|\| assertedPaymentReference\.trim\(\)\.length === 0\}/)
  // And the reference is what the server is given.
  assert.match(panel, /reverseLedgerPayment\(p\.id, so\.id, reference\)/)
  // THE FIELD SURVIVES A CORRECTABLE MISTAKE. Rendered on which receipt is being resolved, not on
  // the refusal CODE — the code changes with every answer the ledger gives ("that payment is on
  // another invoice"), and a field that disappeared on the first typo would restore the dead end.
  assert.match(panel, /\{undecidedAttempt === p\.id && \(/)
  assert.match(panel, /setUndecidedAttempt\(result\.code === 'registration_attempt_undecided' \? p\.id : null\)/)
})
