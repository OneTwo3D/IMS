import { runInvariantCheckPreflight } from '@/lib/cron/invariant-check-preflight'
import type { ScheduledInvariantCriticalFinding } from '@/lib/cron/invariant-check'
import { db } from '@/lib/db'

const MAX_PRINTED_CRITICAL_FINDINGS = 20
const DISCONNECT_TIMEOUT_MS = 5_000

async function disconnectDb(): Promise<void> {
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

function formatCriticalFinding(finding: ScheduledInvariantCriticalFinding): string {
  const reference = findingReference(finding)
  return `${finding.domain}:${finding.code}${reference ? ` (${reference})` : ''} - ${finding.message}`
}

async function main(): Promise<void> {
  const preflight = await runInvariantCheckPreflight()
  const { result } = preflight

  console.log(
    `Invariant preflight summary: status=${result.status}, total=${result.summary.total.total}, critical=${result.summary.total.critical}, warning=${result.summary.total.warning}, info=${result.summary.total.info}`,
  )

  if (preflight.ok) {
    console.log('Invariant preflight passed: no critical findings.')
    return
  }

  if (preflight.failure === 'report_failed') {
    console.error('Invariant preflight failed: one or more invariant reports did not complete.')
    for (const error of result.errors) {
      console.error(`- ${error.domain}: ${error.message}`)
    }
  } else {
    console.error('Invariant preflight failed: critical invariant findings exist.')
    for (const finding of result.criticalFindings.slice(0, MAX_PRINTED_CRITICAL_FINDINGS)) {
      console.error(`- ${formatCriticalFinding(finding)}`)
    }
    const omittedCount = result.criticalFindings.length - MAX_PRINTED_CRITICAL_FINDINGS
    if (omittedCount > 0) {
      console.error(`... ${omittedCount} more critical finding(s) omitted`)
    }
  }

  console.error(
    'Remediation: inspect the invariant finding code/details, repair the underlying data or writer bug, and rerun npm run invariant-check:preflight.',
  )
  process.exitCode = 1
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error && error.message ? error.message : String(error)
    console.error(`Invariant preflight failed before report completion: ${message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDb()
    process.exit(process.exitCode ?? 0)
  })
