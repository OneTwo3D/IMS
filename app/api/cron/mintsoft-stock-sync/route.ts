import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { runStockSyncForBinding } from '@/lib/connectors/mintsoft/sync/stock-sync'
import { isMintsoftBindingDue } from '@/lib/connectors/mintsoft/sync/stock-sync-helpers'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { cronResultResponse, cronSkippedResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-stock-sync', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return cronSkippedResponse('Mintsoft plugin disabled')
  }

  const bindings = await db.externalWmsBinding.findMany({
    where: {
      connector: 'mintsoft',
      active: true,
      stockSyncMode: {
        in: ['NOTIFICATION_ONLY', 'ALIGN_TO_WMS'],
      },
    },
    select: {
      id: true,
      lastStockSyncAt: true,
      syncFrequencyMinutes: true,
    },
  })

  const dueBindings = bindings.filter((binding) => (
    isMintsoftBindingDue(binding.lastStockSyncAt, binding.syncFrequencyMinutes)
  ))

  const results = []
  for (const binding of dueBindings) {
    results.push(await runStockSyncForBinding(binding.id, 'cron'))
  }

  const body = {
    ran: results.length,
    due: dueBindings.length,
    details: results.map((result) => ({
      bindingId: result.bindingId,
      warehouseCode: result.warehouseCode,
      status: result.status,
      totalChecked: result.totalChecked,
      mismatched: result.mismatched,
      errors: result.errors,
      ...(result.stockEnqueueFailures ? { stockEnqueueFailures: result.stockEnqueueFailures } : {}),
      ...(result.stockEnqueueHeld ? { stockEnqueueHeld: result.stockEnqueueHeld } : {}),
      skippedReason: result.skippedReason ?? null,
      jobId: result.jobId,
    })),
  }
  return cronResultResponse(body, { outcomeClass: cronOutcome('mintsoft-stock-sync', body) })
}
