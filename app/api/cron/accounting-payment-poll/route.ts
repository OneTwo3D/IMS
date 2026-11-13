import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { cronResultResponse } from '@/lib/ops/cron-response'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-payment-poll', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (await isIntegrationPluginEnabled('xero')) {
    const [pollingEnabled, syncEnabled] = await Promise.all([
      db.setting.findUnique({ where: { key: 'xero_payment_polling_enabled' } }),
      db.setting.findUnique({ where: { key: 'xero_sync_enabled' } }),
    ])
    if (pollingEnabled?.value !== 'true') return cronResultResponse({ skipped: true, reason: 'Xero payment polling disabled' })
    if (syncEnabled?.value !== 'true') return cronResultResponse({ skipped: true, reason: 'Xero sync disabled' })
    const { pollXeroPayments } = await import('@/lib/connectors/xero/payment-poller')
    const result = await pollXeroPayments()
    return cronResultResponse(result)
  }

  // The QuickBooks branch was here and is archived (o3d-remove-parked-connectors): plugin +
  // `quickbooks_payment_polling_enabled` + `quickbooks_sync_enabled`, then `pollQuickBooksPayments()`.

  return cronResultResponse({ skipped: true, reason: 'No accounting plugin enabled' })
}
