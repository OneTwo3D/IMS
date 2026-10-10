import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-llyw (owner decision C4) — THE OPERATOR LEDGER CHECK AT THE TWO OTHER GATES THE SAME HOLD SITS AT.
 *
 * The plan for this package named the registration decision and `ledgerClearsFollowUpRevival`. Reading
 * the code showed a THIRD gate the hold also sits at, and the one that matters most: `authoriseMoneyPost`,
 * which judges every previously-attempted contender on the document against a fresh probe immediately
 * before the money moves. A receipt the decision let through on a check would be refused there for the
 * same unmeasurable record — so the fence honours the check too, under the same rule, and these tests pin
 * that it does so ONLY under that rule.
 *
 * The probe is real (`probeLedgerSettlement` -> `probeXeroSettlement`); only the Xero transport is
 * replaced, and it answers with the tenant id AND connection generation a real response carries.
 */

type XeroAnswer = { data: unknown; tenantId?: string | null; connectionGeneration?: string | null }
let xeroAnswer: XeroAnswer
const xeroCalls: string[] = []

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (p: string) => {
      xeroCalls.push(p)
      return { ok: true, status: 200, data: xeroAnswer.data, tenantId: xeroAnswer.tenantId ?? undefined, connectionGeneration: xeroAnswer.connectionGeneration }
    },
  },
})

const probeModule = async () => import('@/lib/connectors/accounting-settlement-probe')

const F_PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 100, currency: 'GBP', paymentDate: '2026-08-01', paymentId: 'pay-f' }
const N_PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 60, currency: 'GBP', paymentDate: '2026-08-09', paymentId: 'pay-new' }
const S_PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 40, currency: 'GBP', paymentDate: '2026-08-02', paymentId: 'pay-s' }

/** A hand-entered payment whose figure IMS will not read (three decimals on a GBP amount). */
const UNREADABLE_HAND_PAYMENT = { PaymentID: 'PAY-H', Date: '2026-08-02', Amount: 40.005 }

function invoice(payments: unknown[]) {
  return { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 60, AmountPaid: 40, Payments: payments }] }
}

const BOUND = { tenantId: 'tenant-A', connectionGeneration: 'gen-1' }

/** What the probe reads off `UNREADABLE_HAND_PAYMENT` — the state the operator confirmed. */
const H_AS_SHOWN = { id: 'PAY-H', amount: null, unreadableAmount: '40.005', date: '2026-08-02', reference: null }
const S_AS_SHOWN = { id: 'PAY-S', amount: null, unreadableAmount: '40.005', date: '2026-08-02', reference: null }
let fp: (record: typeof H_AS_SHOWN) => string

const CHECK = {
  id: 'chk-1', syncLogId: 'log-f', paymentId: 'pay-new', connector: 'xero', ledgerDocumentId: 'INV-1',
  ledgerRecordIds: ['PAY-H'], tenantId: 'tenant-A', connectionGeneration: 'gen-1',
  get ledgerRecordFingerprints() { return [fp(H_AS_SHOWN)] },
}

test.before(async () => {
  fp = (await import('@/lib/domain/accounting/operator-ledger-check')).settlementRecordFingerprint
})

type Row = { id: string; remoteAttemptedAt: Date | null; payload: unknown }
function fenceDb(rows: Row[]) {
  return {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => {
        const row = rows.find((r) => r.id === where.id && r.remoteAttemptedAt === null)
        if (!row) return { count: 0 }
        row.remoteAttemptedAt = data.remoteAttemptedAt
        return { count: 1 }
      },
      findMany: async ({ where }: { where: { id: { not: string } } }) =>
        rows.filter((r) => r.remoteAttemptedAt !== null && r.id !== where.id.not).map((r) => ({ id: r.id, payload: r.payload })),
    },
  }
}

async function postN(options: { rows?: Row[]; loader?: ((scope: unknown) => Promise<unknown[]>) | null } = {}) {
  const { authoriseMoneyPost } = await probeModule()
  const rows = options.rows ?? [
    { id: 'log-n', remoteAttemptedAt: null, payload: N_PAYLOAD },
    { id: 'log-f', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'), payload: F_PAYLOAD },
  ]
  return authoriseMoneyPost({
    connector: 'xero', entryId: 'log-n', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1',
    payload: N_PAYLOAD, postingDate: '2026-08-09', db: fenceDb(rows) as never,
    ...(options.loader ? { loadOperatorLedgerChecks: options.loader as never } : {}),
  })
}

function precondition(label: string, verdict: { proceed: boolean; error?: string }) {
  console.log(`[precondition] ${label}: ${verdict.proceed ? 'PROCEED' : `REFUSED — ${verdict.error}`}`)
}

test('[o3d-llyw] fence precondition: a FAILED contender cannot be ruled out against an unreadable payment, and the error says what lifts it', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const verdict = await postN()
  precondition('no checks', verdict)
  assert.equal(verdict.proceed, false)
  const error = verdict.proceed ? '' : verdict.error
  assert.match(error, /log-f/)
  assert.match(error, /WHAT LIFTS THIS HOLD: open payment PAY-H on document INV-1/)
  assert.match(error, /for receipt pay-new/)
  assert.match(error, /next automatic attempt reads the check; Retry on the Sync Dashboard does not read ledger checks yet/,
    'and it says truthfully what happens after a check at THIS gate')
  assert.doesNotMatch(error, /registers this receipt again/)
})

test('[o3d-llyw] fence: a check for that contender and THIS receipt, under the serving connection, lets the post proceed', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const scopes: unknown[] = []
  const verdict = await postN({ loader: async (scope) => { scopes.push(scope); return [CHECK] } })
  precondition('check in scope', verdict)
  assert.deepEqual(verdict, { proceed: true, requireConnection: BOUND })
  assert.deepEqual(scopes, [{ attemptSyncLogId: 'log-f', paymentId: 'pay-new', connector: 'xero', ledgerDocumentId: 'INV-1' }],
    'the loader is asked about exactly that contender and the receipt being posted')
})

test('[o3d-llyw] fence: with no loader wired, the hold stands (a forgotten call site withholds)', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const verdict = await postN({ loader: null })
  precondition('no loader', verdict)
  assert.equal(verdict.proceed, false)
})

test('[o3d-llyw] fence: a loader that FAILS is read as no checks', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const verdict = await postN({ loader: async () => { throw new Error('db down') } })
  precondition('loader throws', verdict)
  assert.equal(verdict.proceed, false)
})

test('[o3d-llyw] fence: a reconnect (new generation) or a response that cannot name its generation voids the check', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), tenantId: 'tenant-A', connectionGeneration: 'gen-2' }
  const reconnected = await postN({ loader: async () => [CHECK] })
  precondition('generation re-minted', reconnected)
  assert.equal(reconnected.proceed, false)
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), tenantId: 'tenant-A', connectionGeneration: null }
  const legacy = await postN({ loader: async () => [CHECK] })
  precondition('no generation on the response', legacy)
  assert.equal(legacy.proceed, false)
  assert.match(legacy.proceed ? '' : legacy.error, /could not establish which Xero connection/)
})

test('[o3d-llyw] fence: a check for ANOTHER receipt does not let this one through', async () => {
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const verdict = await postN({ loader: async () => [{ ...CHECK, paymentId: 'pay-other' }] })
  precondition('check for another receipt', verdict)
  assert.equal(verdict.proceed, false)
})

test('[o3d-llyw] fence: a SYNCED rival whose payment IMS can match still refuses — a check on another contender does not widen anything', async () => {
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const { effectiveTokenFor } = await import('@/lib/domain/accounting/followup-retry-guard')
  const sMarker = settlementMarkerFor(effectiveTokenFor('xero', { id: 'log-s', payload: S_PAYLOAD }))
  xeroAnswer = {
    data: { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 20, AmountPaid: 80,
      Payments: [UNREADABLE_HAND_PAYMENT, { PaymentID: 'PAY-S', Date: '2026-08-02', Amount: 40, Reference: sMarker }] }] },
    ...BOUND,
  }
  const verdict = await postN({
    rows: [
      { id: 'log-n', remoteAttemptedAt: null, payload: N_PAYLOAD },
      { id: 'log-f', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'), payload: F_PAYLOAD },
      { id: 'log-s', remoteAttemptedAt: new Date('2026-08-02T10:00:00Z'), payload: S_PAYLOAD },
    ],
    loader: async () => [CHECK],
  })
  precondition('SYNCED rival present + check on F', verdict)
  assert.equal(verdict.proceed, false)
  assert.match(verdict.proceed ? '' : verdict.error, /PAY-S/)
})

test('[o3d-llyw] revival: the revived row\'s own check (for its own receipt) clears it; a check for another receipt does not', async () => {
  const { ledgerClearsFollowUpRevival } = await probeModule()
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const base = { connector: 'xero' as const, type: 'INVOICE_PAYMENT', payload: F_PAYLOAD, tokenDisposition: 'pinned' as const, syncLogId: 'log-f' }
  const held = await ledgerClearsFollowUpRevival(base)
  console.log(`[precondition] revival without checks: ${JSON.stringify(held)}`)
  assert.equal(held.clear, false)
  assert.match(held.clear ? '' : held.reason, /WHAT LIFTS THIS HOLD: open payment PAY-H/)
  assert.match(held.clear ? '' : held.reason, /for receipt pay-f/, 'a revival re-posts the row\'s OWN receipt, so that is the receipt a check must name')
  assert.match(held.clear ? '' : held.reason, /next automatic enqueue of this entry reads the check/)

  const own = { ...CHECK, paymentId: 'pay-f' }
  const lifted = await ledgerClearsFollowUpRevival({ ...base, loadOperatorLedgerChecks: async () => [own] })
  console.log(`[precondition] revival with its own check: ${JSON.stringify(lifted)}`)
  assert.deepEqual(lifted, { clear: true, liftedByCheckIds: ['chk-1'] })

  const other = await ledgerClearsFollowUpRevival({ ...base, loadOperatorLedgerChecks: async () => [CHECK] })
  assert.equal(other.clear, false, 'a check for pay-new says nothing about re-posting pay-f')
})

test('[o3d-llyw] probe: answeredBy is the connection named by the responses, and only when they name one', async () => {
  const { probeLedgerSettlement } = await probeModule()
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const bound = await probeLedgerSettlement('xero', { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'INV-1' } })
  assert.equal(bound.ok, true)
  assert.deepEqual(bound.ok && bound.answeredBy, BOUND)
  for (const identity of [{ tenantId: 'tenant-A', connectionGeneration: null }, { tenantId: null, connectionGeneration: 'gen-1' }]) {
    xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...identity }
    const unbound = await probeLedgerSettlement('xero', { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'INV-1' } })
    assert.equal(unbound.ok && unbound.answeredBy, null, `${JSON.stringify(identity)} cannot bind`)
  }
})

test('[o3d-llyw] binding: every response must name the SAME tenant and generation', async () => {
  const { bindProbeToConnection } = await import('@/lib/domain/accounting/operator-ledger-check')
  assert.deepEqual(bindProbeToConnection([BOUND, BOUND]), BOUND)
  assert.equal(bindProbeToConnection([]), null, 'no fetch, no binding')
  assert.equal(bindProbeToConnection([BOUND, { tenantId: 'tenant-B', connectionGeneration: 'gen-1' }]), null, 'tenant differs')
  // A -> B -> A between two fetches: the tenant agrees, the generation does not.
  assert.equal(bindProbeToConnection([BOUND, { tenantId: 'tenant-A', connectionGeneration: 'gen-3' }]), null, 'generation differs')
  assert.equal(bindProbeToConnection([BOUND, { tenantId: 'tenant-A' }]), null, 'a response with no generation')
  assert.equal(bindProbeToConnection([{ tenantId: ' ', connectionGeneration: 'gen-1' }]), null, 'blank tenant')
})

test('[o3d-llyw] fence, headline shape: a SYNCED rival whose OWN payment is the unreadable one refuses on its own turn — the production loader gives a posted row no checks', async () => {
  const { loadOperatorLedgerChecks } = await import('@/lib/domain/accounting/operator-ledger-check-store')
  xeroAnswer = { data: invoice([{ PaymentID: 'PAY-S', Date: '2026-08-02', Amount: 40.005 }]), ...BOUND }
  // A check row exists for EVERY contender — including one somebody wrote for S by hand (psql), which
  // the recorder would have refused. The store is what the processor wires in.
  const stored = ['log-f', 'log-s'].map((syncLogId) => ({ ...CHECK, id: `chk-${syncLogId}`, syncLogId, ledgerRecordIds: ['PAY-S'], ledgerRecordFingerprints: [fp(S_AS_SHOWN)] }))
  const standing: Record<string, { status: string; externalTransactionId: string | null }> = {
    'log-f': { status: 'FAILED', externalTransactionId: null },
    'log-s': { status: 'SYNCED', externalTransactionId: 'PAY-S' },
  }
  const client = {
    accountingSyncLog: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in
        .filter((id) => id in standing)
        .map((id) => ({ id, ...standing[id], abandonedBeforeRemoteCall: null, settlementBasis: null })),
    },
    accountingOperatorLedgerCheck: {
      findMany: async ({ where }: { where: { syncLogId: { in: string[] }; paymentId: string } }) =>
        stored.filter((c) => where.syncLogId.in.includes(c.syncLogId) && c.paymentId === where.paymentId),
    },
  }
  const loader = (scope: unknown) => loadOperatorLedgerChecks(client as never, {
    syncLogIds: [(scope as { attemptSyncLogId: string }).attemptSyncLogId],
    paymentId: (scope as { paymentId: string | null }).paymentId,
    connector: 'xero',
  })
  const onlyF = await postN({ loader })
  assert.deepEqual(onlyF, { proceed: true, requireConnection: BOUND }, 'precondition: with F the only contender, F\'s check lets the post through')
  const verdict = await postN({
    rows: [
      { id: 'log-n', remoteAttemptedAt: null, payload: N_PAYLOAD },
      { id: 'log-f', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z'), payload: F_PAYLOAD },
      { id: 'log-s', remoteAttemptedAt: new Date('2026-08-02T10:00:00Z'), payload: S_PAYLOAD },
    ],
    loader,
  })
  precondition('SYNCED rival S with unreadable own payment', verdict)
  assert.equal(verdict.proceed, false, 'S claims to have posted, so no check speaks for it')
  assert.match(verdict.proceed ? '' : verdict.error, /log-s/)
})

test('[o3d-llyw] wiring: the Xero processor hands the store loader to the INVOICE_PAYMENT fence and to the revival gate, and to nothing else', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const wired = source.split('loadOperatorLedgerChecks: (scope) => loadOperatorLedgerChecks(db, {').length - 1
  console.log(`[precondition] loader wiring sites in the Xero processor: ${wired}`)
  assert.equal(wired, 2, 'exactly the INVOICE_PAYMENT fence call and the revival gate')
  // The fence call that carries it is the INVOICE_PAYMENT branch's — not BILL_PAYMENT's or an allocation's.
  const invoiceBranch = source.slice(source.indexOf("case 'INVOICE_PAYMENT': {"), source.indexOf("case 'BILL_PAYMENT': {"))
  assert.ok(invoiceBranch.includes('loadOperatorLedgerChecks: (scope) => loadOperatorLedgerChecks(db, {'),
    'the receipt branch passes the loader to its fence')
  // (Codex r4) ...and hands the connection the fence bound to the POST, so the transport can refuse a reconnect.
  assert.ok(invoiceBranch.includes('}, async ({ requireConnection }) => {'), 'the receipt branch takes the fence context')
  const postAt = invoiceBranch.indexOf("xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments'")
  assert.ok(postAt > 0 && invoiceBranch.indexOf('...(requireConnection ? { requireConnection } : {}),', postAt) > postAt,
    'and passes it to the Payments POST')
  const revival = source.slice(source.indexOf('const evidence = await ledgerClearsFollowUpRevival({'))
  assert.ok(revival.slice(0, 900).includes('loadOperatorLedgerChecks: (scope) => loadOperatorLedgerChecks(db, {'),
    'and the revival gate passes it too')
})

test('[o3d-llyw] fence and revival: a payment EDITED IN PLACE under the same id is no longer covered by the check made about its earlier state', async () => {
  const { ledgerClearsFollowUpRevival } = await probeModule()
  xeroAnswer = { data: invoice([UNREADABLE_HAND_PAYMENT]), ...BOUND }
  const unchanged = await postN({ loader: async () => [CHECK] })
  assert.deepEqual(unchanged, { proceed: true, requireConnection: BOUND }, 'precondition: the check lifts the record as confirmed')
  for (const [label, edited] of [
    ['amount', { ...UNREADABLE_HAND_PAYMENT, Amount: 41.005 }],
    ['date', { ...UNREADABLE_HAND_PAYMENT, Date: '2026-08-03' }],
    ['reference', { ...UNREADABLE_HAND_PAYMENT, Reference: 'edited in Xero' }],
  ] as const) {
    xeroAnswer = { data: invoice([edited]), ...BOUND }
    const verdict = await postN({ loader: async () => [CHECK] })
    console.log(`[precondition] fence, ${label} edited under PAY-H: ${verdict.proceed ? 'PROCEED' : 'REFUSED'}`)
    assert.equal(verdict.proceed, false, `fence: an edited ${label} is not what the operator confirmed`)
    const revival = await ledgerClearsFollowUpRevival({
      connector: 'xero', type: 'INVOICE_PAYMENT', payload: F_PAYLOAD, tokenDisposition: 'pinned', syncLogId: 'log-f',
      loadOperatorLedgerChecks: async () => [{ ...CHECK, paymentId: 'pay-f' }],
    })
    assert.equal(revival.clear, false, `revival: an edited ${label} is not what the operator confirmed`)
  }
})
