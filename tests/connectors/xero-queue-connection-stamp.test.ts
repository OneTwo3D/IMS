import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-19gy, the ENQUEUE half: every Xero sync row records the connection its payload was composed
 * against, or the refusal in the processor has nothing to compare and protects nothing.
 *
 * This is the writer that matters most — `queueXeroSync` is the path almost every document takes — but
 * it is not the only one, and that is the point these tests are really pinning. The pin-writer lesson
 * from o3d-9tbz r9 applies here too: a rule that lives in one call site is a rule the next call site
 * will not have. So the stamp is applied by a single shared helper and every Xero writer routes through
 * it (`queueXeroSync`, `createPendingSyncLog` in daily-sync, `enqueueFollowUpSyncLog` in the processor,
 * and the connector-generic `queueAccountingSyncTx`), and the processor's guard treats an UNSTAMPED row
 * as legacy rather than as current — so a writer that somehow escapes leaves work that is allowed
 * through, not work that is silently mis-attributed.
 */

const CONNECTION_KEY = '_connectionProvenance'

const state = {
  created: [] as Array<Record<string, unknown>>,
  activeTenantId: 'tenant-A' as string | null,
  existingIdempotent: false,
}

const tx = {
  accountingSyncLog: {
    async create(args: { data: Record<string, unknown> }) {
      state.created.push(args.data)
      return { id: `log-${state.created.length}` }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        async findUnique() {
          return state.activeTenantId === null ? null : { tenantId: state.activeTenantId }
        },
      },
      accountingSyncLog: {
        async findFirst() { return state.existingIdempotent ? { id: 'already-queued' } : null },
      },
      async $transaction(fn: (client: unknown) => Promise<unknown>) { return fn(tx) },
    },
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({ xero_sync_enabled: 'true', xero_sync_sales_invoice: 'submitted' }),
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined },
})
mock.module('@/lib/base-currency', {
  namedExports: { getBaseCurrencyCode: async () => 'GBP' },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => undefined },
})
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: { lockOrderForAccountingEnqueue: async () => 'order-1' },
})

async function queueXeroSync(params: Parameters<
  typeof import('@/lib/connectors/xero/queue')['queueXeroSync']
>[0]) {
  const { queueXeroSync: impl } = await import('@/lib/connectors/xero/queue')
  return impl(params)
}

function reset(activeTenantId: string | null = 'tenant-A') {
  state.created = []
  state.activeTenantId = activeTenantId
  state.existingIdempotent = false
}

const PARAMS = {
  type: 'SALES_INVOICE' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  payload: { invoiceNumber: 'INV-1', contactName: 'Acme' },
}

test('o3d-19gy: a queued Xero row records the connection it was composed against', async () => {
  reset('tenant-A')

  await queueXeroSync(PARAMS)

  assert.equal(state.created.length, 1)
  const payload = state.created[0].payload as Record<string, unknown>
  assert.equal(payload[CONNECTION_KEY], 'xero:tenant-A')
  // …and the document itself is untouched: the stamp sits beside _postingMode, which is the same kind
  // of fact — something about the queueing, not about the invoice.
  assert.equal(payload.invoiceNumber, 'INV-1')
  assert.equal(payload._postingMode, 'submitted')
})

test('o3d-19gy: the stamp follows the CONNECTION, not a constant', async () => {
  // The stamp has to be read at enqueue, per row. A value captured once at process start would be the
  // same defect one level up: it would agree with itself across the very reconnect it exists to notice.
  reset('tenant-B')

  await queueXeroSync(PARAMS)

  assert.equal((state.created[0].payload as Record<string, unknown>)[CONNECTION_KEY], 'xero:tenant-B')
})

test('o3d-19gy: enqueueing while DISCONNECTED stamps nothing rather than a placeholder', async () => {
  // A row can legitimately be queued with no connection — the sync is off, or the token was revoked —
  // and it simply waits. Stamping an empty or invented value would make it indistinguishable from a
  // pre-o3d-19gy row to every reader, which is a hole rather than a record.
  reset(null)

  await queueXeroSync(PARAMS)

  const payload = state.created[0].payload as Record<string, unknown>
  assert.equal(CONNECTION_KEY in payload, false)
  assert.equal(payload.invoiceNumber, 'INV-1', 'and the row is still queued — this is not a refusal')
})

test('o3d-19gy: the stamp does not disturb the idempotency short-circuit', async () => {
  // The idempotency check queries `payload.path(['_idempotencyKey'])`. Adding a sibling key to the same
  // JSON object must not change what that finds — and the row must still not be duplicated.
  reset('tenant-A')
  state.existingIdempotent = true

  await queueXeroSync({ ...PARAMS, idempotencyKey: 'inv-1-key' })

  assert.equal(state.created.length, 0, 'an already-queued row is still recognised as already queued')
})

test('o3d-19gy: the idempotency key and the connection stamp coexist on a new row', async () => {
  reset('tenant-A')

  await queueXeroSync({ ...PARAMS, idempotencyKey: 'inv-1-key' })

  const payload = state.created[0].payload as Record<string, unknown>
  assert.equal(payload._idempotencyKey, 'inv-1-key')
  assert.equal(payload[CONNECTION_KEY], 'xero:tenant-A')
})
