import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

/**
 * o3d-i0o6 r6 (Codex round 5, HIGH 1) — WHICH CONNECTOR'S DAILY-BATCH SWEEP THE CRON ACTUALLY RUNS.
 *
 * `app/api/cron/accounting-daily-batch` runs ONE sweep per tick: the first enabled accounting
 * plugin's, and it RETURNS rather than falling through, so a second enabled plugin's sweep never
 * runs at all. That is not a detail of the route — it is the fact that decides whether pounds
 * standing in another ledger have anybody coming for them:
 *
 *   a Group A2 pass on QuickBooks, whose journal went missing, is only "somebody else's problem"
 *   while somebody else's sweep runs. After a switch to Xero it does not, and the Xero sweep — which
 *   must not rebuild QuickBooks pounds into Xero accounts — is the last reader those pounds will
 *   ever have.
 *
 * So the schedule is resolved from ONE definition, read by the route that does the running and by
 * the sweeps that have to say whether a batch is abandoned. A second spelling in the sweeps would be
 * a rule about scheduling written by something that does no scheduling, and the day the route
 * changed, the sweeps would go on reporting (or silencing) against the old one.
 */
export type DailyBatchSweepConnector = 'xero' | 'quickbooks'

export type DailyBatchSweepSchedule =
  /** This connector's sweep is the one the cron runs. */
  | { connector: DailyBatchSweepConnector }
  /** No sweep runs at all. `reason` is the cron's own skip reason, verbatim. */
  | { connector: null; reason: string }

/**
 * In route order, which is load-bearing: the first ENABLED plugin decides, whether or not its own
 * batch/sync switches then turn the run into a skip. A plugin that is enabled but switched off does
 * NOT hand the tick to the next one.
 */
const DAILY_BATCH_SWEEPS: ReadonlyArray<{
  connector: DailyBatchSweepConnector
  label: string
  batchEnabledKey: string
  syncEnabledKey: string
}> = [
  { connector: 'xero', label: 'Xero', batchEnabledKey: 'xero_daily_batch_enabled', syncEnabledKey: 'xero_sync_enabled' },
  { connector: 'quickbooks', label: 'QuickBooks', batchEnabledKey: 'quickbooks_daily_batch_enabled', syncEnabledKey: 'quickbooks_sync_enabled' },
]

export async function resolveScheduledDailyBatchSweep(): Promise<DailyBatchSweepSchedule> {
  for (const sweep of DAILY_BATCH_SWEEPS) {
    if (!(await isIntegrationPluginEnabled(sweep.connector))) continue
    const [batchEnabled, syncEnabled] = await Promise.all([
      db.setting.findUnique({ where: { key: sweep.batchEnabledKey } }),
      db.setting.findUnique({ where: { key: sweep.syncEnabledKey } }),
    ])
    if (batchEnabled?.value !== 'true') return { connector: null, reason: `${sweep.label} daily batch disabled` }
    if (syncEnabled?.value !== 'true') return { connector: null, reason: `${sweep.label} sync disabled` }
    return { connector: sweep.connector }
  }
  return { connector: null, reason: 'No accounting plugin enabled' }
}
