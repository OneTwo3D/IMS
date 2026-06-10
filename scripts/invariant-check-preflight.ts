import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { runInvariantCheckPreflight } from '@/lib/cron/invariant-check-preflight'
import type { InvariantCheckPreflightResult } from '@/lib/cron/invariant-check-preflight'
import type { ScheduledInvariantCriticalFinding } from '@/lib/cron/invariant-check'

const MAX_PRINTED_CRITICAL_FINDINGS = 20
const DISCONNECT_TIMEOUT_MS = 5_000

type Logger = Pick<typeof console, 'log' | 'error'>

export type InvariantCheckPreflightCliOptions = {
  runPreflight?: () => Promise<InvariantCheckPreflightResult>
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
}

async function disconnectDb(): Promise<void> {
  const { db } = await import('@/lib/db')
  let timeout: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    db.$disconnect(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, DISCONNECT_TIMEOUT_MS)
      timeout.unref()
    }),
  ])
  if (timeout) clearTimeout(timeout)
}

function findingReference(finding: ScheduledInvariantCriticalFinding): string {
  return [
    finding.productId ? `product=${finding.productId}` : null,
    finding.warehouseId ? `warehouse=${finding.warehouseId}` : null,
    finding.orderId ? `order=${finding.orderId}` : null,
    finding.shipmentId ? `shipment=${finding.shipmentId}` : null,
    finding.refundId ? `refund=${finding.refundId}` : null,
    finding.syncLogId ? `syncLog=${finding.syncLogId}` : null,
  ].filter(Boolean).join(', ')
}

export function formatCriticalFinding(finding: ScheduledInvariantCriticalFinding): string {
  const reference = findingReference(finding)
  return `${finding.domain}:${finding.code}${reference ? ` (${reference})` : ''} - ${finding.message}`
}

function printPreflightResult(
  preflight: InvariantCheckPreflightResult,
  stdout: Pick<Logger, 'log'>,
  stderr: Pick<Logger, 'error'>,
): number {
  const { result } = preflight

  stdout.log(
    `Invariant preflight summary: status=${result.status}, total=${result.summary.total.total}, critical=${result.summary.total.critical}, warning=${result.summary.total.warning}, info=${result.summary.total.info}`,
  )

  if (preflight.ok) {
    stdout.log('Invariant preflight passed: no critical findings.')
    return 0
  }

  if (preflight.failure === 'report_failed') {
    stderr.error('Invariant preflight failed: one or more invariant reports did not complete.')
    for (const error of result.errors) {
      stderr.error(`- ${error.domain}: ${error.message}`)
    }
  } else {
    stderr.error('Invariant preflight failed: critical invariant findings exist.')
    for (const finding of result.criticalFindings.slice(0, MAX_PRINTED_CRITICAL_FINDINGS)) {
      stderr.error(`- ${formatCriticalFinding(finding)}`)
    }
    const omittedCount = result.criticalFindings.length - MAX_PRINTED_CRITICAL_FINDINGS
    if (omittedCount > 0) {
      stderr.error(`... ${omittedCount} more critical finding(s) omitted`)
    }
  }

  stderr.error(
    'Remediation: inspect the invariant finding code/details, repair the underlying data or writer bug, and rerun npm run invariant-check:preflight.',
  )
  return 1
}

export async function runInvariantCheckPreflightCli({
  runPreflight = runInvariantCheckPreflight,
  stdout = console,
  stderr = console,
  disconnect = disconnectDb,
}: InvariantCheckPreflightCliOptions = {}): Promise<number> {
  try {
    return printPreflightResult(await runPreflight(), stdout, stderr)
  } catch (error: unknown) {
    const message = error instanceof Error && error.message ? error.message : String(error)
    stderr.error(`Invariant preflight failed before report completion: ${message}`)
    return 1
  } finally {
    await disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runInvariantCheckPreflightCli()
    .then((exitCode) => {
      process.exit(exitCode)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : String(error)
      console.error(`Invariant preflight failed before report completion: ${message}`)
      process.exit(1)
    })
}
