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

/**
 * o3d-j625 r2: the chart refusal writes a WARNING activity. This file has no database double, and the
 * refusal swallows a logging failure — so without this the test would pass for the wrong reason (a
 * failed connection caught by `.catch`). Doubled so the write is a no-op that cannot fail.
 */
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => undefined },
})

/**
 * o3d-j625 r8 — AND THE SAME ARGUMENT NOW APPLIES TO THE DATABASE ITSELF.
 *
 * Before anything else, the facade asks whether this exact posting was already posted BY HAND
 * (lib/domain/accounting/posting-suppression.ts). Until r8 a read that FAILED was answered "not
 * suppressed", so this file's facade tests were reaching a real, unconfigured client, failing to
 * connect, and being carried past it — passing for exactly the reason the note above guards against.
 * r8 makes an unreadable suppression refuse the enqueue, so the read has to be a real answer, and this
 * is that answer: nothing here was marked handled.
 */
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingPostingRefusal: {
        findUnique: async () => null,
        upsert: async () => ({ id: 'refusal-1' }),
        updateMany: async () => ({ count: 0 }),
      },
    },
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

// o3d-remove-parked-connectors: a `mock.module` for an archived QuickBooks module was here.

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
  enabledPlugins = ['xero']

  const { queueAccountingSync } = await import('@/lib/accounting')
  // o3d-j625 r2: the chart is REQUIRED now and names the same ledger as the pin — the only combination
  // a pinned enqueue can have. Xero is the active connector here, so the chart check passes and what is
  // being asserted is still the pin.
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero', chartConnector: 'xero' })

  assert.equal(outcome.connector, 'xero', 'the answer is about the PROVED ledger')
  assert.equal(outcome.queued, true)
  assert.deepEqual(queued.map((row) => row.queue), ['xero'], 'and the row was written there')
})

test('o3d-i0o6 r7: a pin to a ledger that is no longer the ACTIVE connector writes nothing', async () => {
  reset()
  // The switch that happens between staging and the hand-off: QuickBooks is active now. Xero's own
  // sync toggle is untouched by that switch and is still 'true' — which is precisely why the
  // enqueue's own gate said yes and a PENDING Xero row was written that nothing scheduled drains.
  enabledPlugins = []
  assert.equal(xeroSyncEnabled, 'true', 'the premise: the pinned connector still posts, on its own gate')

  const { queueAccountingSync } = await import('@/lib/accounting')
  // o3d-j625 r2: THE REFUSAL IS NOW TAKEN ONE STEP EARLIER, AND THE CONTRACT IS UNCHANGED.
  //
  // With the chart required and naming the same retired ledger as the pin, `refuseUnattributableChart`
  // answers first — pooled, and with the same outcome the r7 pin check gave: nothing written,
  // `refused`, reported against the pinned ledger. The r7/r8 check the chart check does NOT subsume is
  // the LOCKED one taken inside the inserting transaction, and that is asserted where a fixture can
  // make the pooled and locked reads disagree: tests/accounting/pinned-ledger-fence.test.ts.
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero', chartConnector: 'xero' })

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
  // o3d-j625 r2: chart = pin = the ACTIVE connector, so neither the chart check nor the r7 pin check
  // can fire and the refusal below can only have come from the connector's own sync toggle. That
  // separation is the reason this arm exists.
  const outcome = await queueAccountingSync({ ...REQUEST, connector: 'xero', chartConnector: 'xero' })

  assert.equal(outcome.queued, false, 'nothing is queued anywhere')
  assert.equal(outcome.connector, 'xero', 'and the refusal is reported against the pinned ledger')
  assert.deepEqual(queued, [], 'it did NOT fall back to the active connector')
})

test('o3d-i0o6 r3: an UNPINNED enqueue still resolves the active connector, exactly as before', async () => {
  // o3d-remove-parked-connectors: this enabled ONLY the second connector and asserted the enqueue
  // followed it — which showed the resolution was real rather than a constant. With one registered
  // connector that distinction is unobservable here, so the case asserts what remains: an unpinned
  // enqueue takes its connector from the resolution and reports it. Recorded in
  // docs/archive/quickbooks-connector-removal.md.
  //
  // o3d-j625 r12 (merge): the branch's version of this case enabled `quickbooks` and asserted the row
  // followed its CHART rather than a re-resolution. That assertion is now UNOBSERVABLE for the same
  // reason, so development's version stands. What survives is the requirement itself — `chartConnector`
  // is mandatory on the request (a tsc error to omit), which is what removed the second resolution.
  // Filed as a follow-up rather than faked with one connector.
  reset()
  enabledPlugins = ['xero']

  const { queueAccountingSync } = await import('@/lib/accounting')
  // o3d-j625 r2: "unpinned AND unchartered" no longer exists — `chartConnector` is required, so there
  // is no caller left that makes the enqueue resolve the connector for itself. What "unpinned" now
  // means is exactly this: no PROOF about a ledger, but still a statement about whose account codes are
  // in the payload, and the row follows that statement.
  const outcome = await queueAccountingSync({ ...REQUEST, chartConnector: 'xero' })

  assert.equal(outcome.connector, 'xero')
  assert.deepEqual(queued.map((row) => row.queue), ['xero'])
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
  enabledPlugins = []
  assert.equal(xeroSyncEnabled, 'true', 'the premise: the pinned connector still posts, on its own gate')

  const { queueAccountingSyncTx } = await import('@/lib/accounting')
  // o3d-j625 r5: a HOLDER — TypeScript narrows a `let` assigned only inside a callback to `never`, which
  // silently makes every assertion about it unable to observe anything.
  const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } | null } = {}
  const wrote = await queueAccountingSyncTx(
    fenceOnlyTx() as never,
    {
      ...TX_REQUEST,
      connector: 'xero',
      // o3d-j625 r2: same ledger as the pin — see the facade arm above for why the refusal is now the
      // chart check's and why the contract is unchanged.
      chartConnector: 'xero',
      reportOutcome: (outcome) => { answered.outcome = outcome },
    },
  )

  assert.equal(wrote, false, 'nothing was written')
  // o3d-j625 r5: the answer now also carries the POSTING KEY it is about (and, on a refusal, the active
  // connector) — asserted as a superset so the three facts under test stay the three facts under test.
  assert.equal(answered.outcome?.queued, false)
  assert.equal(answered.outcome?.reason, 'refused')
  assert.equal(answered.outcome?.connector, 'xero', 'the answer names the pinned ledger and reports the posting as still OWED')
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
  // o3d-j625 r5: a HOLDER — TypeScript narrows a `let` assigned only inside a callback to `never`, which
  // silently makes every assertion about it unable to observe anything.
  const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } | null } = {}
  const wrote = await queueAccountingSyncTx(
    fenceOnlyTx() as never,
    {
      ...TX_REQUEST,
      connector: 'xero',
      // o3d-j625 r2: chart = pin = ACTIVE, so this control still reaches the posting context — which is
      // the whole point of it: `not-configured` here can only have come from BELOW both guards.
      chartConnector: 'xero',
      reportOutcome: (outcome) => { answered.outcome = outcome },
    },
  )

  assert.equal(wrote, false)
  // o3d-j625 r5: a superset — the answer now also carries the posting key it is about.
  assert.equal(answered.outcome?.queued, false)
  assert.equal(answered.outcome?.reason, 'not-configured',
    'the pin guard let it through; what declined it was the pinned connector\'s OWN posting verdict')
  assert.equal(answered.outcome?.connector, 'xero')
})

// o3d-j625 r5 (review M-1, the second HIGH 4 site) — THE TRIM COMMITS WHATEVER THE ENQUEUE ANSWERS, so a
// refused reversal is a real debt and the enqueue must be ASKED to record it inside the trim's transaction.
// The allocation service's own fixture doubles the enqueue, so the request is pinned here against the
// source: the enqueue call that carries `type: 'ALLOCATION_REVERSAL'` must pass the flag. The block is cut
// at the call's own closing `})`, so a flag belonging to a neighbouring call cannot satisfy it.
test('[o3d-j625 r5 M-1] the orphan allocation reversal ASKS its in-transaction enqueue to record a refusal', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(`${process.cwd()}/lib/domain/sales/allocation-service.ts`, 'utf8')
  const calls = [...src.matchAll(/await queueAccountingSyncTx\(tx, \{\n([\s\S]*?)\n {2}\}\)\n/g)]
    .map((m) => m[1])
    .filter((body) => /^\s*type: 'ALLOCATION_REVERSAL',$/m.test(body))
  assert.equal(calls.length, 1, `PRECONDITION: exactly one ALLOCATION_REVERSAL enqueue located (found ${calls.length})`)
  assert.match(calls[0], /^\s*recordRefusalAsOutstanding: true,$/m,
    'without it a refused reversal leaves pounds in Allocated Inventory recorded only on the Activity page')
})
