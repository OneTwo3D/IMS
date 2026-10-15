import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { grantXeroWrites } from '../helpers/outbound-grants'

/**
 * o3d-llyw (Codex r4 on #757) — A POST AUTHORISED BY AN OPERATOR LEDGER CHECK GOES OUT UNDER THE CONNECTION
 * THE CHECK WAS VALIDATED AGAINST, OR NOT AT ALL.
 *
 * The fence validates the check against the tenant and generation its probe GET was served by; the POST
 * resolves auth again. Driven end to end through the REAL fence (`postMoneyUnderLedgerFence` ->
 * `authoriseMoneyPost` -> `probeLedgerSettlement`) and the REAL Xero transport (`xeroGet`, `xeroPost`); only
 * the token resolver, the two policy gates and the socket are replaced. A reconnect is simulated between
 * the probe and the POST by changing what `getAccessToken` answers.
 */

let auth: { accessToken: string; tenantId: string; connectionGeneration: string | null } = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
const wire: Array<{ method: string; url: string }> = []
let onBeforePost: (() => void) | null = null

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => { grantXeroWrites(auth.tenantId); return auth },
    getStoredTenantBlockReason: async () => null,
  },
})
mock.module('@/lib/connectors/accounting-posting-intent', { namedExports: { accountingPostingIntentRefusal: () => null } })
mock.module('@/lib/connectors/accounting-egress-authorization', { namedExports: { accountingEgressRefusal: async () => null } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      wire.push({ method, url })
      const body = method === 'GET'
        ? { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 60, AmountPaid: 40, Payments: [{ PaymentID: 'PAY-H', Date: '2026-08-02', Amount: 40.005 }] }] }
        : { Payments: [{ PaymentID: 'PAY-N' }] }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    },
  },
})

const F_PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 100, currency: 'GBP', paymentDate: '2026-08-01', paymentId: 'pay-f' }
const N_PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 60, currency: 'GBP', paymentDate: '2026-08-09', paymentId: 'pay-new' }

async function sendN() {
  const { postMoneyUnderLedgerFence } = await import('@/lib/connectors/accounting-settlement-probe')
  const { xeroPost } = await import('@/lib/connectors/xero/api')
  const { settlementRecordFingerprint } = await import('@/lib/domain/accounting/operator-ledger-check')
  const check = {
    id: 'chk-1', syncLogId: 'log-f', paymentId: 'pay-new', connector: 'xero', ledgerDocumentId: 'INV-1',
    ledgerRecordIds: ['PAY-H'], tenantId: 'tenant-A', connectionGeneration: 'gen-1',
    ledgerRecordFingerprints: [settlementRecordFingerprint({ id: 'PAY-H', amount: null, unreadableAmount: '40.005', date: '2026-08-02', reference: null })],
  }
  const rows = [
    { id: 'log-n', remoteAttemptedAt: null as Date | null, payload: N_PAYLOAD },
    { id: 'log-f', remoteAttemptedAt: new Date('2026-08-01T10:00:00Z') as Date | null, payload: F_PAYLOAD },
  ]
  const db = {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: { id: string }; data: { remoteAttemptedAt: Date } }) => {
        const row = rows.find((r) => r.id === where.id && r.remoteAttemptedAt === null)
        if (!row) return { count: 0 }
        row.remoteAttemptedAt = data.remoteAttemptedAt
        return { count: 1 }
      },
      findMany: async ({ where }: { where: { id: { not: string } } }) =>
        rows.filter((r) => r.remoteAttemptedAt !== null && r.id !== where.id.not).map((r) => ({ id: r.id, payload: r.payload })),
    },
  }
  let required: unknown = 'not called'
  const outcome = await postMoneyUnderLedgerFence({
    connector: 'xero', entryId: 'log-n', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1',
    payload: N_PAYLOAD, postingDate: '2026-08-09', db: db as never,
    loadOperatorLedgerChecks: async () => [check],
    lock: (async (_doc: unknown, run: (held: { assertHeld: () => void; lost: boolean }) => Promise<unknown>) =>
      ({ locked: true, result: await run({ assertHeld: () => {}, lost: false }) })) as never,
  }, async ({ requireConnection }) => {
    required = requireConnection ?? null
    onBeforePost?.()
    // The processor's INVOICE_PAYMENT branch, reduced to the call that matters.
    const res = await xeroPost('Payments', { Payments: [{ Amount: 60 }] }, { idempotencyKey: 'k', ...(requireConnection ? { requireConnection } : {}) })
    return res.ok ? { success: true, externalId: 'PAY-N' } : { success: false, error: res.error ?? `notSent ${String((res as { notSent?: string }).notSent)}` }
  })
  return { outcome, required }
}

test('[o3d-llyw] precondition: with the connection unchanged, the check-authorised POST goes out under it', async () => {
  auth = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
  wire.length = 0
  onBeforePost = null
  const { outcome, required } = await sendN()
  console.log(`[precondition] unchanged: outcome=${JSON.stringify(outcome)} required=${JSON.stringify(required)} wire=${wire.map((w) => w.method).join(',')}`)
  assert.deepEqual(required, { tenantId: 'tenant-A', connectionGeneration: 'gen-1' }, 'the fence hands the post the connection the check was validated against')
  assert.equal(outcome.success, true)
  assert.deepEqual(wire.map((w) => w.method), ['GET', 'POST'])
})

for (const [label, after] of [
  ['generation re-minted (reconnect to the same organisation)', { tenantId: 'tenant-A', connectionGeneration: 'gen-2' }],
  ['tenant swapped', { tenantId: 'tenant-B', connectionGeneration: 'gen-9' }],
  ['legacy row with no generation', { tenantId: 'tenant-A', connectionGeneration: null }],
] as const) {
  test(`[o3d-llyw] a reconnect between the fence's probe and the POST — ${label} — sends NOTHING`, async () => {
    auth = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
    wire.length = 0
    onBeforePost = () => { auth = { accessToken: 't2', ...after } }
    const { outcome, required } = await sendN()
    console.log(`[precondition] ${label}: required=${JSON.stringify(required)} outcome=${JSON.stringify(outcome).slice(0, 160)} wire=${wire.map((w) => w.method).join(',')}`)
    assert.deepEqual(required, { tenantId: 'tenant-A', connectionGeneration: 'gen-1' }, 'precondition: the post was authorised by the check')
    assert.equal(outcome.success, false)
    assert.deepEqual(wire.map((w) => w.method), ['GET'], 'no POST reached the socket')
    assert.match(String(outcome.error), /connection changed after this payment was checked against the ledger/)
  })
}

test('[o3d-llyw] a post NOT authorised by a check carries no connection requirement (nothing else changes)', async () => {
  const { xeroPost } = await import('@/lib/connectors/xero/api')
  auth = { accessToken: 't', tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
  wire.length = 0
  const res = await xeroPost('Payments', { Payments: [] }, { idempotencyKey: 'k2' })
  assert.equal(res.ok, true)
  assert.deepEqual(wire.map((w) => w.method), ['POST'])
})
