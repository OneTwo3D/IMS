import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { sweepWithdrawalSuppressions } from '@/lib/connectors/woocommerce/sync/withdrawal'

// Called by cron with Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('wc-withdrawal-sweep', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Persisted through runCronWithLogging, not just returned: the installer
  // invokes cron with `curl -o /dev/null`, so a bare JSON body is discarded.
  // A broken WooCommerce credential would otherwise leave suppressed orders
  // unimported indefinitely while the job kept reporting 200.
  const { runId, result } = await runCronWithLogging({
    jobName: 'wc-withdrawal-sweep',
    run: async () => {
      // Same kill switches as wc-reconcile. This job calls the WooCommerce API
      // and can import orders, so a stale crontab must not keep it running
      // while synchronisation is deliberately paused.
      if (!(await isIntegrationPluginEnabled('woocommerce'))) {
        return { skipped: true, reason: 'Shopping plugin disabled' }
      }
      const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
      if (enabled?.value !== 'true') {
        return { skipped: true, reason: 'WC sync disabled' }
      }

      const sweep = await sweepWithdrawalSuppressions()
      // Unresolved rows are orders we could not prove are safe to import. A
      // silent 200 here is exactly how a credential outage hides.
      if (sweep.unresolved > 0) {
        throw new Error(
          `${sweep.unresolved} withdrawal suppression(s) could not be resolved against WooCommerce `
          + `(scanned ${sweep.scanned}, imported ${sweep.imported}, still withdrawn ${sweep.stillWithdrawn})`,
        )
      }
      return sweep
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
