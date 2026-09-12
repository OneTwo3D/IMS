import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'

/**
 * o3d-i0o6 r9 (Codex round 8, HIGH) — NOTHING ANSWERS FOR A PINNED ENQUEUE BEFORE THE FENCE HAS
 * SPOKEN. IN PARTICULAR, NOT THE CONNECTOR'S OWN SYNC TOGGLE.
 *
 * THE HOLE ROUND 8 LEFT. r8 put the pinned-ledger verdict under the plugin-selection lock on the
 * INSERTING transaction, and that part holds — `tests/accounting/pinned-ledger-fence.test.ts` pins the
 * ordering and `tests/concurrency/pinned-ledger-fence.concurrent.test.ts` races it. What it did not do
 * is stop anything else answering first. Both connector queues read their own settings BEFORE opening
 * that transaction, and both returned `not-configured` from there:
 *
 *   1. the facade's unlocked pooled check accepts the pin — Xero is active when it looks;
 *   2. a connector switch commits;
 *   3. the queue's `xero_sync_enabled` read finds the toggle off and returns `not-configured` before
 *      the transaction, so `pinnedLedgerIsServicedUnderLock` never runs.
 *
 * AND `not-configured` IS THE ONE NO-OP THAT SETTLES. `lib/domain/sales/refund-accounting-
 * obligations.ts` settles an obligation on `not-configured` when the pinned connector's `willPost`
 * verdict — taken when the hand-off opened — was already false. That is precisely the state below: the
 * pinned connector's toggle was already off. So the refund's ALLOCATION_REVERSAL obligation is marked
 * settled with NO reversal row on any ledger, on a configuration that has been retired, while the
 * ledger now being serviced would have taken the posting.
 *
 * WHY THE R8 FILE COULD NOT CATCH THIS, which is the finding to carry forward. Its fixture stubs
 * `getXeroSettings` and `getQuickBooksSettings` to `*_sync_enabled: 'true'` — deliberately, so that a
 * refusal there can only have come from the fence — and the defect needs the toggle OFF. The setup
 * excluded the state under test. So this file's toggles are MUTABLE per test, and the tests that
 * matter run with them off.
 *
 * WHAT IS PINNED HERE:
 *
 *   1. a pinned enqueue whose ledger has been switched away answers `refused`, not `not-configured`,
 *      when the pinned connector's master toggle is off (tests 1, 5);
 *   2. and when it is the PER-TYPE posting mode that is off — the second early return in each queue,
 *      not the one Codex named (test 3);
 *   3. the narrowing is a narrowing: with no switch, a toggled-off pinned enqueue is still
 *      `not-configured`, which is what lets a genuinely disabled posting settle (tests 2, 4, 6);
 *   4. unpinned traffic pays nothing — no selection lock, no transaction (test 7);
 *   5. the facade's own native-posting suppression is fenced the same way (tests 8, 9);
 *   6. and STRUCTURALLY: neither connector queue phrases a `not-configured` outcome itself any more,
 *      so a new unfenced gate cannot be added by copying the shape of an existing one (test 10).
 */

/** The `settings` table, as far as the LOCKED plugin read is concerned. */
const settingsTable = new Map<string, string>()

/**
 * The connector sync settings, MUTABLE — this is the fixture difference that matters.
 *
 * The r8 file froze both master toggles on, which excluded the entire state this file is about. Here
 * each test says what the configuration is, and the tests that reproduce the defect say "off".
 */
const xeroSettings = new Map<string, string>()
const quickBooksSettings = new Map<string, string>()

/**
 * A POOLED read that has gone stale — the facade's window, exactly as r8 modelled it. `null` means
 * "answer from the table". Set, `isIntegrationPluginEnabled` answers from THIS while the locked read
 * still answers from the table: the facade's snapshot was taken before the switch committed, the
 * locked read after.
 */
let stalePooledSelection: Record<string, boolean> | null = null

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => (
      stalePooledSelection
        ? stalePooledSelection[id] === true
        : settingsTable.get(INTEGRATION_PLUGIN_SETTING_KEYS[id as 'xero']) === 'true'
    ),
  },
})

mock.module('@/lib/connectors/xero/settings', {
  namedExports: { getXeroSettings: async () => Object.fromEntries(xeroSettings) },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: { getQuickBooksSettings: async () => Object.fromEntries(quickBooksSettings) },
})
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: {
    resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }),
    lockOrderForAccountingEnqueue: async () => false,
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => undefined,
  },
})
mock.module('@/lib/connectors/accounting-id-provenance', {
  namedExports: { activeAccountingIdProvenance: async () => ({}) },
})
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

/** Rows written by whichever path is under test. */
const created: Array<{ connector: string; type: string }> = []
/** What the transactions issued, in order. */
let trace: string[] = []

function transactionDouble() {
  return {
    $executeRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.raw.join(' ')
      if (sql.includes('pg_advisory_xact_lock') && values[0] === ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY) {
        trace.push('plugin-selection-advisory-lock')
      } else if (/insert into settings/i.test(sql)) {
        trace.push('materialise-plugin-rows')
      } else if (sql.includes('pg_advisory_xact_lock')) {
        trace.push('follow-up-scope-lock')
      } else {
        trace.push('other-execute-raw')
      }
      return 1
    },
    $queryRaw: async (query: TemplateStringsArray) => {
      const sql = query.raw.join(' ')
      if (/from settings/i.test(sql) && /for update/i.test(sql)) {
        trace.push('locked-plugin-read')
        return [...settingsTable].map(([key, value]) => ({ key, value }))
      }
      trace.push('other-query-raw')
      return []
    },
    accountingSyncLog: {
      findMany: async () => [],
      create: async ({ data }: { data: { connector: string; type: string } }) => {
        trace.push('insert-accounting-sync-log')
        created.push({ connector: data.connector, type: data.type })
        return { id: `log-${created.length}`, ...data }
      },
    },
    activityLog: { create: async () => ({ id: 'activity-1' }) },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async <T>(fn: (tx: ReturnType<typeof transactionDouble>) => Promise<T>): Promise<T> =>
        fn(transactionDouble()),
      accountingSyncLog: { findMany: async () => [] },
    },
  },
})

const REVERSAL = {
  type: 'ALLOCATION_REVERSAL' as const,
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  payload: { lines: [{ accountCode: '630', debit: 16 }, { accountCode: '631', credit: 16 }] },
  // o3d-j625 r2: required on the enqueue now, and it names the same ledger as the pin — a pin and a
  // chart that disagree are refused, so that is the only combination a pinned request can have. The
  // chart check is POOLED, so in the window tests below it sees `stalePooled`'s "xero is still active"
  // and passes; the refusal that follows is still the locked fence's.
  chartConnector: 'xero' as const,
}

/**
 * @param selection what the LOCKED read sees — the committed plugin rows.
 * @param xero / quickbooks each connector's own sync settings, which a plugin switch does not touch.
 */
function reset(options: {
  selection: { xero: boolean; quickbooks: boolean }
  xero?: Record<string, string>
  quickbooks?: Record<string, string>
  stalePooled?: Record<string, boolean>
}): void {
  settingsTable.clear()
  settingsTable.set(INTEGRATION_PLUGIN_SETTING_KEYS.xero, String(options.selection.xero))
  settingsTable.set(INTEGRATION_PLUGIN_SETTING_KEYS.quickbooks, String(options.selection.quickbooks))
  xeroSettings.clear()
  for (const [key, value] of Object.entries(options.xero ?? {})) xeroSettings.set(key, value)
  quickBooksSettings.clear()
  for (const [key, value] of Object.entries(options.quickbooks ?? {})) quickBooksSettings.set(key, value)
  stalePooledSelection = options.stalePooled ?? null
  created.length = 0
  trace = []
}

// ---------------------------------------------------------------------------------------------
// THE MASTER TOGGLE
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] a pinned enqueue whose ledger was switched away REFUSES, even though its sync toggle is off', async () => {
  // THE STATE THE R8 FIXTURE EXCLUDED. The switch to QuickBooks has committed, and Xero's own master
  // toggle is off — the two facts together, which is what makes the old code answer from the toggle
  // read and never reach the fence.
  reset({
    selection: { xero: false, quickbooks: true },
    xero: { xero_sync_enabled: 'false' },
  })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync({ ...REVERSAL, pinnedLedger: 'xero' })

  assert.equal(outcome.reason, 'refused',
    '`not-configured` here is the one no-op the refund obligation ledger may SETTLE an obligation '
    + 'with — and it settled it against a ledger the selection had already moved off, leaving the '
    + 'reversal with no row on any ledger. The posting is owed: `refused`')
  assert.equal(outcome.queued, false)
  assert.deepEqual(created, [], 'and still nothing written')
  assert.ok(trace.includes('locked-plugin-read'),
    'the verdict must come from the FENCE, under the plugin-selection lock — not from an unlocked '
    + `settings read that returned before any lock was taken. Trace: ${trace.join(' -> ') || '(nothing)'}`)
  assert.ok(trace.indexOf('plugin-selection-advisory-lock') < trace.indexOf('locked-plugin-read'),
    'and the rows are read after the advisory lock, not before it')
})

test('[o3d-i0o6 r9] THE NARROWING — with no switch, a toggled-off pinned enqueue is still `not-configured`', async () => {
  // The control that stops the fix being a blanket rename of `not-configured` to `refused`. Xero is
  // still the active ledger; its sync really is off; no counterpart will ever exist. That is a
  // DECISION, and the refund obligation ledger is entitled to settle on it — if this returned
  // `refused`, every refund taken on a deliberately disabled connector would throw
  // RefundAccountingObligationsUnmet and no refund could be staged at all.
  reset({
    selection: { xero: true, quickbooks: false },
    xero: { xero_sync_enabled: 'false' },
  })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync({ ...REVERSAL, pinnedLedger: 'xero' })

  assert.equal(outcome.reason, 'not-configured',
    'the pinned ledger IS the one being serviced and it does not post — nothing is outstanding')
  assert.deepEqual(created, [])
  assert.ok(trace.includes('locked-plugin-read'), 'and the answer was still taken under the lock')
})

// ---------------------------------------------------------------------------------------------
// THE PER-TYPE POSTING MODE — the second early return in each queue, the one Codex did not name
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] the PER-TYPE posting mode is fenced too, not just the master toggle', async () => {
  // Codex named lib/connectors/xero/queue.ts:89 (the master toggle). :93 was the same defect with the
  // same consequence, reachable with the master toggle ON — so a fix to :89 alone would have left the
  // money path open for any type with a per-type setting.
  reset({
    selection: { xero: false, quickbooks: true },
    xero: { xero_sync_enabled: 'true', xero_sync_cogs_journal: 'off' },
  })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync({ ...REVERSAL, type: 'COGS_JOURNAL', pinnedLedger: 'xero' })

  assert.equal(outcome.reason, 'refused', 'a per-type `off` may not settle an obligation for a retired ledger either')
  assert.deepEqual(created, [])
  assert.ok(trace.includes('locked-plugin-read'), `the fence must have been consulted: ${trace.join(' -> ') || '(nothing)'}`)
})

test('[o3d-i0o6 r9] and a per-type `off` on the STILL-ACTIVE ledger remains `not-configured`', async () => {
  reset({
    selection: { xero: true, quickbooks: false },
    xero: { xero_sync_enabled: 'true', xero_sync_cogs_journal: 'off' },
  })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync({ ...REVERSAL, type: 'COGS_JOURNAL', pinnedLedger: 'xero' })

  assert.equal(outcome.reason, 'not-configured')
  assert.deepEqual(created, [])
})

// ---------------------------------------------------------------------------------------------
// THE CROSS-PORT
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] the QuickBooks queue gate is fenced too', async () => {
  // Cross-ported rather than left as "Xero is the one that matters today": a fence with a gate in one
  // side of it is not a fence.
  reset({
    selection: { xero: true, quickbooks: false },
    quickbooks: { quickbooks_sync_enabled: 'false' },
  })
  const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')

  const outcome = await queueQuickBooksSync({ ...REVERSAL, pinnedLedger: 'quickbooks' })

  assert.equal(outcome.reason, 'refused', 'the locked read says xero is active, so a quickbooks pin is owed elsewhere')
  assert.deepEqual(created, [])
  assert.ok(trace.includes('locked-plugin-read'), `the fence must have been consulted: ${trace.join(' -> ') || '(nothing)'}`)
})

test('[o3d-i0o6 r9] and the QuickBooks narrowing holds as well', async () => {
  reset({
    selection: { xero: false, quickbooks: true },
    quickbooks: { quickbooks_sync_enabled: 'false' },
  })
  const { queueQuickBooksSync } = await import('@/lib/connectors/quickbooks/queue')

  const outcome = await queueQuickBooksSync({ ...REVERSAL, pinnedLedger: 'quickbooks' })

  assert.equal(outcome.reason, 'not-configured')
  assert.deepEqual(created, [])
})

// ---------------------------------------------------------------------------------------------
// THE UNPINNED PATH PAYS NOTHING
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] an UNPINNED toggled-off enqueue takes no lock and opens no transaction', async () => {
  // The property that makes this safe to put on the hot path: every accounting enqueue in the system
  // goes through these queues, and the overwhelming majority are unpinned. An unpinned enqueue took
  // its connector FROM the active-connector resolution, so there is no pin for a switch to invalidate
  // and nothing to fence.
  reset({
    selection: { xero: true, quickbooks: false },
    xero: { xero_sync_enabled: 'false' },
  })
  const { queueXeroSync } = await import('@/lib/connectors/xero/queue')

  const outcome = await queueXeroSync(REVERSAL)

  assert.equal(outcome.reason, 'not-configured')
  assert.deepEqual(trace, [],
    `an unpinned enqueue must issue nothing at all when sync is off: ${trace.join(' -> ')}`)
})

// ---------------------------------------------------------------------------------------------
// THE FACADE'S OWN PRE-FENCE `not-configured`
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] the facade\'s native-posting suppression is fenced for a pinned enqueue', async () => {
  // Xero posts FX gain/loss itself, so an IMS journal for it is suppressed — a `not-configured` taken
  // on the facade, before the connector queue and therefore before the fence. "Never" there is a
  // statement about XERO; with the pin retired, QuickBooks is what is being serviced and it DOES post
  // them, so the suppression may not settle the obligation on the retired ledger's behalf.
  //
  // The facade's own pooled check has to PASS for this line to be reached, which is what
  // `stalePooled` supplies: the snapshot taken before the switch committed.
  reset({
    selection: { xero: false, quickbooks: true },
    xero: { xero_sync_enabled: 'true' },
    stalePooled: { xero: true, quickbooks: false },
  })
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync({ ...REVERSAL, type: 'REALISED_FX_JOURNAL', connector: 'xero' })

  assert.equal(outcome.reason, 'refused')
  assert.equal(outcome.connector, 'xero', 'and the answer is about the ledger the caller pinned')
  assert.deepEqual(created, [])
  assert.ok(trace.includes('locked-plugin-read'), `the fence must have been consulted: ${trace.join(' -> ') || '(nothing)'}`)
})

test('[o3d-i0o6 r9] and suppression on the still-active ledger stays `not-configured`', async () => {
  reset({
    selection: { xero: true, quickbooks: false },
    xero: { xero_sync_enabled: 'true' },
  })
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync({ ...REVERSAL, type: 'REALISED_FX_JOURNAL', connector: 'xero' })

  assert.equal(outcome.reason, 'not-configured', 'Xero posts these itself; nothing is outstanding')
  assert.deepEqual(created, [])
})

// ---------------------------------------------------------------------------------------------
// STRUCTURAL: the shape, not just today's behaviour
// ---------------------------------------------------------------------------------------------

test('[o3d-i0o6 r9] neither connector queue phrases a `not-configured` outcome itself', async () => {
  /**
   * WHY A STRUCTURAL ASSERTION AND NOT ONLY THE BEHAVIOURAL ONES ABOVE. This defect has now been
   * found three times on this branch in the same shape: a rule enforced at every point someone
   * remembered. The behavioural tests above cover the gates that exist TODAY; this one is about the
   * gates that do not exist yet. `connectorSyncGate` returns a type that is not a
   * ConnectorEnqueueOutcome and `notConfiguredUnderPinnedLedgerFence` is the only conversion, so the
   * sole remaining way to answer `not-configured` from these files unfenced is to type the literal —
   * and that is what this forbids.
   *
   * It is a claim about the GRAMMAR of the outcome, not about proximity to some other line: no
   * "unless a fence call appears within N lines", which would pass forever the moment the two drifted
   * apart. The files may discuss `not-configured` in prose all they like; they may not construct one.
   */
  const files = ['lib/connectors/xero/queue.ts', 'lib/connectors/quickbooks/queue.ts']
  for (const file of files) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

    // THE PRECONDITION: this really is the queue, really was read, and really does construct enqueue
    // outcomes — so a zero count below is the absence of one kind of literal, not the absence of a
    // file. Without these three, a typo in the path would make the assertion pass reading nothing.
    assert.ok(source.length > 2000, `${file}: nothing was read`)
    assert.match(source, /reason: 'refused'/,
      `${file}: expected this file to construct outcome literals — if it no longer does, the check below `
      + 'is measuring nothing')
    assert.match(source, /notConfiguredUnderPinnedLedgerFence/,
      `${file}: the fenced conversion is the only way this file may answer \`not-configured\``)

    const constructed = [...source.matchAll(/reason:\s*['"]not-configured['"]/g)]
    assert.deepEqual(constructed.map((m) => m[0]), [],
      `${file} constructs a \`not-configured\` outcome of its own. Every one of these is given BEFORE `
      + 'the inserting transaction, so on a pinned enqueue it answers without the fence — and '
      + '`not-configured` is the one no-op the refund obligation ledger may settle an obligation with. '
      + 'Route it through notConfiguredUnderPinnedLedgerFence (lib/domain/accounting/pinned-enqueue-fence.ts).')
  }
})
