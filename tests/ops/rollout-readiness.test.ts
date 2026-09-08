import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readReconciliationCompleteness,
  type AccountingReconciliationCompleteness,
} from '../../lib/domain/accounting/reconciliation.ts'
import {
  clearRolloutReadinessCache,
  collectCachedRolloutReadiness,
  collectRolloutReadiness,
  createRolloutReadinessHandler,
  type LatestAccountingReconciliationRun,
  type RolloutReadinessAdapters,
} from '../../lib/ops/rollout-readiness.ts'
import {
  type AdminHealthResponse,
  type HealthLevel,
  buildAccountingEventsHealth,
  buildIntegrationOutboxHealth,
  buildMintsoftWebhookQueueHealth,
} from '../../lib/ops/health.ts'
import type { PreflightCheck, PreflightResult } from '../../scripts/preflight-production.ts'
import { createAdminHealth, createPreflight } from '../../tests/fixtures/rollout-readiness.ts'

const FIXED_DATE = new Date('2026-05-01T10:00:00.000Z')

test('rollout readiness handler returns auth response before collecting diagnostics', async () => {
  let collected = false
  const handler = createRolloutReadinessHandler({
    authorize: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    collect: async () => {
      collected = true
      return collectRolloutReadiness(createAdapters())
    },
  })

  const response = await handler()
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.deepEqual(body, { error: 'Unauthorized' })
  assert.equal(collected, false)
})

test('rollout readiness reports ready when all rollout signals are clean', async () => {
  const report = await collectRolloutReadiness(createAdapters())

  assert.equal(report.ok, true)
  assert.equal(report.status, 'ready')
  assert.deepEqual(report.blockers, [])
  assert.deepEqual(report.warnings, [])
  assert.equal(report.checks.preflight.status, 'pass')
  assert.equal(report.checks.latestAccountingReconciliationRun?.status, 'COMPLETED')
})

/**
 * o3d-11rf r6 (Codex r5, HIGH) — THE GATE THAT READ "NOBODY CHECKED" AS "NOTHING WRONG".
 *
 * r5 gave the run row a completeness column whose whole purpose is the distinction between `[]`
 * ("recorded, nothing was truncated") and NULL ("nobody recorded this"). This gate — the one asked
 * BEFORE a deploy whether it is safe to proceed — did not select the column, and classified any
 * COMPLETED run with zero warnings and zero criticals as clean. A run written by the predecessor
 * binary still serving across the deploy is exactly such a run, so the check that this branch adds
 * could report `ready` having never run.
 *
 * These go through `collectRolloutReadiness` and the HTTP handler, not through the classifier
 * directly, because "does it read as clean" is a question about the gate's answer and not about any
 * one function inside it. The completeness values are produced by `readReconciliationCompleteness`
 * on the raw values a row can actually hold — `null`, `[]` — rather than written out as union
 * literals, so the test agrees with the reading the query performs rather than with itself.
 */
test('o3d-11rf r6: a run that never recorded its completeness does not read as ready at the rollout gate', async () => {
  const unknown = readReconciliationCompleteness(null)
  assert.equal(unknown.state, 'unknown', 'the premise: a NULL column is unknown completeness')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(unknown),
  }))

  // The run is COMPLETED with zero warnings and zero criticals — clean by every OTHER signal the
  // gate reads. Only the unrecorded completeness stands between it and a green light.
  assert.equal(report.checks.latestAccountingReconciliationRun?.status, 'COMPLETED')
  assert.equal(report.checks.latestAccountingReconciliationRun?.warningCount, 0)
  assert.equal(report.checks.latestAccountingReconciliationRun?.criticalCount, 0)

  assert.equal(report.status, 'warning', 'and it is not ready')
  assert.equal(report.ok, false)
  const warning = report.warnings.find((finding) => finding.id === 'accounting-reconciliation:completeness-unknown')
  assert(warning, 'the gate says which claim is missing, not merely that something is off')
  assert.equal(warning?.details?.reason, 'not-recorded')
  assert.match(String(warning?.message), /reconciliation again/i, 'and what to do about it')

  // WHAT AN AUTOMATED ROLLOUT ACTUALLY SEES. A warning is not advisory here: the handler answers 412
  // for anything that is not `ready`, so this stops a deploy unless a human passes allowWarnings.
  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const blocked = await handler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  assert.equal(blocked.status, 412, 'unknown completeness fails the gate by default')
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(overridden.status, 200, 'and can only be got past by an explicit override')
})

test('o3d-11rf r6: a run that recorded [] IS clean, so the warning is about the missing claim and not about the column', async () => {
  const complete = readReconciliationCompleteness([])
  assert.equal(complete.state, 'complete', 'the premise: an empty array is proven completeness')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(complete),
  }))

  assert.equal(report.status, 'ready')
  assert.equal(report.ok, true)
  assert.deepEqual(report.warnings, [], 'a run that proved itself complete raises nothing')
})

test('o3d-11rf r6: a run that recorded a truncation is reported as incomplete, by code', async () => {
  const truncated = readReconciliationCompleteness([
    {
      code: 'void_mirror_basis_unknown_contradictions_truncated',
      message: '917 contradictions found, 500 reported',
      details: { reported: 500, total: 917 },
    },
  ])
  assert.equal(truncated.state, 'truncated', 'the premise')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(truncated),
  }))

  assert.equal(report.status, 'warning')
  const warning = report.warnings.find((finding) => finding.id === 'accounting-reconciliation:truncated')
  assert(warning, 'named as a truncation rather than folded into the generic warnings count')
  assert.deepEqual(warning?.details?.codes, ['void_mirror_basis_unknown_contradictions_truncated'])
})

test('o3d-11rf r6: completeness is classified even when the run status returns early', async () => {
  // EVERY BRANCH OF THE STATUS SWITCH RETURNS. A completeness check placed after it would be skipped
  // for a FAILED or PARTIAL run — and PARTIAL is precisely a run whose completeness is in question.
  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(readReconciliationCompleteness(null), {
      status: 'PARTIAL',
    }),
  }))

  const ids = new Set(report.warnings.map((finding) => finding.id))
  assert.equal(ids.has('accounting-reconciliation:partial'), true, 'the status is still classified')
  assert.equal(ids.has('accounting-reconciliation:completeness-unknown'), true, 'and so is the completeness')
})

test('o3d-11rf r6: a completeness payload the reader cannot parse is unknown, never clean', async () => {
  const unreadable = readReconciliationCompleteness({ truncated: true })
  assert.equal(unreadable.state, 'unknown')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(unreadable),
  }))

  assert.equal(report.status, 'warning', 'a shape we cannot read proves nothing about completeness')
  const warning = report.warnings.find((finding) => finding.id === 'accounting-reconciliation:completeness-unknown')
  assert.equal(warning?.details?.reason, 'unreadable')
})

test('rollout readiness reports warnings without blocking rollout', async () => {
  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'trusted-proxy', name: 'TRUSTED_PROXY_CIDRS', status: 'warn', message: 'Trusted proxy CIDRs are not configured.' },
    ]),
    adminHealth: createAdminHealth({
      status: 'degraded',
      ok: false,
      checks: {
        ...createAdminHealth().checks,
        cronFreshness: {
          status: 'warning',
          checkedAt: FIXED_DATE.toISOString(),
          message: 'One or more cron jobs are stale or failed',
          details: { warningCount: 1 },
          jobs: {
            'activity-cleanup': {
              status: 'warning',
              lastRunAt: null,
              lastStatus: null,
              ageMs: null,
              staleAfterMs: 129600000,
              schedule: '0 4 * * *',
            },
          },
        },
      },
    }),
    latestAccountingReconciliationRun: null,
  }))

  assert.equal(report.ok, false)
  assert.equal(report.status, 'warning')
  assert.deepEqual(report.blockers, [])
  assert(report.warnings.some((finding) => finding.id === 'preflight:trusted-proxy'))
  assert(report.warnings.some((finding) => finding.id === 'cron-freshness:activity-cleanup'))
  assert(report.warnings.some((finding) => finding.id === 'accounting-reconciliation:missing'))
})

test('rollout readiness reports blockers for active P0 rollout conditions', async () => {
  const health = createAdminHealth({
    status: 'down',
    ok: false,
    checks: {
      ...createAdminHealth().checks,
      database: {
        status: 'error',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Database connectivity check failed',
      },
      writableDirectories: [
        {
          label: 'backups',
          writable: false,
          status: 'error',
          checkedAt: FIXED_DATE.toISOString(),
          message: 'Directory is not writable',
        },
      ],
      latestBackup: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: null,
        lastStatus: null,
        reference: null,
        message: 'No backup files found',
      },
      latestInvariantCheck: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        lastRunAt: FIXED_DATE.toISOString(),
        lastStatus: 'critical_findings',
        reference: 'invariant-run-1',
        criticalCount: 2,
        countShape: 'exact',
        message: 'Latest invariant check reported critical findings',
        details: { criticalCount: 2, countShape: 'exact' },
      },
      integrationOutbox: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Integration outbox requires attention',
        details: {
          pending: 0,
          retryableFailed: 0,
          permanentFailed: 1,
          processing: 0,
        },
      },
      mintsoftWebhookQueue: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Mintsoft webhook queue requires attention',
        details: {
          pending: 0,
          pendingRetry: 0,
          failedRetry: 0,
          requiresReview: 0,
          dead: 1,
        },
      },
      accountingEvents: {
        status: 'warning',
        checkedAt: FIXED_DATE.toISOString(),
        message: 'Accounting events have failed rows',
        details: {
          pending: 0,
          failed: 1,
        },
      },
    },
  })

  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'auth-secret', name: 'AUTH_SECRET/NEXTAUTH_SECRET', status: 'fail', message: 'Auth secret is missing.' },
    ]),
    adminHealth: health,
    latestAccountingReconciliationRun: createReconciliationRun(PROVEN_COMPLETE, {
      status: 'FAILED',
      totalCount: 10,
    }),
  }))

  assert.equal(report.ok, false)
  assert.equal(report.status, 'blocked')
  const blockerIds = new Set(report.blockers.map((finding) => finding.id))
  const expectedBlockerIds = [
    'preflight:auth-secret',
    'admin-health:down',
    'database',
    'storage-path:backups',
    'latest-backup:missing',
    'latest-invariant-check:critical',
    'integration-outbox:permanent-failed',
    'wms-webhook-queue:dead',
    'accounting-events:failed',
    'accounting-reconciliation:failed',
  ]
  assert.equal(blockerIds.size, expectedBlockerIds.length)
  for (const expectedId of expectedBlockerIds) {
    assert.equal(blockerIds.has(expectedId), true, `expected blocker ${expectedId}`)
  }
})

test('rollout readiness handler uses precondition-failed for blocked and warning rollout by default', async () => {
  const readyHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters()),
  })
  const warningHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters({
      latestAccountingReconciliationRun: null,
    })),
  })
  const blockedHandler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => collectRolloutReadiness(createAdapters({
      preflight: createPreflight([
        { id: 'database-url', name: 'DATABASE_URL', status: 'fail', message: 'DATABASE_URL is required in production.' },
      ]),
    })),
  })

  const ready = await readyHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  const warning = await warningHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  const warningAllowed = await warningHandler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  const blocked = await blockedHandler(new Request('https://ims.example.test/api/admin/rollout-readiness'))

  assert.equal(ready.status, 200)
  assert.equal(ready.headers.get('Cache-Control'), 'no-store')
  assert.equal(warning.status, 412)
  assert.equal(warningAllowed.status, 200)
  assert.equal(blocked.status, 412)
})

test('rollout readiness response does not expose raw secret values', async () => {
  const databaseUrl = 'postgres://user:password@example.test/ims'
  const jwtToken = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiJhZG1pbiJ9',
    'abcdefghi0123456789',
  ].join('.')
  const settingsKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'
  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'auth-secret', name: 'AUTH_SECRET/NEXTAUTH_SECRET', status: 'fail', message: `Auth secret leaked ${settingsKey}.` },
      { id: 'database-url', name: 'DATABASE_URL', status: 'fail', message: `DATABASE_URL leaked ${databaseUrl}.` },
    ]),
    adminHealth: createAdminHealth({
      checks: {
        ...createAdminHealth().checks,
        integrationOutbox: {
          status: 'warning',
          checkedAt: FIXED_DATE.toISOString(),
          message: `Connector token leaked ${jwtToken}`,
          details: {
            permanentFailed: 1,
            apiToken: jwtToken,
            databaseUrl,
            settingsEncryptionKey: settingsKey,
          },
        },
      },
    }),
  }))

  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes(databaseUrl), false)
  assert.equal(serialized.includes(jwtToken), false)
  assert.equal(serialized.includes(settingsKey), false)
})

test('rollout readiness times out hanging adapters and caches successful reports briefly', async () => {
  clearRolloutReadinessCache()
  let preflightCalls = 0
  const adapters = createAdapters({
    preflight: undefined,
  })
  adapters.runPreflight = async () => {
    preflightCalls += 1
    return createPreflight()
  }

  const first = await collectCachedRolloutReadiness(adapters, { cacheTtlMs: 30_000 })
  const second = await collectCachedRolloutReadiness(adapters, { cacheTtlMs: 30_000 })

  assert.equal(first.cache.hit, false)
  assert.equal(second.cache.hit, true)
  assert.equal(preflightCalls, 1)

  const timedOut = await collectRolloutReadiness({
    ...createAdapters(),
    runPreflight: async () => new Promise<PreflightResult>(() => {}),
  }, { timeoutMs: 1 })

  assert.equal(timedOut.status, 'blocked')
  assert(timedOut.blockers.some((finding) => finding.id === 'preflight:rollout-readiness-preflight'))
})

test('rollout readiness locks health detail field contracts used for blocker classification', () => {
  const outbox = buildIntegrationOutboxHealth({
    pending: 0,
    retryableFailed: 0,
    permanentFailed: 1,
    processing: 0,
    now: FIXED_DATE,
  })
  const webhooks = buildMintsoftWebhookQueueHealth({
    pending: 0,
    pendingRetry: 0,
    failedRetry: 0,
    requiresReview: 0,
    dead: 1,
    now: FIXED_DATE,
  })
  const accountingEvents = buildAccountingEventsHealth({
    pending: 0,
    failed: 1,
    now: FIXED_DATE,
  })

  assert.equal(typeof outbox.details?.permanentFailed, 'number')
  assert.equal(typeof webhooks.details?.dead, 'number')
  assert.equal(typeof accountingEvents.details?.failed, 'number')
})

function createAdapters(overrides: {
  preflight?: PreflightResult
  adminHealth?: AdminHealthResponse
  latestAccountingReconciliationRun?: LatestAccountingReconciliationRun | null
} = {}): RolloutReadinessAdapters {
  return {
    now: () => FIXED_DATE,
    runPreflight: async () => overrides.preflight ?? createPreflight(),
    collectAdminHealth: async () => overrides.adminHealth ?? createAdminHealth(),
    latestAccountingReconciliationRun: async () =>
      overrides.latestAccountingReconciliationRun === undefined
        ? createReconciliationRun(PROVEN_COMPLETE)
        : overrides.latestAccountingReconciliationRun,
  }
}

function createReconciliationRun(
  completeness: AccountingReconciliationCompleteness,
  overrides: Partial<LatestAccountingReconciliationRun> = {},
): LatestAccountingReconciliationRun {
  return {
    id: 'recon-1',
    status: 'COMPLETED',
    totalCount: 0,
    warningCount: 0,
    criticalCount: 0,
    createdAt: FIXED_DATE.toISOString(),
    completeness,
    ...overrides,
  }
}

const PROVEN_COMPLETE: AccountingReconciliationCompleteness = { state: 'complete', truncations: [] }
