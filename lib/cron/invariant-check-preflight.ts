import {
  runScheduledInvariantCheck,
  type ScheduledInvariantCheckResult,
} from '@/lib/cron/invariant-check'

export type InvariantCheckPreflightFailure =
  | 'report_failed'
  | 'critical_findings'

export type InvariantCheckPreflightResult = {
  ok: boolean
  failure: InvariantCheckPreflightFailure | null
  result: ScheduledInvariantCheckResult
}

export async function runInvariantCheckPreflight(
  runCheck: () => Promise<ScheduledInvariantCheckResult> = () => runScheduledInvariantCheck({
    createRunId: () => `preflight-${new Date().toISOString()}`,
    writeActivityLog: async () => {},
    notifyAdmins: async () => {},
    getPreviousCriticalFindingsHash: async () => null,
    setCriticalFindingsHash: async () => {},
  }),
): Promise<InvariantCheckPreflightResult> {
  const result = await runCheck()
  if (result.status !== 'completed' || result.errors.length > 0) {
    return { ok: false, failure: 'report_failed', result }
  }
  if (result.summary.total.critical > 0 || result.criticalFindings.length > 0) {
    return { ok: false, failure: 'critical_findings', result }
  }
  return { ok: true, failure: null, result }
}

