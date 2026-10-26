import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { fetchAllFxRatesInternal } from '@/lib/currencies/fx-refresh'
import { logActivity } from '@/lib/activity-log'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('fx-rates', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: 'fx-rates',
    run: async () => {
      // EVERY STEP RUNS IN ITS OWN ERROR BOUNDARY: a failure is logged with its step name and reported in `stepFailures` (and as an `error` on the step, which the cron run log reads as a failed run, answered 500 below),
      // and never stops the steps after it. One shared boundary let a throwing WooCommerce retry skip the receipt sweep on every run.
      const stepFailures: Array<{ step: string; error: string }> = []
      const runStep = async <T,>(step: string, body: () => Promise<T>): Promise<T | { error: string }> => {
        try {
          return await body()
        } catch (error) {
          const text = String(error).slice(0, 240)
          stepFailures.push({ step, error: text })
          console.error(`[cron fx-rates] step ${step} failed: ${text}`)
          await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'cron_fx_rates_step_failed', level: 'WARNING', description: `fx-rates cron step "${step}" failed: ${text}`, metadata: { step }, resolveUser: false }).catch(() => undefined)
          return { error: text }
        }
      }
      const refreshed = await runStep('fx-refresh', async () => await fetchAllFxRatesInternal() as Record<string, unknown>)
      // A stored receipt whose ledger registration is not on record is retried on EVERY scheduled run, whether or not any rate changed (the refresh above retries the
      // rate-waiting orders only after a fetch that updated a rate). Idempotent (the registration enqueue is keyed per receipt and document) and bounded (50 rows).
      const queue = await runStep('wc-receipt-retry', async () => {
        const { retryPendingWcOrdersWaitingForFx } = await import('@/lib/connectors/woocommerce/sync/order-import')
        return retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true })
      })
      const orphans = await runStep('receipt-sweep', async () => {
        const { sweepUnregisteredReceipts } = await import('@/lib/domain/accounting/receipt-registration-sweep')
        return sweepUnregisteredReceipts(50)
      })
      return { ...refreshed, pendingWcReceiptRetry: { queue, orphans }, ...(stepFailures.length > 0 ? { stepFailures } : {}) }
    },
    getOutcome: (result) => ({ result, ...(Array.isArray((result as { stepFailures?: unknown }).stepFailures) ? { responseStatus: 500 } : {}) }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit({ status: responseStatus ?? 200 }))
}
