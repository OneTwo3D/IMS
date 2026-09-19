import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROLLOUT_RECONCILIATION_MAX_AGE_DAYS,
  collectRolloutReadiness,
  createRolloutReadinessHandler,
  type LatestAccountingReconciliationRun,
  type RolloutReadinessAdapters,
} from '../../lib/ops/rollout-readiness.ts'
import {
  evaluateReconciliationProof,
  unionContains,
  type ReconciliationHistory,
  type ReconciliationHistoryRun,
} from '../../lib/ops/reconciliation-proof.ts'
import type { AdminHealthResponse, HealthLevel } from '../../lib/ops/health.ts'

/**
 * o3d-6e4v — THE GATE REPORTS "READY" ONLY WHEN RECONCILIATION IS PROVEN COMPLETE.
 *
 * The failure mode this file exists to prevent is proof of an adjacent property: "the newest run has no
 * warning or critical findings" read as "the reconciliation is complete". A run that truncated its own report
 * can show a clean page, and an earlier truncation over a period the newest run never looked at is not
 * cleared by the newest run being clean. Each boundary below is asserted as the VERDICT the operator gets.
 *
 * The preflight and admin-health halves are held clean so every finding here is the reconciliation's.
 */

const NOW = new Date('2026-05-01T10:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (daysBeforeNow: number) => new Date(NOW.getTime() - daysBeforeNow * DAY).toISOString()
const ROW_CAP = 'reconciliation_row_cap_reached'
const VOID_MIRROR = 'void_mirror_basis_unknown_contradictions_truncated'
const UNMIRRORED = 'old_sync_log_without_mirrored_event_truncated'
const truncation = (code: string) => ({ code, message: `${code} — more exist than were listed`, details: { total: 900 } })

function run(id: string, createdDaysAgo: number, windowDays: number, truncations: unknown): ReconciliationHistoryRun {
  return {
    id,
    createdAt: iso(createdDaysAgo),
    fromDate: iso(createdDaysAgo + windowDays),
    toDate: iso(createdDaysAgo),
    truncations,
  }
}

function newestRun(overrides: Partial<LatestAccountingReconciliationRun> = {}): LatestAccountingReconciliationRun {
  return {
    id: 'newest',
    status: 'COMPLETED',
    totalCount: 0,
    warningCount: 0,
    criticalCount: 0,
    createdAt: iso(0),
    fromDate: iso(90),
    toDate: iso(0),
    truncations: [],
    ...overrides,
  }
}

function adapters(latest: LatestAccountingReconciliationRun | null, history: ReconciliationHistory | Error): RolloutReadinessAdapters {
  return {
    now: () => NOW,
    runPreflight: async () => ({ ok: true, checks: [{ id: 'node-env', name: 'NODE_ENV', status: 'pass', message: 'ok' }] }),
    collectAdminHealth: async () => cleanHealth(),
    latestAccountingReconciliationRun: async () => latest,
    accountingReconciliationHistory: async () => {
      if (history instanceof Error) throw history
      return history
    },
  }
}

const noHistory: ReconciliationHistory = { runs: [], overflow: false, recordedBeforeNewest: true }

async function verdict(latest: LatestAccountingReconciliationRun | null, history: ReconciliationHistory | Error = noHistory) {
  const report = await collectRolloutReadiness(adapters(latest, history))
  return {
    report,
    status: report.status,
    blockers: report.blockers.filter((f) => f.source === 'accounting-reconciliation').map((f) => f.id),
    warnings: report.warnings.filter((f) => f.source === 'accounting-reconciliation').map((f) => f.id),
  }
}

// ---------------------------------------------------------------------------------------------------
// The two shapes that read as READY before this change.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] a newest run that RECORDED a truncation is blocked — and allowWarnings cannot turn it green', async () => {
  const latest = newestRun({ warningCount: 1, totalCount: 1, truncations: [truncation(ROW_CAP)] })
  const history: ReconciliationHistory = { runs: [run('newest', 0, 90, [truncation(ROW_CAP)])], overflow: false, recordedBeforeNewest: true }
  const { status, blockers } = await verdict(latest, history)
  assert.equal(status, 'blocked')
  assert.deepEqual(blockers, ['accounting-reconciliation:truncation-unresolved'])

  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: () => collectRolloutReadiness(adapters(latest, history)),
  })
  const response = await handler(new Request('https://ims.example/api/admin/rollout-readiness?allowWarnings=true'))
  assert.equal(response.status, 412, 'a truncation is a blocker, not a warning the override can accept')
})

test('[o3d-6e4v] a CLEAN newest run does not clear an EARLIER truncation over a period it never examined', async () => {
  // Three months ago a 90-day run truncated; today's clean 90-day run starts where that one ended.
  const history: ReconciliationHistory = {
    runs: [run('old-truncated', 90, 90, [truncation(ROW_CAP)]), run('newest', 0, 90, [])],
    overflow: false,
    recordedBeforeNewest: true,
  }
  const { status, blockers, report } = await verdict(newestRun(), history)
  assert.equal(status, 'blocked', 'the newest run being clean is an adjacent property, not completeness')
  assert.deepEqual(blockers, ['accounting-reconciliation:truncation-unresolved'])
  const details = report.blockers.find((f) => f.id === 'accounting-reconciliation:truncation-unresolved')!.details as { unresolved: Array<{ runId: string; code: string }> }
  assert.deepEqual(details.unresolved.map((u) => [u.runId, u.code]), [['old-truncated', ROW_CAP]])
})

// ---------------------------------------------------------------------------------------------------
// Covering.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] a later clean run whose window CONTAINS the truncated one clears it — READY', async () => {
  const history: ReconciliationHistory = {
    runs: [run('old-truncated', 90, 90, [truncation(ROW_CAP)]), run('newest', 0, 200, [])],
    overflow: false,
    recordedBeforeNewest: true,
  }
  const { status, blockers, warnings } = await verdict(newestRun({ fromDate: iso(200) }), history)
  assert.deepEqual([status, blockers, warnings], ['ready', [], []])
})

test('[o3d-6e4v] coverage composes: two later clean runs that together span the truncated window clear it', async () => {
  const truncated = run('old-truncated', 90, 90, [truncation(ROW_CAP)]) // [180d, 90d] ago
  const composed: ReconciliationHistory = {
    runs: [
      truncated,
      { id: 'a', createdAt: iso(10), fromDate: iso(200), toDate: iso(130), truncations: [] },
      { id: 'b', createdAt: iso(5), fromDate: iso(140), toDate: iso(60), truncations: [] },
      run('newest', 0, 90, []),
    ],
    overflow: false,
    recordedBeforeNewest: true,
  }
  assert.equal((await verdict(newestRun(), composed)).status, 'ready')

  const gap: ReconciliationHistory = {
    ...composed,
    runs: [
      truncated,
      { id: 'a', createdAt: iso(10), fromDate: iso(200), toDate: iso(130), truncations: [] },
      { id: 'b', createdAt: iso(5), fromDate: iso(120), toDate: iso(60), truncations: [] }, // 130→120 uncovered
      run('newest', 0, 90, []),
    ],
  }
  assert.equal((await verdict(newestRun(), gap)).status, 'blocked', 'a ten-day gap in the union leaves it unresolved')
})

test('[o3d-6e4v] an EARLIER clean run covers nothing: coverage must come after the truncation', async () => {
  const history: ReconciliationHistory = {
    runs: [
      { id: 'before', createdAt: iso(100), fromDate: iso(400), toDate: iso(100), truncations: [] },
      run('old-truncated', 90, 90, [truncation(ROW_CAP)]),
      run('newest', 0, 90, []),
    ],
    overflow: false,
    recordedBeforeNewest: true,
  }
  assert.equal((await verdict(newestRun(), history)).status, 'blocked')
})

test('[o3d-6e4v] per check: a later run that truncated the SAME check does not cover it; one that truncated ANOTHER does', async () => {
  const same: ReconciliationHistory = {
    runs: [run('old', 90, 90, [truncation(UNMIRRORED)]), run('newest', 0, 200, [truncation(UNMIRRORED)])],
    overflow: false,
    recordedBeforeNewest: true,
  }
  const sameProof = evaluateReconciliationProof({ id: 'newest', truncations: [truncation(UNMIRRORED)] }, same)
  assert.equal(sameProof.state, 'not-proven')
  assert.deepEqual(sameProof.state === 'not-proven' ? sameProof.unresolved.map((u) => u.runId) : [], ['old', 'newest'])

  const other: ReconciliationHistory = {
    runs: [run('old', 90, 90, [truncation(UNMIRRORED)]), run('later', 1, 200, [truncation(ROW_CAP)]), run('newest', 0, 2, [])],
    overflow: false,
    recordedBeforeNewest: true,
  }
  const otherProof = evaluateReconciliationProof({ id: 'newest', truncations: [] }, other)
  // 'old' is covered by 'later' (which completed the unmirrored check over a containing window), but
  // 'later' itself truncated the row cap and nothing after it contains ITS window.
  assert.deepEqual(otherProof.state === 'not-proven' ? otherProof.unresolved.map((u) => [u.runId, u.code]) : [], [['later', ROW_CAP]])
})

test('[o3d-6e4v] a WHOLE-TABLE check is re-asked by any later recorded run, whatever its window', async () => {
  const history: ReconciliationHistory = {
    runs: [run('old', 90, 90, [truncation(VOID_MIRROR)]), run('newest', 0, 1, [])],
    overflow: false,
    recordedBeforeNewest: true,
  }
  assert.equal((await verdict(newestRun({ fromDate: iso(1) }), history)).status, 'ready')
})

test('[o3d-6e4v] a later run with NO completeness record (NULL) covers nothing', async () => {
  const proof = evaluateReconciliationProof(
    { id: 'newest', truncations: [] },
    { runs: [run('old', 90, 90, [truncation(VOID_MIRROR)]), run('null-run', 5, 400, null), run('newest', 0, 1, [])], overflow: false, recordedBeforeNewest: true },
  )
  // 'newest' is a recorded run after 'old' and covers the whole-table check; the NULL run is not counted.
  assert.equal(proof.state, 'proven')
  const withoutNewest = evaluateReconciliationProof(
    { id: 'null-run', truncations: null },
    { runs: [run('old', 90, 90, [truncation(VOID_MIRROR)]), run('null-run', 5, 400, null)], overflow: false, recordedBeforeNewest: true },
  )
  assert.equal(withoutNewest.state === 'not-proven' && withoutNewest.unresolved.length, 1)
})

// ---------------------------------------------------------------------------------------------------
// Unreadable, not-recorded, overflow, an adapter that fails.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] an UNREADABLE record blocks, under its own finding, until a later COMPLETE run contains it', async () => {
  const latest = newestRun({ truncations: { shape: 'from a future writer' } })
  const { status, blockers } = await verdict(latest, { runs: [run('newest', 0, 90, { shape: 'from a future writer' })], overflow: false, recordedBeforeNewest: true })
  assert.equal(status, 'blocked')
  assert.deepEqual(blockers, ['accounting-reconciliation:completeness-unreadable'])

  const coveredOnlyByTruncatedRun = evaluateReconciliationProof({ id: 'n', truncations: [truncation(ROW_CAP)] }, {
    runs: [run('bad', 90, 90, 'garbage'), run('n', 0, 400, [truncation(ROW_CAP)])], overflow: false, recordedBeforeNewest: true,
  })
  assert.ok(coveredOnlyByTruncatedRun.state === 'not-proven' && coveredOnlyByTruncatedRun.unresolved.some((u) => u.runId === 'bad'),
    'a run that truncated anything cannot vouch for a run whose record does not say what it lost')

  const covered = evaluateReconciliationProof({ id: 'n', truncations: [] }, {
    runs: [run('bad', 90, 90, 'garbage'), run('n', 0, 400, [])], overflow: false, recordedBeforeNewest: true,
  })
  assert.equal(covered.state, 'proven')
})

test('[o3d-6e4v] a newest run with NO record is a WARNING on the deploy that ships the column…', async () => {
  const { status, warnings, blockers } = await verdict(newestRun({ truncations: null }), { runs: [], overflow: false, recordedBeforeNewest: false })
  assert.equal(status, 'warning', 'every pre-column row is NULL, so blocking would be unsatisfiable on a correct deploy')
  assert.deepEqual(warnings, ['accounting-reconciliation:completeness-not-recorded'])
  assert.deepEqual(blockers, [])
})

test('[o3d-6e4v] …and a BLOCKER once an earlier run already recorded completeness (a writer that stopped recording)', async () => {
  const { status, blockers } = await verdict(newestRun({ truncations: null }), { runs: [], overflow: false, recordedBeforeNewest: true })
  assert.equal(status, 'blocked')
  assert.deepEqual(blockers, ['accounting-reconciliation:completeness-not-recorded'])
})

test('[o3d-6e4v] a history too long to read is a blocker, never a partial read taken as clean', async () => {
  const { status, blockers } = await verdict(newestRun(), { runs: [run('newest', 0, 90, [])], overflow: true, recordedBeforeNewest: true })
  assert.equal(status, 'blocked')
  assert.deepEqual(blockers, ['accounting-reconciliation:completeness-unevaluated'])
})

test('[o3d-6e4v] a history reader that FAILS is a blocker — there is no proof', async () => {
  const { status, blockers } = await verdict(newestRun(), new Error('connection reset'))
  assert.equal(status, 'blocked')
  assert.deepEqual(blockers, ['accounting-reconciliation:completeness-unevaluated'])
})

// ---------------------------------------------------------------------------------------------------
// No run, stale run, clean run.
// ---------------------------------------------------------------------------------------------------

test('[o3d-6e4v] no run at all is not ready', async () => {
  const { status, warnings } = await verdict(null)
  assert.equal(status, 'warning')
  assert.deepEqual(warnings, ['accounting-reconciliation:missing'])
})

test(`[o3d-6e4v] a run older than ${ROLLOUT_RECONCILIATION_MAX_AGE_DAYS} days is not ready; exactly that old still is`, async () => {
  const atLimit = newestRun({ createdAt: iso(ROLLOUT_RECONCILIATION_MAX_AGE_DAYS), toDate: iso(ROLLOUT_RECONCILIATION_MAX_AGE_DAYS) })
  assert.equal((await verdict(atLimit)).status, 'ready')
  const stale = newestRun({ createdAt: iso(ROLLOUT_RECONCILIATION_MAX_AGE_DAYS + 0.01), toDate: iso(ROLLOUT_RECONCILIATION_MAX_AGE_DAYS + 0.01) })
  const { status, warnings } = await verdict(stale)
  assert.equal(status, 'warning')
  assert.deepEqual(warnings, ['accounting-reconciliation:stale'])
})

test('[o3d-6e4v] CONTROL: a recent, recorded-complete run with nothing unresolved behind it is READY', async () => {
  const { status, blockers, warnings, report } = await verdict(newestRun())
  assert.deepEqual([status, blockers, warnings], ['ready', [], []])
  assert.deepEqual(report.checks.accountingReconciliationProof, { state: 'proven' })
})

test('[o3d-6e4v] interval union: touching intervals compose, a gap does not, order does not matter', () => {
  const t = { from: 0, to: 100 }
  assert.equal(unionContains(t, [{ from: 50, to: 100 }, { from: 0, to: 50 }]), true)
  assert.equal(unionContains(t, [{ from: 0, to: 49 }, { from: 50, to: 100 }]), false)
  assert.equal(unionContains(t, [{ from: -10, to: 200 }]), true)
  assert.equal(unionContains(t, []), false)
})

/** The existing suite's all-clean health, copied so this file's verdicts are the reconciliation's alone. */
function cleanHealth(): AdminHealthResponse {
  return createAdminHealth()
}

function createAdminHealth(overrides: Partial<AdminHealthResponse> = {}): AdminHealthResponse {
  return {
    ok: true,
    status: 'ok',
    checkedAt: NOW.toISOString(),
    app: {
      version: '1.5.0',
      commitSha: 'abc1234',
    },
    checks: {
      database: okCheck(),
      migrations: okLatest('applied'),
      writableDirectories: [
        {
          label: 'backups',
          writable: true,
          ...okCheck(),
        },
      ],
      latestBackup: okLatest('available'),
      latestAccountingBatch: okLatest('SYNCED'),
      latestWooCommerceSync: okLatest('SYNCED'),
      latestFxSync: okLatest('synced'),
      integrationOutbox: okCheck({
        pending: 0,
        retryableFailed: 0,
        permanentFailed: 0,
        processing: 0,
      }),
      latestInvariantCheck: {
        ...okLatest('completed'),
        criticalCount: 0,
        countShape: 'exact',
        details: { criticalCount: 0, countShape: 'exact' },
      },
      latestWmsStockSync: okLatest('SUCCEEDED'),
      mintsoftWebhookQueue: okCheck({
        pending: 0,
        pendingRetry: 0,
        failedRetry: 0,
        requiresReview: 0,
        dead: 0,
      }),
      accountingEvents: okCheck({
        pending: 0,
        failed: 0,
      }),
      cronFreshness: {
        ...okCheck({ warningCount: 0 }),
        jobs: {
          'invariant-check': {
            status: 'ok',
            lastRunAt: NOW.toISOString(),
            lastStatus: 'completed',
            ageMs: 0,
            staleAfterMs: 129600000,
            schedule: '0 4 * * *',
          },
        },
      },
      fileScanner: okCheck({
        scanMode: 'disabled',
        scanStatus: 'skipped',
        scanReason: 'disabled',
        scanScannerId: null,
      }),
    },
    ...overrides,
  }
}

function okCheck(details?: Record<string, string | number | boolean | null>) {
  return {
    status: 'ok' as HealthLevel,
    checkedAt: NOW.toISOString(),
    details,
  }
}

function okLatest(lastStatus: string) {
  return {
    ...okCheck(),
    lastRunAt: NOW.toISOString(),
    lastStatus,
    reference: 'ok-ref',
  }
}
