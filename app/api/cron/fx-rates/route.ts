import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { fetchAllFxRatesInternal } from '@/lib/currencies/fx-refresh'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('fx-rates', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const { runId, result } = await runCronWithLogging({
    jobName: 'fx-rates',
    run: async () => {
      const refreshed = await fetchAllFxRatesInternal() as Record<string, unknown>
      // A stored receipt whose ledger registration is not on record is retried on EVERY scheduled run, whether or not any rate changed (the refresh above retries the
      // rate-waiting orders only after a fetch that updated a rate). Idempotent (the registration enqueue is keyed per receipt and document) and bounded (50 rows).
      let receiptRetry: unknown = null
      try {
        const { retryPendingWcOrdersWaitingForFx } = await import('@/lib/connectors/woocommerce/sync/order-import')
        const { sweepUnregisteredReceipts } = await import('@/lib/domain/accounting/receipt-registration-sweep')
        receiptRetry = { queue: await retryPendingWcOrdersWaitingForFx(50, { receiptsOnly: true }), orphans: await sweepUnregisteredReceipts(50) }
      } catch (error) {
        receiptRetry = { error: String(error).slice(0, 240) }
      }
      return { ...refreshed, pendingWcReceiptRetry: receiptRetry }
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
