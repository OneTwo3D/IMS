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

type PaymentRow = { id: string; orderId: string; refundId: string | null; amount: number; currency: string }

const state = {
  permissions: new Set<string>(['sales.refund']),
  freshAuthFails: false,
  order: { id: 'order-1', orderNumber: 'SO-1001', externalOrderNumber: null as string | null, currency: 'GBP', totalForeign: 100, status: 'SHIPPED', paidAt: null as Date | null },
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
  xeroError: null as string | null,
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
      if (state.xeroError) return { ok: false, status: 0, error: state.xeroError }
      const id = decodeURIComponent(path.replace('Payments/', ''))
      const status = state.xeroPayments.get(id)
      if (!status) return { ok: false, status: 404, error: 'not found' }
      return { ok: true, status: 200, data: { Payments: [{ PaymentID: id, Status: status }] } }
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
  state.order = { id: 'order-1', orderNumber: 'SO-1001', externalOrderNumber: null, currency: 'GBP', totalForeign: 100, status: 'SHIPPED', paidAt: new Date('2026-08-01T00:00:00.000Z') }
  state.payments = [{ id: 'pay-1', orderId: 'order-1', refundId: null, amount: 100, currency: 'GBP' }]
  state.syncRows = [syncRow()]
  state.activity = []
  state.registrationQueries = []
  state.xeroPayments = new Map([['PAY-9', 'AUTHORISED']])
  state.xeroError = null
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
