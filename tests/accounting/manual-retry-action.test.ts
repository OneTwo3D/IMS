import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { LedgerSettlementProbe } from '@/lib/domain/accounting/ledger-settlement-evidence'

/**
 * o3d-0m56 — BEHAVIOURAL coverage of the two manual retry actions.
 *
 * `manual-retry-guard.test.ts` pins the pure planner and then asserts the ACTIONS' wiring by
 * reading their source. Source assertions catch a deleted call; they cannot catch a wiring bug
 * that keeps every string in place — a sibling query that returns the wrong rows, a scope key
 * that groups two references together, an `allowedIds` computed from the wrong set. So this
 * drives both actions end to end against a database double and asserts what actually happens to
 * the rows.
 *
 * It is also the issue's own stated test contract: "two FAILED INVOICE_PAYMENT rows for one
 * order, same accountingInvoiceId; assert the per-row retry action refuses."
 *
 * THE DOUBLE IS STRICT ON PURPOSE. Every filter key the actions use is implemented, and an
 * unrecognised one THROWS rather than being ignored. A double that quietly drops a `where`
 * clause it does not understand returns too many rows and turns a broken guard green — the
 * failure mode this file exists to rule out. The same rule now covers the TRANSACTION and the
 * scope lock: the double records both, so "the reset happened outside the lock" is a visible
 * fact rather than an invisible one.
 */

type Row = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  status: string
  createdAt: Date
  payload: Record<string, unknown> | null
}

type Event = { kind: 'lock' | 'findMany' | 'updateMany'; detail: string }

const state = {
  rows: [] as Row[],
  activities: [] as Array<{ action: string; description?: string; metadata?: Record<string, unknown> }>,
  /** Every operation, in order, tagged with the transaction it happened in ('-' = no transaction). */
  events: [] as Array<Event & { tx: string }>,
  /** Probe answers by settlementProbeKey; anything unlisted answers "the ledger is empty". */
  probes: new Map<string, LedgerSettlementProbe>(),
  probeCalls: [] as string[],
}

const SELECTABLE = new Set(['id', 'type', 'referenceType', 'referenceId', 'payload', 'status', 'connector'])

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const arms = value as Array<Record<string, unknown>>
      if (!arms.some((arm) => matches(row, arm))) return false
      continue
    }
    if (key === 'id' && typeof value === 'object' && value !== null && 'in' in value) {
      if (!(value as { in: string[] }).in.includes(row.id)) return false
      continue
    }
    if (!SELECTABLE.has(key)) {
      // Never silently ignored: an unimplemented filter would widen the result set and could
      // make a broken guard look correct.
      throw new Error(`the accountingSyncLog double does not implement the filter "${key}"`)
    }
    if (typeof value !== 'string') throw new Error(`unsupported filter shape for "${key}": ${JSON.stringify(value)}`)
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false
  }
  return true
}

function syncLogClient(txLabel: string) {
  return {
    findMany: async (
      { where, select, orderBy }: {
        where: Record<string, unknown>
        select: Record<string, boolean>
        orderBy?: Record<string, string>
      },
    ) => {
      if (orderBy && (Object.keys(orderBy).length !== 1 || orderBy.createdAt !== 'asc')) {
        // The canonical-row choice depends on this order, so an order the double cannot honour
        // must fail rather than silently return insertion order.
        throw new Error(`the double only implements orderBy createdAt asc, got ${JSON.stringify(orderBy)}`)
      }
      const hit = state.rows.filter((row) => matches(row, where))
      if (orderBy) hit.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      state.events.push({ kind: 'findMany', detail: hit.map((row) => row.id).join(','), tx: txLabel })
      return hit.map((row) => Object.fromEntries(
        Object.keys(select).map((field) => [field, (row as unknown as Record<string, unknown>)[field]]),
      ))
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = state.rows.filter((row) => matches(row, where))
      for (const row of hit) if (typeof data.status === 'string') row.status = data.status
      state.events.push({ kind: 'updateMany', detail: hit.map((row) => row.id).join(','), tx: txLabel })
      return { count: hit.length }
    },
  }
}

let txCounter = 0

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'user-1' }),
    requireFreshPermission: async () => ({ id: 'user-1' }),
    requireRole: async () => ({ id: 'user-1' }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { state.activities.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: syncLogClient('-'),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const label = `tx${++txCounter}`
        return fn({
          accountingSyncLog: syncLogClient(label),
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            state.events.push({ kind: 'lock', detail: `${strings.join('?')} ${JSON.stringify(values)}`, tx: label })
            return 1
          },
        })
      },
    },
  },
})

/**
 * The probe key, restated here because `mock.module` replaces the whole module and this file
 * cannot top-level-await the real one. `settlement-probe.test.ts` pins the real function's
 * behaviour — in particular that two different documents get two different keys, which is what
 * stops one answer being reused for another invoice.
 */
const settlementProbeKey = (target: { type: string; payload: unknown }) => {
  const payload = (target.payload ?? {}) as Record<string, unknown>
  const value = (field: string) => (typeof payload[field] === 'string' ? (payload[field] as string).trim() : '')
  return [target.type, value('accountingInvoiceId'), value('creditNoteId')].join(' ')
}

mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    settlementProbeKey,
    probeLedgerSettlement: async (connector: string, target: { type: string; payload: unknown }) => {
      const key = settlementProbeKey(target)
      state.probeCalls.push(`${connector} ${key}`)
      return state.probes.get(key) ?? { ok: true, records: [] }
    },
  },
})

const payload = (accountingInvoiceId: string, extra: Record<string, unknown> = {}) =>
  ({ accountingInvoiceId, bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01', ...extra })

let clock = 0
const row = (r: Omit<Row, 'createdAt' | 'connector'> & { connector: string }): Row =>
  ({ ...r, createdAt: new Date(1_700_000_000_000 + (clock += 1000)) })

function seed(connector: string) {
  clock = 0
  state.rows = [
    // AMBIGUOUS: two failed payments for one order against the SAME invoice, neither carrying a
    // token, so each derives its own row id. Either may have committed.
    row({ id: 'a1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', status: 'FAILED', payload: payload('inv-1') }),
    row({ id: 'a2', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', status: 'FAILED', payload: payload('inv-1') }),
    // SAFE: a lone failed payment whose attempt the ledger does not hold.
    row({ id: 'b1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-2', status: 'FAILED', payload: payload('inv-2') }),
    // SAFE: not money-moving. A duplicate PDF is not a financial error — but only ONE may go
    // live at a time, because the partial unique index covers INVOICE_PDF too.
    row({ id: 'c1', connector, type: 'INVOICE_PDF', referenceType: 'SalesOrder', referenceId: 'so-3', status: 'FAILED', payload: payload('inv-3') }),
    row({ id: 'c2', connector, type: 'INVOICE_PDF', referenceType: 'SalesOrder', referenceId: 'so-3', status: 'FAILED', payload: payload('inv-3') }),
    // AMBIGUOUS via a NON-FAILED sibling: the SYNCED row demonstrably reached the ledger under a
    // different token, so re-posting the failed one lands a second payment beside it. A sibling
    // snapshot restricted to FAILED would never see this.
    row({ id: 'd1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-4', status: 'FAILED', payload: payload('inv-4') }),
    row({ id: 'd2', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-4', status: 'SYNCED', payload: payload('inv-4') }),
    // Another connector's ambiguous scope — must be invisible to this action entirely.
    row({ id: 'x1', connector: 'other', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-9', status: 'FAILED', payload: payload('inv-9') }),
    row({ id: 'x2', connector: 'other', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-9', status: 'FAILED', payload: payload('inv-9') }),
  ]
  state.activities = []
  state.events = []
  state.probes = new Map()
  state.probeCalls = []
}

const statusOf = (id: string) => state.rows.find((r) => r.id === id)?.status

/**
 * Make the two-token scope on so-1 genuinely ambiguous: the ledger holds a payment matching what
 * BOTH attempts sent, so one of them committed and nobody can say which. Set explicitly per test
 * rather than in the seed, because an ambiguous scope whose attempts are all provably ABSENT from
 * the ledger is deliberately recoverable now, and conflating the two would hide that.
 */
const ledgerHoldsTheAttemptOn = (invoiceId: string) =>
  state.probes.set(`INVOICE_PAYMENT ${invoiceId} `, {
    ok: true,
    records: [{ amount: 10, date: '2026-08-01', id: 'PAY-A' }],
  })

const ACTIONS = [
  { connector: 'xero', module: '@/app/actions/xero-sync', fn: 'retryFailedXeroSync', refusalAction: 'xero_manual_retry_refused' },
  { connector: 'quickbooks', module: '@/app/actions/quickbooks-sync', fn: 'retryFailedQuickBooksSync', refusalAction: 'quickbooks_manual_retry_refused' },
] as const

type RetryFn = (entryId?: string) => Promise<{ success: boolean; reset: number; refused?: number; error?: string }>

async function load(action: (typeof ACTIONS)[number]): Promise<RetryFn> {
  const mod = await import(action.module) as Record<string, unknown>
  return mod[action.fn] as never
}

for (const action of ACTIONS) {
  test(`${action.connector}: the per-row retry REFUSES an ambiguous scope and leaves the row FAILED (o3d-0m56)`, async () => {
    seed(action.connector)
    ledgerHoldsTheAttemptOn('inv-1')
    const retry = await load(action)

    const result = await retry('a1')

    assert.equal(result.success, false, 'the operator must be told, not silently given a no-op')
    assert.equal(result.reset, 0)
    assert.match(String(result.error), /could post a second payment/)
    assert.match(String(result.error), /SalesOrder so-1/, 'the refusal must name the reference')
    assert.equal(statusOf('a1'), 'FAILED', 'the row must NOT be re-queued')
    assert.equal(statusOf('a2'), 'FAILED', 'and neither must its sibling')

    const refusal = state.activities.filter((entry) => entry.action === action.refusalAction)
    assert.equal(refusal.length, 1, 'the refusal must be recorded exactly once')
    assert.deepEqual(refusal[0]?.metadata?.syncLogIds, ['a1'], 'only the row the operator clicked')
  })

  test(`${action.connector}: the per-row retry allows a lone failed payment the LEDGER does not hold (o3d-0m56)`, async () => {
    // The narrowness that matters: the id filter hides the siblings, so a guard that judged on
    // row count would refuse every single-row retry there is. It is allowed because the ledger
    // was ASKED and answered — not because one row looks harmless.
    seed(action.connector)
    const retry = await load(action)

    const result = await retry('b1')

    assert.equal(result.success, true)
    assert.equal(result.reset, 1)
    assert.equal(result.refused, undefined)
    assert.equal(statusOf('b1'), 'PENDING')
    assert.deepEqual(state.probeCalls, [`${action.connector} INVOICE_PAYMENT inv-2 `], 'the ledger must be asked exactly once')
  })

  test(`${action.connector}: a lone failed payment the ledger ALREADY holds is refused (o3d-0m56)`, async () => {
    // Codex finding 1, and the whole reason the settlement probe exists. One row, one token,
    // nothing ambiguous — and the attempt committed before its response was lost. Re-posting it
    // is a second payment, and the remote's idempotency window closed minutes after the failure.
    seed(action.connector)
    state.probes.set('INVOICE_PAYMENT inv-2 ', {
      ok: true,
      records: [{ amount: 10, date: '2026-08-01', id: 'PAY-1' }],
    })
    const retry = await load(action)

    const result = await retry('b1')

    assert.equal(result.success, false)
    assert.equal(result.reset, 0)
    assert.equal(result.refused, 1)
    assert.match(String(result.error), /already holds a settlement/)
    assert.match(String(result.error), /PAY-1/, 'the refusal must name the evidence')
    assert.equal(statusOf('b1'), 'FAILED', 'the row must NOT be re-queued')
  })

  test(`${action.connector}: a ledger that cannot be asked refuses the retry (o3d-0m56)`, async () => {
    // Fail closed. An unanswered question about money that may already be posted is not
    // permission to post again.
    seed(action.connector)
    state.probes.set('INVOICE_PAYMENT inv-2 ', { ok: false, reason: 'HTTP 503' })
    const retry = await load(action)

    const result = await retry('b1')

    assert.equal(result.success, false)
    assert.equal(result.reset, 0)
    assert.match(String(result.error), /could not establish/)
    assert.match(String(result.error), /HTTP 503/, 'the operator must be told WHY it could not be established')
    assert.equal(statusOf('b1'), 'FAILED')
  })

  test(`${action.connector}: a settlement for a DIFFERENT amount or date does not refuse (o3d-0m56)`, async () => {
    // The stranding direction has a cost too: an invoice part-paid by something else must not
    // permanently block the payment IMS is retrying. Only a settlement matching THIS attempt does.
    seed(action.connector)
    state.probes.set('INVOICE_PAYMENT inv-2 ', {
      ok: true,
      records: [
        { amount: 10, date: '2026-07-01', id: 'PAY-OLD' },
        { amount: 25, date: '2026-08-01', id: 'PAY-OTHER' },
      ],
    })
    const retry = await load(action)

    assert.equal((await retry('b1')).reset, 1)
    assert.equal(statusOf('b1'), 'PENDING')
  })

  test(`${action.connector}: "Retry All" re-queues the safe scopes and refuses only the unsafe ones (o3d-0m56)`, async () => {
    // The worst version of the bug: one click re-queued EVERY ambiguous scope at once, each row
    // under its own distinct token. It must now split the batch rather than passing or failing
    // it whole — AND revive at most one row per document, which is what the production unique
    // index allows (Codex finding 4).
    seed(action.connector)
    ledgerHoldsTheAttemptOn('inv-1')
    const retry = await load(action)

    const result = await retry()

    assert.equal(result.success, true)
    assert.equal(result.reset, 2, 'b1 and ONE of the two PDF rows')
    assert.equal(result.refused, 4, 'a1, a2, d1 — and the second PDF row, deferred')

    assert.equal(statusOf('a1'), 'FAILED')
    assert.equal(statusOf('a2'), 'FAILED')
    assert.equal(statusOf('d1'), 'FAILED', 'a SYNCED sibling under another token is money already posted')
    assert.equal(statusOf('b1'), 'PENDING')
    assert.equal(statusOf('c1'), 'PENDING', 'the oldest PDF row goes live')
    assert.equal(statusOf('c2'), 'FAILED', 'and the second must NOT, or the unique index rejects the write')

    assert.equal(statusOf('d2'), 'SYNCED', 'the reset must never touch a non-FAILED row')
    assert.equal(statusOf('x1'), 'FAILED', 'another connector\'s rows are out of scope entirely')

    const refusals = state.activities.filter((entry) => entry.action === action.refusalAction)
    assert.equal(refusals.length, 3, 'one warning per refused SCOPE, not one per refused row')
    assert.deepEqual(
      refusals.map((entry) => entry.metadata?.syncLogIds).sort(),
      [['a1', 'a2'], ['c2'], ['d1']].sort(),
    )
  })

  test(`${action.connector}: two same-token failed payments revive exactly ONE (o3d-0m56)`, async () => {
    // Codex finding 4, on the money path. A shared token makes the pair unambiguous — correctly
    // — but reviving both is two live rows for one invoice: PostgreSQL rejects the statement,
    // the atomic updateMany rolls back, and NOTHING in the click is reset, safe scopes included.
    seed(action.connector)
    const shared = { _followUpIdempotencyKey: 'followup:invoice-payment:so-1' }
    for (const id of ['a1', 'a2']) {
      const target = state.rows.find((r) => r.id === id)!
      target.payload = payload('inv-1', shared)
    }
    const retry = await load(action)

    const result = await retry()

    assert.equal(statusOf('a1'), 'PENDING', 'the OLDEST postable row is the one revived')
    assert.equal(statusOf('a2'), 'FAILED', 'its twin waits rather than breaking the whole batch')
    assert.equal(statusOf('b1'), 'PENDING', 'and an unrelated scope is reset in the same click')
    assert.ok(result.reset >= 2)

    const deferred = state.activities.filter((entry) => entry.action === action.refusalAction)
      .find((entry) => (entry.metadata?.syncLogIds as string[] | undefined)?.includes('a2'))
    assert.ok(deferred, 'the deferred row must be recorded, not silently skipped')
    assert.match(String(deferred?.description), /one entry for SalesOrder so-1 can be queued at a time/)
  })

  test(`${action.connector}: a LIVE sibling blocks the revival (o3d-0m56)`, async () => {
    // A PENDING sibling owns the scope's single live slot. Reviving beside it is a second live
    // attempt at the same settlement, and for an index-covered type the write is rejected outright.
    //
    // The two SHARE a token deliberately: a different one would refuse on ambiguity and prove
    // nothing about this rule.
    seed(action.connector)
    const shared = { _followUpIdempotencyKey: 'followup:invoice-payment:so-2' }
    state.rows.find((r) => r.id === 'b1')!.payload = payload('inv-2', shared)
    state.rows.push(row({
      id: 'b2', connector: action.connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder',
      referenceId: 'so-2', status: 'PENDING', payload: payload('inv-2', shared),
    }))
    const retry = await load(action)

    const result = await retry('b1')

    assert.equal(result.success, false)
    assert.equal(statusOf('b1'), 'FAILED')
    assert.match(String(result.error), /already queued or has posted/)
    assert.match(String(result.error), /b2 PENDING/, 'the refusal must name what is holding the slot')
  })

  test(`${action.connector}: the reset happens INSIDE the scope lock (o3d-0m56)`, async () => {
    // Codex finding 3. The verdict was computed from one snapshot and applied by a later,
    // unfenced statement; a row queued in between could reach FAILED unseen and both tokens post.
    // Read, plan and reset now share one transaction that holds the scope's advisory lock.
    seed(action.connector)
    const retry = await load(action)

    await retry('b1')

    const tx = state.events.find((e) => e.kind === 'updateMany')?.tx
    assert.ok(tx && tx !== '-', 'the reset must run inside a transaction')
    const inTx = state.events.filter((e) => e.tx === tx).map((e) => e.kind)
    assert.deepEqual(inTx, ['lock', 'findMany', 'updateMany'],
      'the lock must be taken BEFORE the sibling read, and the reset must follow both in the same transaction')
    const lock = state.events.find((e) => e.kind === 'lock')
    assert.match(String(lock?.detail), /pg_advisory_xact_lock/)
  })

  test(`${action.connector}: a non-money retry neither probes the ledger nor takes the lock (o3d-0m56)`, async () => {
    // The refusal has to stay narrow, and so does its cost: a duplicate PDF is not a financial
    // error, and putting an API call and a lock behind every routine retry would be a new problem.
    seed(action.connector)
    const retry = await load(action)

    const result = await retry('c1')

    assert.equal(result.reset, 1)
    assert.equal(statusOf('c1'), 'PENDING')
    assert.deepEqual(state.probeCalls, [], 'no ledger read for a PDF')
    assert.deepEqual(state.events.filter((e) => e.kind === 'lock'), [], 'and no money lock either')
  })
}

test('quickbooks: rows sharing the generic idempotency key are NOT ambiguous (o3d-0m56)', async () => {
  // QuickBooks honours `_idempotencyKey`, so two rows carrying the same one post under the same
  // Request-Id and Intuit deduplicates. Deriving the token from the row id instead — as Xero's
  // payment branches do — would refuse this safe retry. The action must apply its OWN
  // connector's derivation, not a shared one.
  seed('quickbooks')
  for (const id of ['a1', 'a2']) {
    state.rows.find((r) => r.id === id)!.payload = payload('inv-1', { _idempotencyKey: 'invoice-payment:payment:p1' })
  }
  const { retryFailedQuickBooksSync } = await import('@/app/actions/quickbooks-sync')

  const result = await retryFailedQuickBooksSync('a1')

  assert.equal(result.success, true, 'a shared token is the ordinary QuickBooks shape')
  assert.equal(statusOf('a1'), 'PENDING')

  // ...and the same payload on Xero, whose payment branches ignore the generic key, stays
  // ambiguous — two row ids, two tokens.
  seed('xero')
  for (const id of ['a1', 'a2']) {
    state.rows.find((r) => r.id === id)!.payload = payload('inv-1', { _idempotencyKey: 'invoice-payment:payment:p1' })
  }
  // ...against a ledger that DOES hold the attempt, so the two tokens are genuinely ambiguous and
  // the refusal is about the derivation rather than about an empty ledger.
  ledgerHoldsTheAttemptOn('inv-1')
  const { retryFailedXeroSync } = await import('@/app/actions/xero-sync')
  assert.equal((await retryFailedXeroSync('a1')).success, false, 'Xero never sent that key')
  assert.equal(statusOf('a1'), 'FAILED')
})

for (const action of ACTIONS) {
  test(`${action.connector}: two tokens the ledger holds NEITHER of are recoverable (o3d-0m56)`, async () => {
    // Codex round 2, medium. Before this, two failed attempts under different tokens made the
    // document permanently un-retryable even when the ledger positively showed that neither had
    // landed — and there is no per-row resolution action to escape through. Exactly one row is
    // revived; the other is deferred, not lost.
    seed(action.connector)
    const retry = await load(action)

    const result = await retry('a1')

    assert.equal(result.success, true)
    assert.equal(result.reset, 1)
    assert.equal(statusOf('a1'), 'PENDING')
    assert.equal(statusOf('a2'), 'FAILED', 'its rival waits rather than going live beside it')
    assert.deepEqual(state.probeCalls, [`${action.connector} INVOICE_PAYMENT inv-1 `],
      'one reading of the document answers for every attempt against it')
  })
}
