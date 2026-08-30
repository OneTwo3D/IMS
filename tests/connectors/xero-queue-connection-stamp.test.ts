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
 * and the connector-generic `queueAccountingSyncTx`).
 *
 * The helper ALWAYS writes something now (Codex r1 finding 1): a real `"<connector>:<tenantId>"` when
 * there is a connection, and an explicit `!disconnected` when there is not. Absence is therefore no
 * longer produced by any live writer, which is what lets the processor's guard treat it as "queued
 * before this shipped" — a population that drains and never grows — instead of as a state it is
 * still manufacturing on every disconnection.
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
        // o3d-d0pd: the already-present check reads EVERY row for the key, in any status, and
        // decides from the row's own evidence — see prior-posting-evidence.ts. A live row is the
        // case this fixture models.
        async findMany() {
          return state.existingIdempotent
            ? [{ id: 'already-queued', status: 'PENDING', externalTransactionId: null }]
            : []
        },
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
  // o3d-y14 (#618) added the stale-order-discount fence to this module and queueXeroSync now calls
  // it under the same lock. A namedExports mock REPLACES the module, so omitting the two new exports
  // made the queue die on "findStaleOrderLevelDiscount is not a function" before it ever reached the
  // connection stamp this file is about.
  //
  // `null` is "the payload's discount agrees with the order" — the ordinary state, and the only one
  // that lets the enqueue proceed to the insert being asserted on here. The fence's own behaviour is
  // covered in tests/domain/accounting/enqueue-discount-fence.ts; modelling a STALE snapshot here
  // would silently turn every case below into a refusal that queues nothing.
  namedExports: {
    lockOrderForAccountingEnqueue: async () => 'order-1',
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => {},
  },
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

test('o3d-19gy: enqueueing while DISCONNECTED records THAT, rather than recording nothing', async () => {
  // REVERSED, and the reversal is the point (Codex r1 finding 1). The earlier rule was "stamp nothing",
  // on the reasoning that an EMPTY stamp would be indistinguishable from a pre-o3d-19gy row. True of an
  // empty stamp — and an argument for a DISTINGUISHABLE one, not for silence. Silence is what made them
  // indistinguishable, and it made the claim "the unstamped population only shrinks after one deploy"
  // false: every row queued during a disconnection was born unstamped, and "queued while disconnected,
  // then connected to a different organisation, then posted" is the incident's own shape.
  reset(null)

  await queueXeroSync(PARAMS)

  const payload = state.created[0].payload as Record<string, unknown>
  assert.equal(payload[CONNECTION_KEY], '!disconnected')
  assert.equal(payload.invoiceNumber, 'INV-1', 'and the row is still queued — this is not a refusal')
})

test('o3d-19gy: the disconnected marker can never be read as an organisation', async () => {
  // It has to be unmistakable in BOTH directions: it must not match any connection, and no connection
  // may ever spell itself this way. `"<connector>:<tenantId>"` cannot — no connector name is empty and
  // none begins with `!` — so the two vocabularies do not overlap.
  const { readAccountingPayloadConnectionStamp, accountingPayloadConnectionVerdict } =
    await import('@/lib/connectors/accounting-connection-provenance')

  assert.deepEqual(readAccountingPayloadConnectionStamp({ [CONNECTION_KEY]: '!disconnected' }), {
    state: 'raised-disconnected',
  })
  const verdict = accountingPayloadConnectionVerdict({
    payload: { [CONNECTION_KEY]: '!disconnected' },
    activeProvenance: 'xero:!disconnected',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
  })
  assert.equal(verdict.decision, 'raised-disconnected')
  assert.equal(verdict.mayPost, false)
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
