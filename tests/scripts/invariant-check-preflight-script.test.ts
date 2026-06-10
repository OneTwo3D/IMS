import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatCriticalFinding,
  runInvariantCheckPreflightCli,
} from '@/scripts/invariant-check-preflight'
import type { InvariantCheckPreflightResult } from '@/lib/cron/invariant-check-preflight'
import type {
  ScheduledInvariantCheckResult,
  ScheduledInvariantCriticalFinding,
} from '@/lib/cron/invariant-check'

function emptySummary() {
  return {
    total: 0,
    info: 0,
    warning: 0,
    critical: 0,
  }
}

function scheduledResult(
  overrides: Partial<ScheduledInvariantCheckResult> = {},
): ScheduledInvariantCheckResult {
  const summary = {
    total: emptySummary(),
    inventory: emptySummary(),
    accounting: emptySummary(),
    sales: emptySummary(),
    ...overrides.summary,
  }

  return {
    runId: 'preflight-script-test',
    checkedAt: '2026-06-10T00:00:00.000Z',
    status: 'completed',
    summary,
    errors: [],
    criticalFindings: [],
    reports: {
      inventory: null,
      accounting: null,
      sales: null,
    },
    ...overrides,
  }
}

function preflightResult(
  overrides: Partial<InvariantCheckPreflightResult> = {},
): InvariantCheckPreflightResult {
  const result = overrides.result ?? scheduledResult()
  return {
    ok: true,
    failure: null,
    result,
    ...overrides,
  }
}

function captureLogs() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    logger: {
      stdout: { log: (message: string) => stdout.push(message) },
      stderr: { error: (message: string) => stderr.push(message) },
    },
  }
}

function criticalFinding(
  overrides: Partial<ScheduledInvariantCriticalFinding> = {},
): ScheduledInvariantCriticalFinding {
  return {
    domain: 'inventory',
    code: 'stock_reserved_source_mismatch',
    message: 'Reserved quantity does not match known reservation sources',
    details: { reservedQty: '1', knownReservedQty: '0' },
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    ...overrides,
  }
}

test('formatCriticalFinding includes entity references', () => {
  assert.equal(
    formatCriticalFinding(criticalFinding()),
    'inventory:stock_reserved_source_mismatch (product=product-1, warehouse=warehouse-1) - Reserved quantity does not match known reservation sources',
  )
})

test('runInvariantCheckPreflightCli exits 0 and prints pass output on clean preflight', async () => {
  const logs = captureLogs()
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => preflightResult(),
    stdout: logs.logger.stdout,
    stderr: logs.logger.stderr,
    disconnect: async () => {},
  })

  assert.equal(exitCode, 0)
  assert.match(logs.stdout.join('\n'), /Invariant preflight summary: status=completed/)
  assert.match(logs.stdout.join('\n'), /Invariant preflight passed/)
  assert.deepEqual(logs.stderr, [])
})

test('runInvariantCheckPreflightCli exits 1 and prints critical findings', async () => {
  const finding = criticalFinding()
  const logs = captureLogs()
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => preflightResult({
      ok: false,
      failure: 'critical_findings',
      result: scheduledResult({
        summary: {
          total: { total: 1, info: 0, warning: 0, critical: 1 },
          inventory: { total: 1, info: 0, warning: 0, critical: 1 },
          accounting: emptySummary(),
          sales: emptySummary(),
        },
        criticalFindings: [finding],
      }),
    }),
    stdout: logs.logger.stdout,
    stderr: logs.logger.stderr,
    disconnect: async () => {},
  })

  assert.equal(exitCode, 1)
  assert.match(logs.stderr.join('\n'), /critical invariant findings exist/)
  assert.match(logs.stderr.join('\n'), /stock_reserved_source_mismatch/)
  assert.match(logs.stderr.join('\n'), /Remediation:/)
})

test('runInvariantCheckPreflightCli exits 1 and prints report errors', async () => {
  const logs = captureLogs()
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => preflightResult({
      ok: false,
      failure: 'report_failed',
      result: scheduledResult({
        status: 'partial_failure',
        errors: [{ domain: 'sales', message: 'sales invariant failed' }],
      }),
    }),
    stdout: logs.logger.stdout,
    stderr: logs.logger.stderr,
    disconnect: async () => {},
  })

  assert.equal(exitCode, 1)
  assert.match(logs.stderr.join('\n'), /one or more invariant reports did not complete/)
  assert.match(logs.stderr.join('\n'), /sales: sales invariant failed/)
})

test('runInvariantCheckPreflightCli truncates long critical-finding output', async () => {
  const findings = Array.from({ length: 22 }, (_, index) => criticalFinding({
    productId: `product-${index + 1}`,
  }))
  const logs = captureLogs()
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => preflightResult({
      ok: false,
      failure: 'critical_findings',
      result: scheduledResult({
        summary: {
          total: { total: 22, info: 0, warning: 0, critical: 22 },
          inventory: { total: 22, info: 0, warning: 0, critical: 22 },
          accounting: emptySummary(),
          sales: emptySummary(),
        },
        criticalFindings: findings,
      }),
    }),
    stdout: logs.logger.stdout,
    stderr: logs.logger.stderr,
    disconnect: async () => {},
  })

  assert.equal(exitCode, 1)
  assert.match(logs.stderr.join('\n'), /2 more critical finding\(s\) omitted/)
  assert.doesNotMatch(logs.stderr.join('\n'), /product-21/)
})

test('runInvariantCheckPreflightCli exits 1 when preflight throws before report completion', async () => {
  const logs = captureLogs()
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => {
      throw new Error('database unavailable')
    },
    stdout: logs.logger.stdout,
    stderr: logs.logger.stderr,
    disconnect: async () => {},
  })

  assert.equal(exitCode, 1)
  assert.match(logs.stderr.join('\n'), /failed before report completion: database unavailable/)
})
