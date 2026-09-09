import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
  readReconciliationCompleteness,
  readReconciliationRunProof,
  reconciliationLookbackDate,
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

  // WHAT AN AUTOMATED ROLLOUT ACTUALLY SEES, AND WHAT r6 GOT WRONG ABOUT IT. The handler answers 412
  // for anything that is not `ready`, so this does stop a deploy by default. r6 then called
  // `allowWarnings=true` "an explicit, recorded override" and rested the whole warn-not-block choice
  // on it. It records NOTHING — no reason, no named findings, no actor, no audit row — and it
  // accepts every warning in the verdict at once (o3d-yby2). This state stays a warning anyway,
  // because a NULL column is what EVERY row holds on the deploy that ships the column and a gate
  // that cannot go green on a correct deploy gets routed around. The two completeness states that
  // are NOT expected on a correct deploy are blockers instead; see the two tests below.
  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const blocked = await handler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  assert.equal(blocked.status, 412, 'unknown completeness fails the gate by default')
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(overridden.status, 200,
    'and this state — and only this state — remains gettable past by the unrecorded global flag')
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

/**
 * o3d-11rf r7 (Codex r6, HIGH) — A TRUNCATED REPORT IS NOT OVERRIDABLE.
 *
 * r6 made this a WARNING and justified it with the claim that `?allowWarnings=true` is "an explicit,
 * recorded override". It records nothing: no reason, no named findings, no actor, no audit row, and
 * it converts EVERY warning-only verdict at once. So the state that says "the reconciliation report
 * you are about to deploy on omitted findings" could be waved past by a caller who was overriding
 * something else entirely, and nothing would say so afterwards.
 *
 * The decisive assertion is the last one, and it is made THROUGH THE HANDLER. A test that stopped at
 * `report.status` would pass against the r6 code as soon as it was rewritten to expect `warning`;
 * only the HTTP answer with the override set distinguishes "stops a deploy" from "stops a deploy
 * unless anyone asks it not to".
 */
test('o3d-11rf r7: a run that recorded a truncation blocks the gate, and the override does not get past it', async () => {
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

  assert.equal(report.status, 'blocked')
  assert.equal(report.ok, false)
  const blocker = report.blockers.find((finding) => finding.id === 'accounting-reconciliation:truncated')
  assert(blocker, 'named as a truncation rather than folded into the generic warnings count')
  assert.equal(blocker?.severity, 'blocker')
  assert.deepEqual(blocker?.details?.codes, ['void_mirror_basis_unknown_contradictions_truncated'])
  assert.equal(
    report.warnings.some((finding) => finding.id === 'accounting-reconciliation:truncated'),
    false,
    'and it is not ALSO a warning, which is the severity the override can reach',
  )

  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const blocked = await handler(new Request('https://ims.example.test/api/admin/rollout-readiness'))
  assert.equal(blocked.status, 412)
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(overridden.status, 412, 'THE POINT: no query flag turns an incomplete report into a green deploy')
})

test('o3d-11rf r7: completeness is classified even when the run status returns early', async () => {
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

/**
 * o3d-11rf r7 — AN UNREADABLE COMPLETENESS PAYLOAD BLOCKS, BECAUSE NOTHING CAN WRITE ONE.
 *
 * `persistAccountingReconciliationReport` is the only writer of this column and it always writes an
 * array of `{code, message}` sentinels. A value that is neither NULL nor such an array therefore did
 * not come from this codebase: it is corruption, or a writer nobody has explained. Unlike a NULL —
 * which every row in the table holds on the deploy that ships the column — there is no correct
 * deploy on which this is expected, so blocking it can never make the gate unsatisfiable.
 */
test('o3d-11rf r7: a completeness payload the reader cannot parse blocks the gate, override or not', async () => {
  const unreadable = readReconciliationCompleteness({ truncated: true })
  assert(unreadable.state === 'unknown' && unreadable.reason === 'unreadable',
    'the premise: a payload that is neither NULL nor a sentinel array is unreadable, not complete')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(unreadable),
  }))

  assert.equal(report.status, 'blocked', 'a shape we cannot read proves nothing about completeness')
  const blocker = report.blockers.find((finding) => finding.id === 'accounting-reconciliation:completeness-unreadable')
  assert(blocker, 'and it is reported apart from the run that merely never said')
  assert.equal(blocker?.details?.reason, 'unreadable')

  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(overridden.status, 412, 'no query flag reads an unreadable payload as a complete one')
})

/**
 * o3d-11rf r8 (Codex r7, HIGH) — A RUN THAT LOOKED AT LESS CANNOT CLEAR WHAT A WIDER RUN FOUND.
 *
 * The gate reads the newest terminal run. `truncations: []` from a one-day run is TRUE about that
 * day and says nothing about the 90 the previous run could not finish, so the gate may not read it as
 * proof. The full sequence — truncated wide run, then clean narrow run — is proved against PostgreSQL
 * in tests/db/rollout-readiness-run-completeness.test.ts, because only there is the run actually the
 * newest row; here the subject is the classification and the severity.
 */
test('o3d-11rf r8: a clean run narrower than the default scope blocks the gate, override or not', async () => {
  const narrowScope = {
    fromDate: reconciliationLookbackDate(1, FIXED_DATE).toISOString(),
    toDate: FIXED_DATE.toISOString(),
  }

  // THE PREMISE, STATED SO THE TEST CANNOT PASS FOR THE WRONG REASON. By the per-run reading — the
  // one the runs list shows — this run IS complete. Everything below is about the gate reading it as
  // proof of something wider.
  const perRun = readReconciliationCompleteness([])
  assert.equal(perRun.state, 'complete')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: createReconciliationRun(
      readReconciliationRunProof({ truncations: [], ...narrowScope }),
      narrowScope,
    ),
  }))

  assert.equal(report.status, 'blocked')
  const blocker = report.blockers.find((finding) => finding.id === 'accounting-reconciliation:completeness-scope')
  assert(blocker, 'the gate names the scope, not merely "not complete"')
  assert.equal(blocker?.details?.reason, 'scope-not-proven')
  assert.equal(blocker?.details?.fromDate, narrowScope.fromDate)
  assert.equal(blocker?.details?.toDate, narrowScope.toDate)
  assert.equal(blocker?.details?.defaultLookbackDays, DEFAULT_RECONCILIATION_LOOKBACK_DAYS)
  assert.match(String(blocker?.message), /lookbackDays/,
    'and says how to clear it, which is the same remedy as the other completeness blockers')

  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(overridden.status, 412,
    'a warning here would leave the bypass intact: POST a one-day run, then wave the warning through')
})

test('o3d-11rf r8: the same run at the default scope is ready, so the block is about the window and nothing else', async () => {
  const defaultScopedRun = createReconciliationRun(
    readReconciliationRunProof({
      truncations: [],
      fromDate: reconciliationLookbackDate(DEFAULT_RECONCILIATION_LOOKBACK_DAYS, FIXED_DATE),
      toDate: FIXED_DATE,
    }),
  )
  assert.equal(defaultScopedRun.completeness.state, 'complete')

  const report = await collectRolloutReadiness(createAdapters({
    latestAccountingReconciliationRun: defaultScopedRun,
  }))
  assert.equal(report.status, 'ready', 'the gate is still satisfiable by a run the endpoint makes by default')
  assert.deepEqual(report.blockers, [])
})

/**
 * o3d-11rf r7 (Codex r6, the test it asked for by name) — AN OVERRIDE RAISED FOR ONE WARNING CANNOT
 * SUPPRESS RECONCILIATION INCOMPLETENESS.
 *
 * `allowWarnings` is a single global boolean over the whole verdict, so the caller who sets it to get
 * past a trusted-proxy advisory is not told, and cannot be told, that they also accepted a
 * reconciliation report with findings missing from it. Severity is the only thing separating the two,
 * which is why the incompleteness has to be a BLOCKER rather than a better-worded warning.
 */
test('o3d-11rf r7: an override raised for an unrelated advisory warning cannot suppress an incomplete reconciliation report', async () => {
  const report = await collectRolloutReadiness(createAdapters({
    preflight: createPreflight([
      { id: 'trusted-proxy', name: 'TRUSTED_PROXY_CIDRS', status: 'warn', message: 'Trusted proxy CIDRs are not configured.' },
    ]),
    latestAccountingReconciliationRun: createReconciliationRun(readReconciliationCompleteness([
      { code: 'reconciliation_row_cap_reached', message: 'salesOrders scan hit the 10,000 row cap', details: { dataset: 'salesOrders' } },
    ])),
  }))

  // THE OVERRIDE HAS SOMETHING REAL TO ACT ON. Without this the test could pass on a report that
  // simply had no overridable warning in it, which is not the situation being guarded against.
  assert.equal(
    report.warnings.some((finding) => finding.id === 'preflight:trusted-proxy'),
    true,
    'the advisory warning a caller would legitimately be overriding is present',
  )
  assert.equal(report.status, 'blocked')

  const handler = createRolloutReadinessHandler({
    authorize: async () => null,
    collect: async () => report,
  })
  const overridden = await handler(
    new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'),
  )
  assert.equal(
    overridden.status,
    412,
    'accepting the advisory warning does not silently accept the incomplete report alongside it',
  )
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

/**
 * o3d-11rf r8: the default window this helper hands out is the one a reconciliation run makes for
 * itself when nobody asks for a scope, computed with the production function rather than typed out —
 * so a run that is clean in every OTHER respect is clean in this one too, and the tests below that
 * narrow it are narrowing it away from the real default.
 */
function defaultScope(toDate: Date = FIXED_DATE): { fromDate: string; toDate: string } {
  return {
    fromDate: reconciliationLookbackDate(DEFAULT_RECONCILIATION_LOOKBACK_DAYS, toDate).toISOString(),
    toDate: toDate.toISOString(),
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
    ...defaultScope(),
    completeness,
    ...overrides,
  }
}

const PROVEN_COMPLETE: AccountingReconciliationCompleteness = { state: 'complete', truncations: [] }
