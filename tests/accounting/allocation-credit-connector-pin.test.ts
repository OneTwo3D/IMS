import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { INTEGRATION_PLUGIN_IDS, INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'

/**
 * o3d-i0o6 r3 (Codex round 2, HIGH 1) — THE FACADE ENQUEUE TAKES THE PIN TOO, BECAUSE THAT IS THE
 * ROUTE THE PROVED ALLOCATION CREDIT ACTUALLY TAKES.
 *
 * Round 2 pinned `queueAccountingSyncTx` — the in-transaction enqueue — and filed the facade as
 * later work. The filing did not hold. A refund's allocation credit is staged inside the refund
 * transaction, where the A2 debit is proved against ONE connector and the journal's account codes
 * are read from THAT connector's settings; the resulting `UNEARNED_REV_REVERSAL` is then queued,
 * later and outside that transaction, by `queueRefundAccountingActions` — through the facade.
 * Unpinned, the facade resolved "the active connector" all over again, so a switch between staging
 * and the hand-off queued the credit on one ledger with the account codes and the proof of another.
 *
 * o3d-i0o6 r7 (Codex round 6, HIGH 1) — AND A PIN IS NOT A LICENCE TO WRITE TO A LEDGER NOTHING
 * SCHEDULED IS SERVICING.
 *
 * r3 proved half of it: a pinned enqueue is answered BY the named connector rather than by whichever
 * is active. What neither enqueue then asked was whether the named connector is STILL THE ACTIVE
 * ONE. The active accounting connector comes from the PLUGIN flags; `<connector>_sync_enabled` is a
 * separate setting that a switch does not touch. So after Xero -> QuickBooks, a credit pinned to
 * Xero passed `xero_sync_enabled === 'true'` and a PENDING Xero row was written, while the
 * accounting-sync cron had already taken the QuickBooks branch and returned. Nothing scheduled
 * drains it, and `assertAllocationReversalQueued` — which asks the DATABASE for the row, because the
 * enqueue's boolean lies — found it and let the caller record those unposted pounds as relief.
 *
 * The rule those two rounds add up to, and what this file pins:
 *
 *   1. a pinned enqueue is answered BY AND FOR the named connector, never by whichever is active;
 *   2. and it WRITES ONLY while the named connector is the active one — otherwise it refuses,
 *      with `refused` and never `not-configured`, because the posting is still owed;
 *   3. an UNPINNED enqueue is unchanged — every existing caller keeps the active-connector
 *      resolution by simply not passing the parameter, which is what makes the pin safe to add.
 */

const queued: Array<{ queue: 'xero' | 'quickbooks'; type: string; referenceId: string }> = []
let enabledPlugins: string[] = ['xero']
let xeroSyncEnabled = 'true'
let quickbooksSyncEnabled = 'true'

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => enabledPlugins.includes(id),
  },
})

mock.module('@/lib/connectors/xero/queue', {
  namedExports: {
    queueXeroSync: async (params: { type: string; referenceId: string }) => {
      if (xeroSyncEnabled !== 'true') return { queued: false, reason: 'not-configured' }
      queued.push({ queue: 'xero', type: params.type, referenceId: params.referenceId })
      return { queued: true }
    },
  },
})

/**
 * The in-transaction enqueue reads the PINNED connector's own settings to decide whether it posts
 * this type. Doubled so the control below can distinguish "the pin guard let this through and the
 * posting context answered" from "the pin guard refused", by REASON rather than by a stack trace.
 */
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: xeroSyncEnabled,
      xero_sync_allocation_reversal: 'submitted',
    }),
  },
})

mock.module('@/lib/connectors/quickbooks/queue', {
  namedExports: {
    queueQuickBooksSync: async (params: { type: string; referenceId: string }) => {
      if (quickbooksSyncEnabled !== 'true') return { queued: false, reason: 'not-configured' }
      queued.push({ queue: 'quickbooks', type: params.type, referenceId: params.referenceId })
      return { queued: true }
    },
  },
})

const REQUEST = {
  type: 'UNEARNED_REV_REVERSAL' as const,
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  payload: { lines: [{ accountCode: '631', credit: 20 }, { accountCode: '630', debit: 20 }] },
}

function reset(): void {
  queued.length = 0
  enabledPlugins = ['xero']
  xeroSyncEnabled = 'true'
  quickbooksSyncEnabled = 'true'
}

test('o3d-i0o6 r3: a PINNED facade enqueue is answered BY the named connector, not by the active one', async () => {
  reset()
  // Both plugins on. `getActiveAccountingConnectorId` is Xero-first, so 'xero' is the active one and
  // an UNPINNED enqueue would go there; the pin names it explicitly and is answered for it.
  enabledPlugins = ['xero', 'quickbooks']

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero' })

  assert.equal(outcome.connector, 'xero', 'the answer is about the PROVED ledger')
  assert.equal(outcome.queued, true)
  assert.deepEqual(queued.map((row) => row.queue), ['xero'], 'and the row was written there')
})

test('o3d-i0o6 r7: a pin to a ledger that is no longer the ACTIVE connector writes nothing', async () => {
  reset()
  // The switch that happens between staging and the hand-off: QuickBooks is active now. Xero's own
  // sync toggle is untouched by that switch and is still 'true' — which is precisely why the
  // enqueue's own gate said yes and a PENDING Xero row was written that nothing scheduled drains.
  enabledPlugins = ['quickbooks']
  assert.equal(xeroSyncEnabled, 'true', 'the premise: the pinned connector still posts, on its own gate')

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero' })

  assert.equal(outcome.queued, false, 'nothing is queued anywhere')
  assert.deepEqual(queued, [], 'and specifically NOT into the pinned connector\'s own queue')
  assert.equal(outcome.connector, 'xero', 'the refusal is reported against the pinned ledger')
  // `not-configured` is the ONE no-op the refund obligation ledger allows to SETTLE an obligation —
  // it means "no counterpart will ever exist, so nothing is outstanding". This posting is still
  // owed; it may just not go here, now. Reporting it as `not-configured` would discharge the refund
  // obligation and clear `accountingRetryRequired` for a reversal nobody raised.
  assert.equal(outcome.reason, 'refused', 'and as OWED, not as "this will never post"')
})

test('o3d-i0o6 r3: a pinned enqueue whose connector does not post this type writes nothing, and says so', async () => {
  reset()
  // The pinned connector IS the active one; what is off is its own sync toggle. This is the arm r3
  // added, kept distinct from r7's so a fix to either cannot make the other vacuous.
  enabledPlugins = ['xero']
  xeroSyncEnabled = 'false'

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero' })

  assert.equal(outcome.queued, false, 'nothing is queued anywhere')
  assert.equal(outcome.connector, 'xero', 'and the refusal is reported against the pinned ledger')
  assert.deepEqual(queued, [], 'it did NOT fall back to the active connector')
})

test('o3d-i0o6 r3: an UNPINNED enqueue still resolves the active connector, exactly as before', async () => {
  reset()
  enabledPlugins = ['quickbooks']

  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync(REQUEST)

  assert.equal(outcome.connector, 'quickbooks')
  assert.deepEqual(queued.map((row) => row.queue), ['quickbooks'])
})

// ---------------------------------------------------------------------------------------------
// o3d-i0o6 r7 — AND THE SAME RULE ON THE IN-TRANSACTION ENQUEUE, WHICH IS THE ONE THE ORPHAN
// ALLOCATION REVERSAL USES.
//
// `allocation-service`'s orphan reversal pins `proof.provedOnConnector` and goes through
// `queueAccountingSyncTx`. Its own unit fixture doubles that function, so the rule has to be pinned
// against the REAL one here or the guard is only ever proved about the double — the two disagreeing
// is exactly how this defect stayed invisible for six rounds (the double modelled
// `<connector>_sync_enabled` and nothing else, which is the gate that is insufficient).
//
// `PurchaseInvoice` is not an order-scoped reference type, so `resolveAccountingEnqueueOrderScope`
// answers `none` and the pin guard is reached with no sales-order row.
//
// o3d-i0o6 r8 (Codex round 7, HIGH) — AND THE GUARD NOW ASKS THE TRANSACTION, because that is the
// only way its answer can survive to the insert. It takes the plugin-selection lock through `tx` and
// reads the plugin rows `FOR UPDATE`, so these two tests supply a `tx` that serves exactly those two
// statements and throws on everything else. See `fenceOnlyTx`, and see
// tests/accounting/pinned-ledger-fence.test.ts for the ordering and window assertions.
// ---------------------------------------------------------------------------------------------

const TX_REQUEST = {
  type: 'ALLOCATION_REVERSAL' as const,
  referenceType: 'PurchaseInvoice',
  referenceId: 'pi-1',
  payload: { lines: [{ accountCode: '631', credit: 20 }, { accountCode: '630', debit: 20 }] },
}

/**
 * o3d-i0o6 r8 (Codex round 7, HIGH) — THIS DOUBLE USED TO FORBID THE FENCE, AND THAT IS WHY IT IS
 * DIFFERENT NOW.
 *
 * r7 wrote it as a Proxy that threw on EVERY property access, under the banner "the pinned refusal
 * must come BEFORE any transaction work". That was the wrong invariant, and it was wrong in the
 * direction that hid the finding: answering the pinned-ledger question WITHOUT touching the
 * transaction is precisely what makes the answer an unlocked snapshot, and a snapshot is what the
 * switch commits behind. A fixture that refuses to be asked cannot be asked under a lock, so it could
 * not have failed for the missing fence — it would have failed for the FIX.
 *
 * What r7 actually wanted to assert is narrower and still asserted: NOTHING IS WRITTEN, and nothing
 * below the guard is reached. So the two statements the fence legitimately issues are served — the
 * advisory lock and the `FOR UPDATE` read of the plugin rows — and every other member, `accountingSyncLog`
 * included, still throws.
 *
 * AND IT SERVES THEM FROM `enabledPlugins`, the same variable the pooled `isIntegrationPluginEnabled`
 * double reads. One source, so the fixture cannot answer the locked read and the pooled read
 * differently and let a bug hide in the disagreement. (The file that deliberately makes them
 * disagree — because production does, inside the window — is
 * tests/accounting/pinned-ledger-fence.test.ts, and it says so.)
 */
function fenceOnlyTx(): unknown {
  const served = {
    $executeRaw: async () => 1,
    $queryRaw: async () => (
      INTEGRATION_PLUGIN_IDS
        .filter((id) => enabledPlugins.includes(id))
        .map((id) => ({ key: INTEGRATION_PLUGIN_SETTING_KEYS[id], value: 'true' }))
    ),
  }
  return new Proxy(served, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      throw new Error(
        `o3d-i0o6 r7/r8: nothing below the pinned-ledger guard may be reached, and nothing may be `
        + `written (tx.${String(prop)})`,
      )
    },
  })
}

test('o3d-i0o6 r7: the IN-TRANSACTION enqueue refuses a pin that is not the active connector', async () => {
  reset()
  enabledPlugins = ['quickbooks']
  assert.equal(xeroSyncEnabled, 'true', 'the premise: the pinned connector still posts, on its own gate')

  const { queueAccountingSyncTx } = await import('@/lib/accounting')
  let reported: { queued: boolean; reason?: string; connector: string | null } | null = null
  const wrote = await queueAccountingSyncTx(
    fenceOnlyTx() as never,
    {
      ...TX_REQUEST,
      connector: 'xero',
      reportOutcome: (outcome) => { reported = outcome },
    },
  )

  assert.equal(wrote, false, 'nothing was written')
  assert.deepEqual(
    reported,
    { queued: false, reason: 'refused', connector: 'xero' },
    'and the answer names the pinned ledger and reports the posting as still OWED',
  )
})

test('o3d-i0o6 r7: THE CONTROL — an ACTIVE pin passes the guard and reaches the posting context', async () => {
  reset()
  // Same call, same pin, same reference — only the plugin state differs. The guard must be a
  // narrowing and not a blanket refusal on every pinned enqueue, and the two outcomes are told apart
  // by REASON: `refused` is the guard, `not-configured` can only have come from the posting context
  // BELOW it. Without this control the test above would pass for a fix that refused every pin.
  enabledPlugins = ['xero']
  xeroSyncEnabled = 'false'

  const { queueAccountingSyncTx } = await import('@/lib/accounting')
  let reported: { queued: boolean; reason?: string; connector: string | null } | null = null
  const wrote = await queueAccountingSyncTx(
    fenceOnlyTx() as never,
    {
      ...TX_REQUEST,
      connector: 'xero',
      reportOutcome: (outcome) => { reported = outcome },
    },
  )

  assert.equal(wrote, false)
  assert.deepEqual(
    reported,
    { queued: false, reason: 'not-configured', connector: 'xero' },
    'the pin guard let it through; what declined it was the pinned connector\'s OWN posting verdict',
  )
})
