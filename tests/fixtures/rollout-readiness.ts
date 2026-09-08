/**
 * o3d-11rf r6 — the clean rollout-readiness doubles, shared by the in-memory suite in
 * tests/ops/rollout-readiness.test.ts and the database-backed one in
 * tests/db/rollout-readiness-run-completeness.test.ts.
 *
 * They live here because the DB suite needs the SAME "everything else is fine" baseline the unit
 * suite uses. Its subject is whether a real run row read out of PostgreSQL can produce a `ready`
 * verdict, and that verdict is only meaningful if every other signal the gate reads is clean. A
 * second, drifting copy of these doubles would let the DB suite go green against a baseline the
 * unit suite would call blocked.
 */
import type { AdminHealthResponse, HealthLevel } from '../../lib/ops/health.ts'
import type { PreflightCheck, PreflightResult } from '../../scripts/preflight-production.ts'

export const READINESS_FIXED_DATE = new Date('2026-05-01T10:00:00.000Z')
const FIXED_DATE = READINESS_FIXED_DATE

export function createPreflight(checks: PreflightCheck[] = [
  { id: 'node-env', name: 'NODE_ENV', status: 'pass', message: 'NODE_ENV is production.' },
]): PreflightResult {
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}

/**
 * o3d-11rf r6: `completeness` has no default. A run that did not say whether it was complete is a
 * DIFFERENT run from one that said it was, and a fixture allowed to omit the field would be the same
 * conflation the gate was fixed for, moved into the test harness.
 */

export function createAdminHealth(overrides: Partial<AdminHealthResponse> = {}): AdminHealthResponse {
  return {
    ok: true,
    status: 'ok',
    checkedAt: FIXED_DATE.toISOString(),
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
            lastRunAt: FIXED_DATE.toISOString(),
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
    checkedAt: FIXED_DATE.toISOString(),
    details,
  }
}

function okLatest(lastStatus: string) {
  return {
    ...okCheck(),
    lastRunAt: FIXED_DATE.toISOString(),
    lastStatus,
    reference: 'ok-ref',
  }
}
