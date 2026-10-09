import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * o3d-llyw (owner decision C4) — THE OPERATOR LEDGER CHECK ON A REAL DATABASE.
 *
 * What only a database can show, each printed as its precondition:
 *
 *   1. END TO END: a receipt refused with UNRESOLVED_PAYMENT_ATTEMPT because a SYNCED sibling's
 *      payment is unreadable, a check recorded through the real recorder (real rows, real loader,
 *      real probe over a replaced Xero transport), and the SAME guarded registration then queuing
 *      the receipt — with the lift recorded against the order.
 *   2. INSERT-ONLY: the table refuses UPDATE and DELETE, and its CHECK constraints refuse a check of
 *      nothing (no record ids), a blank generation and any basis but OPERATOR_ASSERTION.
 *   3. A RECONNECT VOIDS A CHECK: the token row's generation is re-minted between the check and the
 *      registration, and the receipt is held again until a check is recorded under the new one.
 *   4. A CHECK RACING A LEDGER CHANGE: a settlement that appears between preview and record refuses
 *      the record (nothing inserted); one that appears after the record holds the receipt again.
 *   5. TWO CONCURRENT REGISTRATIONS, each lifted by its own check, into room for one: exactly one
 *      queues and the other is refused WOULD_OVERPAY — the lift never bypasses the capacity re-run
 *      under the order lock. Repeated over several rounds.
 *
 * NO NETWORK. `@/lib/connectors/xero/api` is replaced by a transport that answers from `ledger` below
 * and stamps each response with the tenant and connection generation it reads from the token row AT
 * CALL TIME — what the real transport does from `getAccessToken`'s single row read.
 *
 * SHARED STATE IS RESTORED. The xero plugin flag, `xero_sync_enabled`, the payment account map and the
 * xero token row are global; each is snapshotted first and put back after. Check rows cannot be deleted
 * (that is the point of them) — every id they name is unique to this run, so they are inert.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const ROUNDS = Number.parseInt(process.env.O3D_LEDGER_CHECK_ROUNDS ?? '5', 10)
const RUN_ID = `LLYW-${process.pid}-${randomUUID().slice(0, 8)}`

/** What the ledger reports for every invoice, keyed by invoice id. Mutated by the tests. */
const ledger = new Map<string, unknown[]>()
let fetches = 0

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      fetches += 1
      const { db } = await import('@/lib/db')
      const token = await db.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true, connectionGeneration: true } })
      const invoiceId = decodeURIComponent(path.replace(/^Invoices\//, ''))
      const payments = ledger.get(invoiceId) ?? []
      const paid = payments.reduce((sum: number, p) => sum + Number((p as { Amount: number }).Amount), 0)
      return {
        ok: true,
        status: 200,
        data: { Invoices: [{ InvoiceID: invoiceId, CurrencyCode: 'GBP', Total: 200, AmountPaid: paid, AmountDue: 200 - paid, Payments: payments }] },
        tenantId: token?.tenantId,
        connectionGeneration: token?.connectionGeneration ?? null,
      }
    },
  },
})

// o3d-llyw (Codex r3 on #757): the settlement and reconcile SERVER ACTIONS are driven directly in subtest 12,
// so their session gate is replaced by an admin session and `revalidatePath` (which needs a Next request
// context) by a no-op. Nothing else about either action is replaced.
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async () => ({ user: { id: `op-${process.pid}`, role: 'ADMIN', name: 'operator', email: null } }),
    requirePermission: async () => ({ user: { id: `op-${process.pid}`, role: 'ADMIN', name: 'operator', email: null } }),
    requireAuth: async () => ({ user: { id: `op-${process.pid}`, role: 'ADMIN', name: 'operator', email: null } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function deps() {
  loadEnv()
  const [{ db }, enqueue, record, probe, activity] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/accounting/invoice-payment-enqueue.ts'),
    import('../../lib/domain/accounting/operator-ledger-check-record.ts'),
    import('../../lib/connectors/accounting-settlement-probe.ts'),
    import('../../lib/activity-log.ts'),
  ])
  return { db, ...enqueue, ...record, probeLedgerSettlement: probe.probeLedgerSettlement, logActivityInTransaction: activity.logActivityInTransaction }
}
type Deps = Awaited<ReturnType<typeof deps>>

const METHOD = `LedgerCheck-${RUN_ID}`
const BANK = `BANK-${RUN_ID}`
const TENANT = `tenant-${RUN_ID}`
const SETTING_KEYS = [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'xero_sync_enabled', 'accounting_payment_account_map'] as const

type Snapshot = {
  settings: Map<string, string | null>
  token: Record<string, unknown> | null
}

async function arrange(d: Deps): Promise<Snapshot> {
  const settings = new Map<string, string | null>()
  for (const key of SETTING_KEYS) {
    const row = await d.db.setting.findUnique({ where: { key } })
    settings.set(key, row?.value ?? null)
  }
  const token = await d.db.accountingToken.findUnique({ where: { connector: 'xero' } }) as Record<string, unknown> | null
  for (const [key, value] of [
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
    ['xero_sync_enabled', 'true'],
    ['accounting_payment_account_map', JSON.stringify({ [`${METHOD}:GBP`]: BANK })],
  ] as Array<[string, string]>) {
    await d.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  await d.db.accountingAccount.upsert({
    where: { connector_externalAccountId: { connector: 'xero', externalAccountId: BANK } },
    create: { connector: 'xero', externalAccountId: BANK, code: BANK, name: 'Ledger check bank', type: 'BANK' },
    update: {},
  })
  await setGeneration(d, 'gen-1')
  return { settings, token }
}

async function restore(d: Deps, snapshot: Snapshot): Promise<void> {
  for (const [key, value] of snapshot.settings) {
    if (value === null) await d.db.setting.deleteMany({ where: { key } })
    else await d.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  await d.db.accountingAccount.deleteMany({ where: { connector: 'xero', externalAccountId: BANK } })
  await d.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  if (snapshot.token) await d.db.accountingToken.create({ data: snapshot.token as never })
}

async function setGeneration(d: Deps, generation: string): Promise<void> {
  const data = { accessToken: 'unused', expiresAt: new Date(Date.now() + 3_600_000), tenantId: TENANT, connectionGeneration: `${RUN_ID}-${generation}` }
  await d.db.accountingToken.upsert({ where: { connector: 'xero' }, create: { connector: 'xero', ...data }, update: data })
}

type Order = { orderId: string; invoiceId: string; syncedId: string | null; failedId: string; unreadableId: string }

/**
 * An order with a posted invoice (200) and a FAILED attempt of 100. The ledger reports one settlement IMS
 * cannot read. In the LIFTABLE shape it is a payment entered by hand in Xero (`PAY-H-…`); in the HEADLINE
 * shape (`withPostedSibling`) it is the own payment of a SYNCED registration of 40 on the same invoice.
 */
async function seedOrder(d: Deps, label: string, options: { withPostedSibling?: boolean; failedAttemptRevision?: number } = {}): Promise<Order> {
  const orderId = `${RUN_ID}-${label}-${randomUUID().slice(0, 6)}`
  const invoiceId = `INV-${orderId}`
  await d.db.salesOrder.create({
    data: {
      id: orderId, status: 'PROCESSING', currency: 'GBP',
      subtotalForeign: 200, totalForeign: 200, subtotalBase: 200, totalBase: 200, taxForeign: 0,
      accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero',
    },
  })
  let syncedId: string | null = null
  const unreadableId = options.withPostedSibling ? `PAY-S-${orderId}` : `PAY-H-${orderId}`
  if (options.withPostedSibling) {
    const synced = await d.db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: 'INVOICE_PAYMENT', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: orderId,
        externalTransactionId: unreadableId, remoteAttemptedAt: new Date('2026-08-02T09:00:00Z'),
        payload: { accountingInvoiceId: invoiceId, bankAccountId: BANK, amount: 40, amountDecimal: '40', currency: 'GBP', paymentDate: '2026-08-02', paymentId: `pay-s-${orderId}` },
      },
      select: { id: true },
    })
    syncedId = synced.id
  }
  const failed = await d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'INVOICE_PAYMENT', status: 'FAILED', referenceType: 'SalesOrder', referenceId: orderId,
      remoteAttemptedAt: new Date('2026-08-01T09:00:00Z'), errorMessage: 'socket hang up',
      attemptRevision: options.failedAttemptRevision ?? 0,
      payload: { accountingInvoiceId: invoiceId, bankAccountId: BANK, amount: 100, amountDecimal: '100', currency: 'GBP', paymentDate: '2026-08-01', paymentId: `pay-f-${orderId}` },
    },
    select: { id: true },
  })
  ledger.set(invoiceId, [{ PaymentID: unreadableId, Date: '2026-08-02', Amount: 40.005 }])
  return { orderId, invoiceId, syncedId, failedId: failed.id, unreadableId }
}

async function addReceipt(d: Deps, orderId: string, amount: number): Promise<string> {
  const p = await d.db.payment.create({ data: { orderId, amount, currency: 'GBP', method: METHOD, paidAt: new Date('2026-08-09T12:00:00Z') }, select: { id: true } })
  return p.id
}

async function register(d: Deps, orderId: string, paymentId: string, amount: number) {
  return d.registerInvoicePaymentWithLedger({
    orderId, orderReference: orderId, paymentId, amount: (await import('../../lib/domain/math/decimal.ts')).toDecimal(amount),
    currency: 'GBP', method: METHOD, reference: null, paidAt: new Date('2026-08-09T12:00:00Z'),
  })
}

async function queuedFor(d: Deps, orderId: string, paymentId: string): Promise<boolean> {
  const rows = await d.loadInvoicePaymentSyncRows(orderId, 'xero', 'GBP')
  return rows.some((row) => row.paymentId === paymentId && row.status === 'PENDING')
}

async function lastWarning(d: Deps, orderId: string, action: string): Promise<string | null> {
  const row = await d.db.activityLog.findFirst({ where: { entityId: orderId, action }, orderBy: { createdAt: 'desc' }, select: { description: true } })
  return row?.description ?? null
}

/** A well-formed fingerprint for hand-written rows that only exercise the table's own constraints. */
const FP = `v1:${'a'.repeat(64)}`

/** What the server action passes: the real probe, and the audit row written by the NON-swallowing logger in the check's transaction. */
const recordDeps = (d: Deps) => ({
  client: d.db,
  probe: d.probeLedgerSettlement,
  audit: async (tx: Parameters<typeof d.logActivityInTransaction>[0], rec: { orderId: string; checkId: string }) => d.logActivityInTransaction(tx, {
    entityType: 'SALES_ORDER', entityId: rec.orderId, action: 'operator_ledger_check_recorded', tag: 'accounting', level: 'WARNING',
    description: `test audit for ${rec.checkId}`, metadata: { operatorLedgerCheckId: rec.checkId }, userId: null,
  }),
})

/**
 * Record a check the way the dialog does: preview first, then submit the record ids AND everything else the
 * preview showed (connection, document, attempt description). A refused preview submits blanks, which the
 * recorder refuses before anything is compared.
 */
async function recordShown(d: Deps, input: { syncLogId: string; paymentId: string; recordIds: string[]; userId: string }) {
  const preview = await d.previewOperatorLedgerCheck(input.syncLogId, recordDeps(d))
  return d.recordOperatorLedgerCheck({
    ...input,
    expectedTenantId: preview.ok ? preview.binding.tenantId : '',
    expectedConnectionGeneration: preview.ok ? preview.binding.connectionGeneration : '',
    expectedLedgerDocumentId: preview.ok ? preview.ledgerDocumentId : '',
    expectedAttemptLabel: preview.ok ? preview.attemptLabel : '',
    expectedRecordFingerprints: preview.ok ? Object.fromEntries(preview.records.map((r) => [r.id, (r as { fingerprint?: string }).fingerprint ?? ''])) : {},
  } as never, recordDeps(d))
}

test('[o3d-llyw] operator ledger check on a real database', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const d = await deps()
  const current = await d.db.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`
  console.log(`[precondition] database: ${current[0]?.db}`)
  const snapshot = await arrange(d)
  const orders: string[] = []
  t.after(async () => {
    await d.db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: { in: orders } } })
    await d.db.activityLog.deleteMany({ where: { entityId: { in: orders } } })
    await d.db.payment.deleteMany({ where: { orderId: { in: orders } } })
    await d.db.accountingPostingRefusal.deleteMany({ where: { referenceId: { in: orders } } })
    await d.db.salesOrder.deleteMany({ where: { id: { in: orders } } })
    await restore(d, snapshot)
  })
  const userId = `user-${RUN_ID}`

  await t.test('1. end to end: refused, checked, registered — and the lift is recorded', async () => {
    const o = await seedOrder(d, 'e2e')
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)

    await register(d, o.orderId, receipt, 60)
    const refusal = await lastWarning(d, o.orderId, 'invoice_payment_not_registered')
    console.log(`[precondition] before the check: queued=${await queuedFor(d, o.orderId, receipt)}; warning=${refusal}`)
    assert.equal(await queuedFor(d, o.orderId, receipt), false, 'precondition: the receipt is held')
    assert.match(refusal ?? '', /WHAT LIFTS THIS HOLD: open payment PAY-H-/, 'and the warning names what lifts it')
    assert.ok((refusal ?? '').includes(o.failedId) && (refusal ?? '').includes(receipt), 'naming the entry and the receipt')

    const recorded = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId})
    console.log(`[precondition] recorder: ${JSON.stringify(recorded)}`)
    assert.equal(recorded.ok, true)
    const row = await d.db.accountingOperatorLedgerCheck.findUnique({ where: { id: recorded.ok ? recorded.checkId : '' } })
    assert.equal(row?.tenantId, TENANT)
    assert.equal(row?.connectionGeneration, `${RUN_ID}-gen-1`)
    assert.equal(row?.basis, 'OPERATOR_ASSERTION')
    assert.deepEqual(row?.ledgerRecordIds, [o.unreadableId])

    await register(d, o.orderId, receipt, 60)
    assert.equal(await queuedFor(d, o.orderId, receipt), true, 'the same guarded registration now queues it')
    const lifted = await lastWarning(d, o.orderId, 'invoice_payment_registered_under_ledger_check')
    console.log(`[precondition] lift record: ${lifted}`)
    assert.ok(lifted?.includes(recorded.ok ? recorded.checkId : '?'), 'and the lift names the check')
  })

  await t.test('2. the table is insert-only and refuses a malformed check', async () => {
    const o = await seedOrder(d, 'insertonly')
    orders.push(o.orderId)
    const created = await d.db.accountingOperatorLedgerCheck.create({
      data: {
        syncLogId: o.failedId, paymentId: 'p', connector: 'xero', ledgerDocumentId: o.invoiceId, ledgerRecordIds: ['R1'], ledgerRecordFingerprints: [FP],
        tenantId: TENANT, connectionGeneration: 'g', checkedByUserId: userId,
      },
    })
    console.log(`[precondition] inserted check ${created.id}`)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.update({ where: { id: created.id }, data: { ledgerRecordIds: ['R1', 'R2'] } }), /insert-only: UPDATE refused/)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.delete({ where: { id: created.id } }), /insert-only: DELETE refused/)
    await assert.rejects(d.db.$executeRaw`UPDATE accounting_operator_ledger_checks SET "connectionGeneration" = 'x' WHERE id = ${created.id}`, /insert-only/)
    const base = { syncLogId: o.failedId, paymentId: 'p', connector: 'xero', ledgerDocumentId: o.invoiceId, tenantId: TENANT, connectionGeneration: 'g', checkedByUserId: userId, ledgerRecordFingerprints: [FP] }
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: [], ledgerRecordFingerprints: [] } }), /accounting_operator_ledger_checks_records_(named|fingerprinted)/)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: [''] } }), /accounting_operator_ledger_checks_records_named/)
    // A check of a record id with no fingerprint (or a malformed one) is a check of nothing in particular.
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: ['R1', 'R2'] } }), /accounting_operator_ledger_checks_records_fingerprinted/)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: ['R1'], ledgerRecordFingerprints: ['not-a-fingerprint'] } }), /accounting_operator_ledger_checks_records_fingerprinted/)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: ['R1'], connectionGeneration: ' ' } }), /accounting_operator_ledger_checks_identity_named/)
    await assert.rejects(d.db.accountingOperatorLedgerCheck.create({ data: { ...base, ledgerRecordIds: ['R1'], basis: 'CONNECTOR' } }), /accounting_operator_ledger_checks_basis_is_assertion/)
    const still = await d.db.accountingOperatorLedgerCheck.findUnique({ where: { id: created.id } })
    assert.deepEqual(still?.ledgerRecordIds, ['R1'], 'and the original row is untouched')
  })

  await t.test('3. a reconnect (new connection generation) voids a check until one is recorded under it', async () => {
    const o = await seedOrder(d, 'gen')
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    await setGeneration(d, 'gen-1')
    const first = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId})
    assert.equal(first.ok, true, 'precondition: a check recorded under gen-1')
    await setGeneration(d, 'gen-2')
    await register(d, o.orderId, receipt, 60)
    console.log(`[precondition] after reconnect: queued=${await queuedFor(d, o.orderId, receipt)}`)
    assert.equal(await queuedFor(d, o.orderId, receipt), false, 'the gen-1 check does not apply under gen-2')
    const again = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId})
    assert.equal(again.ok && again.binding.connectionGeneration, `${RUN_ID}-gen-2`)
    await register(d, o.orderId, receipt, 60)
    assert.equal(await queuedFor(d, o.orderId, receipt), true, 'a check under the serving generation lifts it')
    await setGeneration(d, 'gen-1')
  })

  await t.test('4. a check racing a ledger change: refused at record time, or held again at registration', async () => {
    const o = await seedOrder(d, 'race')
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    const preview = await d.previewOperatorLedgerCheck(o.failedId, recordDeps(d))
    console.log(`[precondition] preview shows: ${preview.ok ? preview.records.map((r) => r.id).join(',') : preview.error}`)
    assert.equal(preview.ok, true)
    // A second unreadable settlement lands between the preview and the record.
    const second = { PaymentID: `PAY-X-${o.orderId}`, Date: '2026-08-05', Amount: 7.0001 }
    ledger.set(o.invoiceId, [...(ledger.get(o.invoiceId) ?? []), second])
    const before = await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } })
    const stale = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: preview.ok ? preview.records.map((r) => r.id) : [], userId})
    assert.equal(stale.ok, false)
    assert.equal(!stale.ok && stale.code, 'LEDGER_CHANGED')
    assert.equal(await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } }), before, 'and nothing was inserted')

    // Now record against both, then a THIRD lands before the registration runs.
    const both = await recordShown(d, { syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId, `PAY-X-${o.orderId}`], userId })
    assert.equal(both.ok, true, 'precondition: a check covering the two current records')
    ledger.set(o.invoiceId, [...(ledger.get(o.invoiceId) ?? []), { PaymentID: `PAY-Y-${o.orderId}`, Date: '2026-08-06', Amount: 1.0001 }])
    await register(d, o.orderId, receipt, 60)
    assert.equal(await queuedFor(d, o.orderId, receipt), false, 'a record that appeared after the check holds the receipt again')
    assert.match(await lastWarning(d, o.orderId, 'invoice_payment_not_registered') ?? '', new RegExp(`PAY-Y-${o.orderId}`))
  })

  await t.test(`5. two concurrent registrations into room for one: exactly one queues (${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const o = await seedOrder(d, `pair${round}`)
      orders.push(o.orderId)
      // Invoice 200; F is lifted, so nothing IMS registered is counted. Two receipts of 120: only one fits.
      const a = await addReceipt(d, o.orderId, 120)
      const b = await addReceipt(d, o.orderId, 120)
      for (const receipt of [a, b]) {
        const r = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId})
        assert.equal(r.ok, true, 'precondition: each receipt has its own valid check')
      }
      await Promise.all([register(d, o.orderId, a, 120), register(d, o.orderId, b, 120)])
      const queued = [await queuedFor(d, o.orderId, a), await queuedFor(d, o.orderId, b)]
      const overpay = await d.db.activityLog.count({ where: { entityId: o.orderId, action: 'invoice_payment_not_registered', description: { contains: 'would refuse a larger payment' } } })
      console.log(`[precondition] round ${round}: queued=${JSON.stringify(queued)} overpayRefusals=${overpay}`)
      assert.equal(queued.filter(Boolean).length, 1, 'exactly one of the two lifted receipts is queued')
      assert.equal(overpay, 1, 'and the other is refused for CAPACITY, not for the hold — so both lifts were in force')
    }
  })

  await t.test('6. the recorder refuses a SYNCED row and a receipt from another order', async () => {
    const o = await seedOrder(d, 'refuse', { withPostedSibling: true })
    orders.push(o.orderId)
    const other = await seedOrder(d, 'refuse-other')
    orders.push(other.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    const foreign = await addReceipt(d, other.orderId, 60)
    const synced = await recordShown(d, {syncLogId: o.syncedId ?? '', paymentId: receipt, recordIds: [o.unreadableId], userId})
    console.log(`[precondition] SYNCED row: ${JSON.stringify(synced)}`)
    assert.equal(!synced.ok && synced.code, 'NOT_UNRESOLVED', 'a SYNCED row\'s unreadable payment is its OWN: no check may be recorded against it')
    const wrongOrder = await recordShown(d, {syncLogId: other.failedId, paymentId: receipt, recordIds: [other.unreadableId], userId})
    assert.equal(!wrongOrder.ok && wrongOrder.code, 'RECEIPT_INVALID')
    void foreign
    assert.ok(fetches > 0, `the probe was really asked (${fetches} fetches this run)`)
  })

  await t.test('7. the HEADLINE shape (the unreadable payment is a SYNCED sibling\'s own) is refused with the reason, at the recorder and at registration', async () => {
    const o = await seedOrder(d, 'headline', { withPostedSibling: true })
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    await register(d, o.orderId, receipt, 60)
    assert.equal(await queuedFor(d, o.orderId, receipt), false, 'precondition: the receipt is held')
    const refused = await recordShown(d, {syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId})
    console.log(`[precondition] recorder on the headline shape: ${JSON.stringify(refused)}`)
    assert.equal(!refused.ok && refused.code, 'NOT_LIFTABLE')
    assert.match(!refused.ok ? refused.error : '', new RegExp(`entry ${o.syncedId} already posted a payment against this invoice`))
    // Even a check row written by hand (psql) does not get the receipt queued: the decision refuses the lift.
    await d.db.accountingOperatorLedgerCheck.create({
      data: {
        syncLogId: o.failedId, paymentId: receipt, connector: 'xero', ledgerDocumentId: o.invoiceId, ledgerRecordIds: [o.unreadableId],
        ledgerRecordFingerprints: [(await import('../../lib/domain/accounting/operator-ledger-check.ts')).settlementRecordFingerprint({ id: o.unreadableId, amount: null, unreadableAmount: '40.005', date: '2026-08-02', reference: null })],
        tenantId: TENANT, connectionGeneration: `${RUN_ID}-gen-1`, checkedByUserId: userId,
      },
    })
    await register(d, o.orderId, receipt, 60)
    assert.equal(await queuedFor(d, o.orderId, receipt), false)
    assert.match(await lastWarning(d, o.orderId, 'invoice_payment_not_registered') ?? '', /cannot get this receipt sent/)
  })

  await t.test('8. the operator confirmed under ONE connection: a reconnect (or any other change to what was shown) between preview and submit refuses, even with identical record ids', async () => {
    const o = await seedOrder(d, 'confirmed')
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    await setGeneration(d, 'gen-1')
    const preview = await d.previewOperatorLedgerCheck(o.failedId, recordDeps(d))
    assert.equal(preview.ok, true, 'precondition: a preview under gen-1')
    if (!preview.ok) return
    const shown = {
      expectedRecordFingerprints: Object.fromEntries(preview.records.map((r) => [r.id, (r as { fingerprint?: string }).fingerprint ?? ''])),
      expectedTenantId: preview.binding.tenantId,
      expectedConnectionGeneration: preview.binding.connectionGeneration,
      expectedLedgerDocumentId: preview.ledgerDocumentId,
      expectedAttemptLabel: preview.attemptLabel,
    }
    console.log(`[precondition] preview binding ${JSON.stringify(preview.binding)} records ${preview.records.map((r) => r.id).join(',')}`)
    const before = await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } })
    // Xero is reconnected between the preview and the submit. The ledger still shows the SAME record ids.
    await setGeneration(d, 'gen-2')
    const input = { syncLogId: o.failedId, paymentId: receipt, recordIds: preview.records.map((r) => r.id), userId }
    const reconnected = await d.recordOperatorLedgerCheck({ ...input, ...shown } as never, recordDeps(d))
    console.log(`[precondition] submit after reconnect: ${JSON.stringify(reconnected)}`)
    assert.equal(reconnected.ok, false, 'the operator never confirmed anything under gen-2')
    assert.equal(!reconnected.ok && reconnected.code, 'LEDGER_CHANGED')
    assert.equal(await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } }), before, 'nothing was inserted')
    // Every other field the confirmation text implies is bound the same way.
    await setGeneration(d, 'gen-1')
    for (const [label, tamper] of [
      ['tenant', { expectedTenantId: 'tenant-other' }],
      ['document', { expectedLedgerDocumentId: 'INV-other' }],
      ['attempt description', { expectedAttemptLabel: 'the FAILED attempt x (GBP 1.00)' }],
      ['nothing echoed', { expectedTenantId: undefined, expectedConnectionGeneration: undefined, expectedLedgerDocumentId: undefined, expectedAttemptLabel: undefined, expectedRecordFingerprints: undefined }],
    ] as const) {
      const r = await d.recordOperatorLedgerCheck({ ...input, ...shown, ...tamper } as never, recordDeps(d))
      assert.equal(!r.ok && r.code, 'LEDGER_CHANGED', `${label} differing from what was shown refuses`)
    }
    assert.equal(await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } }), before, 'still nothing inserted')
    const same = await d.recordOperatorLedgerCheck({ ...input, ...shown } as never, recordDeps(d))
    assert.equal(same.ok, true, 'and the unchanged submission under the connection it was shown is accepted')
  })

  await t.test('9. TRUNCATE cannot erase the checks', async () => {
    const o = await seedOrder(d, 'truncate')
    orders.push(o.orderId)
    await d.db.accountingOperatorLedgerCheck.create({
      data: { syncLogId: o.failedId, paymentId: 'p', connector: 'xero', ledgerDocumentId: o.invoiceId, ledgerRecordIds: ['R1'], ledgerRecordFingerprints: [FP], tenantId: TENANT, connectionGeneration: 'g', checkedByUserId: userId },
    })
    const before = await d.db.accountingOperatorLedgerCheck.count()
    console.log(`[precondition] ${before} check rows before TRUNCATE`)
    assert.ok(before > 0)
    await assert.rejects(d.db.$executeRawUnsafe('TRUNCATE accounting_operator_ledger_checks'), /insert-only: TRUNCATE refused/)
    assert.equal(await d.db.accountingOperatorLedgerCheck.count(), before, 'every row survives')
  })

  await t.test('10. a settlement EDITED IN PLACE under the same id: refused between preview and submit, and a stored check no longer applies at registration, at the post fence or at revival', async () => {
    const { authoriseMoneyPost, ledgerClearsFollowUpRevival } = await import('../../lib/connectors/accounting-settlement-probe.ts')
    const { loadOperatorLedgerChecks } = await import('../../lib/domain/accounting/operator-ledger-check-store.ts')
    const loader = (scope: { attemptSyncLogId: string; paymentId: string | null; connector: string }) =>
      loadOperatorLedgerChecks(d.db, { syncLogIds: [scope.attemptSyncLogId], paymentId: scope.paymentId, connector: scope.connector })
    const edit = (o: Order, amount: number) => ledger.set(o.invoiceId, [{ PaymentID: o.unreadableId, Date: '2026-08-02', Amount: amount }])

    // (a) between preview and submit
    const a = await seedOrder(d, 'edit-submit')
    orders.push(a.orderId)
    const ra = await addReceipt(d, a.orderId, 60)
    const preview = await d.previewOperatorLedgerCheck(a.failedId, recordDeps(d))
    assert.equal(preview.ok, true, 'precondition: a preview')
    if (!preview.ok) return
    edit(a, 41.005)
    const submitted = await d.recordOperatorLedgerCheck({
      syncLogId: a.failedId, paymentId: ra, recordIds: preview.records.map((r) => r.id), userId,
      expectedTenantId: preview.binding.tenantId, expectedConnectionGeneration: preview.binding.connectionGeneration,
      expectedLedgerDocumentId: preview.ledgerDocumentId, expectedAttemptLabel: preview.attemptLabel,
      expectedRecordFingerprints: Object.fromEntries(preview.records.map((r) => [r.id, (r as { fingerprint?: string }).fingerprint ?? ''])),
    } as never, recordDeps(d))
    console.log(`[precondition] submit after an in-place edit (same id): ${JSON.stringify(submitted).slice(0, 160)}`)
    assert.equal(!submitted.ok && submitted.code, 'LEDGER_CHANGED')
    assert.equal(await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: a.failedId } }), 0, 'nothing inserted')

    // (b) registration: check recorded on the confirmed state, then the payment is edited in place
    const b = await seedOrder(d, 'edit-register')
    orders.push(b.orderId)
    const rb = await addReceipt(d, b.orderId, 60)
    assert.equal((await recordShown(d, { syncLogId: b.failedId, paymentId: rb, recordIds: [b.unreadableId], userId })).ok, true, 'precondition: check recorded')
    edit(b, 41.005)
    await register(d, b.orderId, rb, 60)
    console.log(`[precondition] registration after edit: queued=${await queuedFor(d, b.orderId, rb)}`)
    assert.equal(await queuedFor(d, b.orderId, rb), false, 'registration: the edited payment is not covered')
    edit(b, 40.005)
    await register(d, b.orderId, rb, 60)
    assert.equal(await queuedFor(d, b.orderId, rb), true, 'and with the payment back as confirmed, the check still lifts')

    // (c) the post fence, on the real database, one fresh order per verdict (the first call claims the stamp)
    const fenceOn = async (label: string, amount: number) => {
      const o = await seedOrder(d, label)
      orders.push(o.orderId)
      const r = await addReceipt(d, o.orderId, 60)
      assert.equal((await recordShown(d, { syncLogId: o.failedId, paymentId: r, recordIds: [o.unreadableId], userId })).ok, true)
      await register(d, o.orderId, r, 60)
      const rows = await d.loadInvoicePaymentSyncRows(o.orderId, 'xero', 'GBP')
      const n = rows.find((row) => row.paymentId === r && row.status === 'PENDING')
      assert.ok(n, `precondition (${label}): the receipt was queued`)
      const nRow = await d.db.accountingSyncLog.findUnique({ where: { id: n!.id }, select: { payload: true } })
      edit(o, amount)
      return authoriseMoneyPost({
        connector: 'xero', entryId: n!.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: o.orderId,
        payload: nRow!.payload, postingDate: '2026-08-09', db: d.db as never, loadOperatorLedgerChecks: loader as never,
      })
    }
    const fenceUnchanged = await fenceOn('fence-same', 40.005)
    const fenceEdited = await fenceOn('fence-edit', 41.005)
    console.log(`[precondition] fence unchanged=${JSON.stringify(fenceUnchanged)} edited=${fenceEdited.proceed}`)
    assert.deepEqual(fenceUnchanged, { proceed: true }, 'fence: the record as confirmed is lifted')
    assert.equal(fenceEdited.proceed, false, 'fence: the edited record is not covered')

    // (d) revival of F itself, with a check recorded for F's own receipt
    const c = await seedOrder(d, 'edit-revival')
    orders.push(c.orderId)
    const fRow = await d.db.accountingSyncLog.findUnique({ where: { id: c.failedId }, select: { payload: true } })
    await d.db.payment.create({ data: { id: `pay-f-${c.orderId}`, orderId: c.orderId, amount: 100, currency: 'GBP', method: METHOD, paidAt: new Date('2026-08-01T12:00:00Z') } })
    assert.equal((await recordShown(d, { syncLogId: c.failedId, paymentId: `pay-f-${c.orderId}`, recordIds: [c.unreadableId], userId })).ok, true)
    const revive = () => ledgerClearsFollowUpRevival({ connector: 'xero', type: 'INVOICE_PAYMENT', payload: fRow!.payload, tokenDisposition: 'pinned', syncLogId: c.failedId, loadOperatorLedgerChecks: loader as never })
    const same = await revive()
    edit(c, 41.005)
    const changed = await revive()
    console.log(`[precondition] revival unchanged=${same.clear} edited=${changed.clear}`)
    assert.equal(same.clear, true, 'revival: the record as confirmed is lifted')
    assert.equal(changed.clear, false, 'revival: the edited record is not covered')
  })

  await t.test('11. the check and its audit row commit together: a failing audit records nothing', async () => {
    const o = await seedOrder(d, 'audit')
    orders.push(o.orderId)
    const receipt = await addReceipt(d, o.orderId, 60)
    const preview = await d.previewOperatorLedgerCheck(o.failedId, recordDeps(d))
    assert.equal(preview.ok, true)
    if (!preview.ok) return
    const input = {
      syncLogId: o.failedId, paymentId: receipt, recordIds: preview.records.map((r) => r.id), userId,
      expectedTenantId: preview.binding.tenantId, expectedConnectionGeneration: preview.binding.connectionGeneration,
      expectedLedgerDocumentId: preview.ledgerDocumentId, expectedAttemptLabel: preview.attemptLabel,
      expectedRecordFingerprints: Object.fromEntries(preview.records.map((r) => [r.id, r.fingerprint])),
    }
    const failing = await d.recordOperatorLedgerCheck(input, {
      ...recordDeps(d),
      // The audit insert fails INSIDE the transaction, as a real write failure would.
      audit: async (tx) => { await tx.activityLog.create({ data: { entityType: 'SALES_ORDER', action: 'x'.repeat(1), tag: 'accounting', level: 'NOT_A_LEVEL' as never, description: 'boom' } }) },
    })
    console.log(`[precondition] record with a failing audit: ${JSON.stringify(failing).slice(0, 200)}`)
    assert.equal(!failing.ok && failing.code, 'NOT_RECORDED')
    assert.equal(await d.db.accountingOperatorLedgerCheck.count({ where: { syncLogId: o.failedId } }), 0, 'no check without its audit')
    const ok = await d.recordOperatorLedgerCheck(input, recordDeps(d))
    assert.equal(ok.ok, true, 'and with a working audit it records')
    const audit = await d.db.activityLog.count({ where: { entityId: o.orderId, action: 'operator_ledger_check_recorded' } })
    assert.equal(audit, 1, 'exactly one audit row, committed with the check')
  })

  await t.test('12. a writer that marks the checked attempt posted cannot commit between the fence reading the check and the POST (3 rounds each)', async () => {
    const { postMoneyUnderLedgerFence } = await import('../../lib/connectors/accounting-settlement-probe.ts')
    const { loadOperatorLedgerChecks } = await import('../../lib/domain/accounting/operator-ledger-check-store.ts')
    const { settleAccountingSyncRow } = await import('../../app/actions/accounting-settlement.ts')
    const { reconcileSettledAccountingSyncRow } = await import('../../app/actions/accounting-sync.ts')
    const { settlementMarkerFor } = await import('../../lib/domain/accounting/ledger-settlement-evidence.ts')
    const { effectiveTokenFor } = await import('../../lib/domain/accounting/followup-retry-guard.ts')

    // The actions write audit rows naming the session user, which must exist. A deactivated user with an
    // unusable hash, unique to this run, DELETED again at the end (audit rows are SET NULL): a scratch
    // database holding user rows is refused by the scratch-database guard on the next run.
    t.after(async () => { await d.db.user.deleteMany({ where: { id: `op-${process.pid}` } }) })
    await d.db.user.upsert({
      where: { id: `op-${process.pid}` },
      create: { id: `op-${process.pid}`, email: `op-${process.pid}-${RUN_ID}@ledger-check.invalid`, name: 'ledger check test operator', passwordHash: '!', active: false },
      update: {},
    })
    for (const writer of ['settle POSTED', 'reconcile'] as const) {
      for (let round = 0; round < 3; round++) {
        const o = await seedOrder(d, `interleave-${writer === 'reconcile' ? 'rec' : 'set'}-${round}`, { failedAttemptRevision: 1 })
        orders.push(o.orderId)
        const receipt = await addReceipt(d, o.orderId, 60)
        assert.equal((await recordShown(d, { syncLogId: o.failedId, paymentId: receipt, recordIds: [o.unreadableId], userId })).ok, true)
        await register(d, o.orderId, receipt, 60)
        const rows = await d.loadInvoicePaymentSyncRows(o.orderId, 'xero', 'GBP')
        const n = rows.find((row) => row.paymentId === receipt && row.status === 'PENDING')
        assert.ok(n, 'precondition: the receipt is queued')
        const nRow = await d.db.accountingSyncLog.findUnique({ where: { id: n!.id }, select: { payload: true } })
        const fRow = await d.db.accountingSyncLog.findUnique({ where: { id: o.failedId }, select: { payload: true } })

        let writerOutcome: unknown = 'not run'
        let checksSeen = -1
        // THE INTERLEAVING: the writer runs at the exact point the fence has READ F's checks and has not
        // yet POSTed — inside the fence's lock scope, which is the window the finding names.
        const loader = async (scope: { attemptSyncLogId: string; paymentId: string | null; connector: string }) => {
          const checks = await loadOperatorLedgerChecks(d.db, { syncLogIds: [scope.attemptSyncLogId], paymentId: scope.paymentId, connector: scope.connector })
          if (scope.attemptSyncLogId === o.failedId && writerOutcome === 'not run') {
            checksSeen = checks.length
            if (writer === 'settle POSTED') {
              writerOutcome = await settleAccountingSyncRow(o.failedId, {
                observedStatus: 'FAILED', observedAttemptRevision: 1, outcome: 'POSTED', externalTransactionId: o.unreadableId,
              })
            } else {
              // The ledger now shows a readable payment carrying F's own mark, which the reconcile can match.
              const mark = settlementMarkerFor(effectiveTokenFor('xero', { id: o.failedId, payload: fRow!.payload }))
              ledger.set(o.invoiceId, [...(ledger.get(o.invoiceId) ?? []), { PaymentID: `PAY-F-${o.orderId}`, Date: '2026-08-01', Amount: 100, Reference: mark }])
              writerOutcome = await reconcileSettledAccountingSyncRow(o.failedId)
            }
          }
          return checks
        }
        let posted = false
        const outcome = await postMoneyUnderLedgerFence({
          connector: 'xero', entryId: n!.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: o.orderId,
          payload: nRow!.payload, postingDate: '2026-08-09', db: d.db as never, loadOperatorLedgerChecks: loader as never,
        }, async () => { posted = true; return { success: true, externalId: `PAY-N-${o.orderId}` } })
        const f = await d.db.accountingSyncLog.findUnique({ where: { id: o.failedId }, select: { status: true, externalTransactionId: true } })
        console.log(`[precondition] ${writer} round ${round}: checksSeen=${checksSeen} writer=${JSON.stringify(writerOutcome).slice(0, 140)} fence=${JSON.stringify(outcome)} posted=${posted} F=${JSON.stringify(f)}`)
        assert.equal(checksSeen, 1, 'precondition: the fence read the check for F inside its lock')
        assert.deepEqual(f, { status: 'FAILED', externalTransactionId: null },
          `${writer}: F did not change inside the window — the writer could not commit while the send held the document`)
        assert.match(JSON.stringify(writerOutcome), /being checked and sent to the accounting system right now/, `${writer} was refused with the in-flight reason`)
        assert.equal(posted, true, 'and the post the check authorised went out on a standing nothing contradicted')
      }
    }
  })
})
