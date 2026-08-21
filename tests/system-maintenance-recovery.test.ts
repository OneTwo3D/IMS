import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMaintenanceRecoveryState,
  claimPostMaintenanceRecheck,
  countMaintenanceRecovery,
  endMaintenanceHold,
  MAINTENANCE_RECOVERY_REFUSALS,
  parseMaintenanceHoldRecord,
} from '../lib/domain/system/maintenance-recovery.ts'

// ---------------------------------------------------------------------------------------------
// o3d-hl8l r5 (Codex r4 finding 1) — A REFUSED CALLBACK NEEDS A REMEDY AN OPERATOR CAN PERFORM.
//
// The maintenance fence refuses inbound booked-in callbacks with a 503 and writes no row. Round 4
// made the ordinary window recover itself: the close stamps `wms_booked_in_recheck_due_since` and a
// five-minute cron drains it by re-checking every open ASN. The branch the fence EXISTS for — a
// restore whose backend could not be confirmed gone — never closes that way. It holds the flag,
// never calls `disableMaintenanceMode`, and so never stamps anything; the only clear available was a
// hand-written UPDATE, which ends the window and schedules nothing. That is the LONGEST kind of
// window, so it is the one most likely to have refused something.
//
// These pin the two operator actions, and specifically that each one RE-READS ITS PRECONDITION UNDER
// THE LOCK and refuses by name rather than trusting that the button was rendered for a good reason.
// ---------------------------------------------------------------------------------------------

const ENABLED_KEY = 'system_maintenance_mode'
const REASON_KEY = 'system_maintenance_reason'
const HOLD_KEY = 'system_maintenance_hold'
const RECHECK_KEY = 'wms_booked_in_recheck_due_since'

const HOLD = {
  heldAt: '2026-08-18T09:05:00.000Z',
  reason: 'Restore timed out and its database backend could NOT be confirmed gone.',
  backendPid: 4242,
  backendStart: '2026-08-18 09:00:00.123456+00',
  applicationName: 'ims_restore_abc123',
}

/**
 * ONE settings table behind a real `FOR UPDATE`.
 *
 * `lockedKeys` records what the transition actually locked, and `readAfterLock` records whether the
 * values it decided from were read through that lock or from somewhere else. A double that just
 * returns rows cannot tell those apart, and the whole finding is that the decision must not be the
 * page's.
 */
function recoveryTx(initial: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(initial))
  const trace: string[] = []
  let lockedKeys: string[] = []
  const upserts: Array<{ key: string; value: string }> = []
  const deleted: string[] = []

  return {
    rows,
    trace,
    upserts,
    deleted,
    get lockedKeys() { return lockedKeys },
    /** Fires once, between the materialise and the locked read — the last moment a racer can win. */
    concurrent: null as null | (() => void),
    tx: {
      async $executeRaw(_q: TemplateStringsArray, ...values: unknown[]) {
        // The materialise step. `FOR UPDATE` locks only rows that EXIST, so this is load-bearing.
        for (const key of (values[0] as string[]) ?? []) if (!rows.has(key)) rows.set(key, '')
        trace.push('materialise')
        return 0
      },
      async $queryRaw<T>(_q: TemplateStringsArray, ...values: unknown[]) {
        const keys = (values[0] as string[]) ?? []
        // A competing writer commits here and NOT after: once FOR UPDATE returns, Postgres would
        // make it wait, which is the entire reason for taking the lock.
        if (harness.concurrent) { harness.concurrent(); harness.concurrent = null }
        lockedKeys = [...keys]
        trace.push('locked-read')
        return keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) ?? null })) as unknown as T
      },
      setting: {
        async upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
          upserts.push({ key: args.where.key, value: args.update.value })
          rows.set(args.where.key, args.update.value)
          return {}
        },
        async deleteMany(args: { where: { key: { in: string[] } } }) {
          for (const key of args.where.key.in) { rows.delete(key); deleted.push(key) }
          return { count: 0 }
        },
      },
    },
  }
  // (assigned below so the query double can see itself)
}

// `recoveryTx` needs a self-reference for the concurrent hook; build it in two steps.
let harness: ReturnType<typeof recoveryTx>
function makeTx(initial: Record<string, string> = {}) {
  harness = recoveryTx(initial)
  return harness
}

const goneBackend = { isRestoreBackendAttached: async () => false }
const unknownBackend = { isRestoreBackendAttached: async () => null }

// --- ending the hold ----------------------------------------------------------------------------

test('o3d-hl8l r5: ending a held window clears the flag AND stamps the booked-in re-check, in one transaction', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [REASON_KEY]: 'restore', [HOLD_KEY]: JSON.stringify(HOLD) })

  const result = await endMaintenanceHold(h.tx, { ...goneBackend, now: () => new Date('2026-08-18T10:00:00Z') })

  assert.equal(result.ended, true)
  assert.equal(result.ended && result.recheckDueSince, '2026-08-18T10:00:00.000Z')
  assert.equal(h.rows.get(ENABLED_KEY), 'false')
  assert.equal(h.rows.get(REASON_KEY), '')
  assert.equal(
    h.rows.get(RECHECK_KEY),
    '2026-08-18T10:00:00.000Z',
    'THE HALF THE HAND-WRITTEN UPDATE ALWAYS MISSED. Without this stamp the window ends with no '
      + 'automatic re-check, and every callback the fence refused is nobody’s until the watchdog '
      + 'notices days later',
  )
  assert.deepEqual(h.deleted, [HOLD_KEY], 'the hold record is consumed, so the row cannot be re-actioned')
})

test('o3d-hl8l r5: the decision is made from rows read under FOR UPDATE, not from what the page showed', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [HOLD_KEY]: JSON.stringify(HOLD) })
  // A second operator ends the window in the instant between the materialise and the locked read.
  h.concurrent = () => { h.rows.set(ENABLED_KEY, 'false'); h.rows.delete(HOLD_KEY) }

  const result = await endMaintenanceHold(h.tx, goneBackend)

  assert.deepEqual(
    result,
    { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.notInMaintenance },
    'the racer won, and the re-read is what makes that visible',
  )
  assert.deepEqual(h.upserts, [], 'nothing was written on the refusal path')
  assert.deepEqual(
    h.lockedKeys,
    [HOLD_KEY, ENABLED_KEY, REASON_KEY, RECHECK_KEY].sort(),
    'every row the transition reads or writes is locked, in one canonical order',
  )
  assert.deepEqual(h.trace, ['materialise', 'locked-read'], 'materialise first: FOR UPDATE locks only rows that exist')
})

test('o3d-hl8l r5: a flag on with NO hold recorded is refused — that is a restore still RUNNING', async () => {
  // The most important refusal here. Clearing the flag mid-restore unfences the cron jobs and the
  // webhooks over a database that is actively being replayed, which is the original defect.
  const h = makeTx({ [ENABLED_KEY]: 'true' })

  const result = await endMaintenanceHold(h.tx, goneBackend)

  assert.deepEqual(result, { ended: false, reason: MAINTENANCE_RECOVERY_REFUSALS.noHoldRecorded })
  assert.equal(h.rows.get(ENABLED_KEY), 'true', 'a live restore keeps its fences')
  assert.equal(h.rows.get(RECHECK_KEY) ?? '', '', 'and no re-check is scheduled for a window that has not ended')
})

test('o3d-hl8l r5: the hold is NOT ended while the named backend is still attached', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [HOLD_KEY]: JSON.stringify(HOLD) })
  const checked: Array<{ pid: number; backendStart: string }> = []

  const result = await endMaintenanceHold(h.tx, {
    isRestoreBackendAttached: async (identity) => { checked.push(identity); return true },
  })

  assert.equal(result.ended, false)
  assert.equal(!result.ended && result.reason, MAINTENANCE_RECOVERY_REFUSALS.backendStillRunning)
  assert.equal(h.rows.get(ENABLED_KEY), 'true')
  assert.deepEqual(
    checked,
    [{ pid: 4242, backendStart: '2026-08-18 09:00:00.123456+00' }],
    'matched on the PAIR: a pid alone is reused, and application_name is a GUC the replayed SQL can change',
  )
})

test('o3d-hl8l r5: an unanswerable backend check refuses rather than assuming either way', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [HOLD_KEY]: JSON.stringify(HOLD) })

  const result = await endMaintenanceHold(h.tx, unknownBackend)

  assert.equal(!result.ended && result.reason, MAINTENANCE_RECOVERY_REFUSALS.backendIndeterminate)
  assert.equal(h.rows.get(ENABLED_KEY), 'true', 'assuming "gone" would unfence the writers over a live restore')
})

test('o3d-hl8l r5: a hold record naming no backend is unreadable, not "a hold with nothing to check"', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [HOLD_KEY]: JSON.stringify({ ...HOLD, backendPid: 0 }) })
  let checks = 0

  const result = await endMaintenanceHold(h.tx, { isRestoreBackendAttached: async () => { checks += 1; return false } })

  assert.equal(!result.ended && result.reason, MAINTENANCE_RECOVERY_REFUSALS.holdUnreadable)
  assert.equal(checks, 0, 'skipping the check because the evidence is malformed is the button deciding for itself')
  assert.equal(h.rows.get(ENABLED_KEY), 'true')
})

test('o3d-hl8l r5: an already-pending re-check marker is KEPT, not restamped to now', async () => {
  const h = makeTx({
    [ENABLED_KEY]: 'true',
    [HOLD_KEY]: JSON.stringify(HOLD),
    [RECHECK_KEY]: '2026-08-01T00:00:00.000Z',
  })

  const result = await endMaintenanceHold(h.tx, { ...goneBackend, now: () => new Date('2026-08-18T10:00:00Z') })

  assert.equal(result.ended && result.recheckDueSince, '2026-08-01T00:00:00.000Z')
  assert.equal(
    h.rows.get(RECHECK_KEY),
    '2026-08-01T00:00:00.000Z',
    'an un-drained older window has been owed a re-check for longer; restamping makes a backlog look new',
  )
})

// --- claiming the re-check ----------------------------------------------------------------------

test('o3d-hl8l r5: a manual re-check is refused while maintenance mode is still on', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'true', [RECHECK_KEY]: '2026-08-18T10:00:00.000Z' })

  const result = await claimPostMaintenanceRecheck(h.tx)

  assert.deepEqual(result, { due: false, reason: MAINTENANCE_RECOVERY_REFUSALS.maintenanceModeOn })
})

test('o3d-hl8l r5: a manual re-check is refused when no window is actually pending', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'false' })

  assert.deepEqual(
    await claimPostMaintenanceRecheck(h.tx),
    { due: false, reason: MAINTENANCE_RECOVERY_REFUSALS.noRecheckDue },
  )

  // The materialised empty row means the same as an absent one, on this path as on every other.
  const h2 = makeTx({ [ENABLED_KEY]: 'false', [RECHECK_KEY]: '   ' })
  assert.deepEqual(
    await claimPostMaintenanceRecheck(h2.tx),
    { due: false, reason: MAINTENANCE_RECOVERY_REFUSALS.noRecheckDue },
  )
})

test('o3d-hl8l r5: a due re-check is claimed WITHOUT clearing the marker', async () => {
  const h = makeTx({ [ENABLED_KEY]: 'false', [RECHECK_KEY]: '2026-08-18T10:00:00.000Z' })

  const result = await claimPostMaintenanceRecheck(h.tx)

  assert.deepEqual(result, { due: true, windowEndedAt: '2026-08-18T10:00:00.000Z' })
  assert.equal(
    h.rows.get(RECHECK_KEY),
    '2026-08-18T10:00:00.000Z',
    'the drain clears it only once EVERY open ASN was attempted — claiming it here drops the retry a '
      + 'truncated page depends on',
  )
  assert.deepEqual(h.deleted, [])
})

// --- what the inbox renders ---------------------------------------------------------------------

test('o3d-hl8l r5: the inbox shows the hold only while the flag is actually held', async () => {
  const held = buildMaintenanceRecoveryState(new Map([[ENABLED_KEY, 'true'], [HOLD_KEY, JSON.stringify(HOLD)]]))
  assert.equal(held.hold?.backendPid, 4242)
  assert.equal(countMaintenanceRecovery(held), 1)

  const debris = buildMaintenanceRecoveryState(new Map([[ENABLED_KEY, 'false'], [HOLD_KEY, JSON.stringify(HOLD)]]))
  assert.equal(debris.hold, null, 'the window is over; the only action the row offers has nothing left to do')
  assert.equal(countMaintenanceRecovery(debris), 0)
})

test('o3d-hl8l r5: a due re-check is an inbox item in its own right, with or without a hold', () => {
  const state = buildMaintenanceRecoveryState(new Map([[ENABLED_KEY, 'false'], [RECHECK_KEY, '2026-08-18T10:00:00.000Z']]))
  assert.equal(state.recheckDueSince, '2026-08-18T10:00:00.000Z')
  assert.equal(state.hold, null)
  assert.equal(countMaintenanceRecovery(state), 1)

  const both = buildMaintenanceRecoveryState(new Map([
    [ENABLED_KEY, 'true'],
    [HOLD_KEY, JSON.stringify(HOLD)],
    [RECHECK_KEY, '2026-08-01T00:00:00.000Z'],
  ]))
  assert.equal(countMaintenanceRecovery(both), 2)

  assert.equal(countMaintenanceRecovery(buildMaintenanceRecoveryState(new Map())), 0)
})

test('o3d-hl8l r5: the hold record is parsed strictly — the backend pair is what makes it actionable', () => {
  assert.equal(parseMaintenanceHoldRecord(null), null)
  assert.equal(parseMaintenanceHoldRecord(''), null)
  assert.equal(parseMaintenanceHoldRecord('not json'), null)
  assert.equal(parseMaintenanceHoldRecord('"a string"'), null)
  assert.equal(parseMaintenanceHoldRecord(JSON.stringify({ ...HOLD, backendPid: -1 })), null)
  assert.equal(parseMaintenanceHoldRecord(JSON.stringify({ ...HOLD, backendPid: 4242.5 })), null)
  assert.equal(parseMaintenanceHoldRecord(JSON.stringify({ ...HOLD, backendStart: '  ' })), null)
  assert.deepEqual(parseMaintenanceHoldRecord(JSON.stringify(HOLD)), HOLD)
})
