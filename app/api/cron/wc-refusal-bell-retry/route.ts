import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { retryUnnotifiedWcCompletionRefusalBells } from '@/lib/connectors/woocommerce/sync/completion-flow'

/**
 * o3d-xnwu round 4, finding 2 — THE DRIVER FOR A FAILED BELL.
 *
 * Round 3 recorded delivery on the refusal row and re-rang an undelivered bell
 * on the next refusal of the same order. That retry had no driver: the trigger
 * was another refusal, and the commonest refusal — an order that cannot be
 * fulfilled from stock — is acknowledged precisely so the webhook is NOT
 * redelivered. The one case where nobody was told was therefore the case least
 * likely to recur.
 *
 * Deliberately NOT gated on the WooCommerce sync switch or the shopping plugin
 * switch, as
 * wc-reconcile and wc-withdrawal-sweep are. Those call WooCommerce and can
 * import orders, so a stale crontab must not keep them running while sync is
 * paused. This one calls nothing: it reads local rows and writes local
 * notifications about orders IMS has already refused. Pausing the sync is not
 * saying you no longer want to hear about them.
 */
// Called by cron with Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('wc-refusal-bell-retry', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'wc-refusal-bell-retry',
    run: async () => {
      const sweep = await retryUnnotifiedWcCompletionRefusalBells()
      // A silent 200 over an order nobody has been told about is the whole
      // defect, one level up. The run itself carries the state, so the health
      // page and the cron log show it without an ERROR activity row per order
      // per quarter-hour — which is how a real signal gets filtered away.
      if (sweep.stillUndelivered > 0) {
        throw new Error(
          `${sweep.stillUndelivered} refused WooCommerce completion(s) still have no delivered admin notification`
          + (sweep.adminCount === 0 ? ' — there is no active ADMIN user to notify' : '')
          + ` (scanned ${sweep.scanned}, delivered ${sweep.delivered})`,
        )
      }
      return sweep
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
