import { logActivityPersisted } from '@/lib/activity-log'
import { buildWritersCheckReport, type WritersCheckReport } from '@/lib/ops/writers-check'
import { WRITERS_CHECK_RECORD_ACTION } from '@/lib/security/writers-check-constants'

/**
 * THE PERIODIC RECORD: run the check and keep its JSON in the activity log.
 *
 * Read-only toward every vendor (the check makes no call). The record is the report itself: counts, closed codes and map keys,
 * no order id, invoice number or other data key. A report that could not be kept is a FAILED run, so the schedule goes red
 * instead of leaving a gap that looks like silence.
 */
export type WritersCheckRecordOutcome = {
  status: 'RECORDED' | 'FAILED'
  verdict: WritersCheckReport['verdict']
  exitCode: number
  findings: number
  reason?: string
}

export async function runWritersCheckRecord(deps: {
  build?: () => Promise<WritersCheckReport>
  log?: typeof logActivityPersisted
} = {}): Promise<WritersCheckRecordOutcome> {
  const build = deps.build ?? (() => buildWritersCheckReport())
  const log = deps.log ?? logActivityPersisted
  let report: WritersCheckReport
  try {
    report = await build()
  } catch {
    return { status: 'FAILED', verdict: 'unreadable', exitCode: 5, findings: 0, reason: 'the check itself failed' }
  }
  const failing = report.findings.filter((finding) => finding.severity === 'fail').length
  const persisted = await log({
    entityType: 'SYSTEM',
    entityId: null,
    action: WRITERS_CHECK_RECORD_ACTION,
    tag: 'sync',
    level: report.verdict === 'ok' ? 'INFO' : 'ERROR',
    description: `Writers check: ${report.verdict} (${failing} failing finding(s), exit code ${report.exitCode}).`,
    metadata: { report: JSON.parse(JSON.stringify(report)) as Record<string, unknown> },
    resolveUser: false,
  })
  if (!persisted) return { status: 'FAILED', verdict: report.verdict, exitCode: report.exitCode, findings: report.findings.length, reason: 'the record could not be written' }
  return {
    status: report.verdict === 'ok' ? 'RECORDED' : 'FAILED',
    verdict: report.verdict,
    exitCode: report.exitCode,
    findings: report.findings.length,
    ...(report.verdict === 'ok' ? {} : { reason: `the check found ${report.verdict}` }),
  }
}
