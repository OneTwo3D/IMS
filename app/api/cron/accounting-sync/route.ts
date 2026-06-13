import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIVE_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-sync', { request, max: CRON_RATE_LIMIT_FIVE_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Dispatch to the active accounting connector
  if (await isIntegrationPluginEnabled('xero')) {
    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
    }
    const token = await db.accountingToken.findFirst({ where: { connector: 'xero' }, select: { id: true } })
    if (!token) {
      return NextResponse.json({ skipped: true, reason: 'Xero not connected' })
    }
    // audit-grob: drain the landed-cost adjustment-journal backstop FIRST so any
    // journals lost to a crash before their post-commit enqueue are re-queued
    // (into AccountingSyncLog) in time for this run's processPendingXeroSync.
    // Idempotent — a no-op when the direct post-commit call already queued them.
    let landedCostJournalOutbox: Awaited<ReturnType<typeof import('@/lib/domain/purchasing/landed-cost-journal-outbox')['processLandedCostJournalOutbox']>> | undefined
    try {
      const { processLandedCostJournalOutbox } = await import('@/lib/domain/purchasing/landed-cost-journal-outbox')
      landedCostJournalOutbox = await processLandedCostJournalOutbox()
    } catch (outboxError) {
      console.error('accounting-sync cron: landed-cost journal outbox drain failed', outboxError)
    }
    const { processPendingXeroSync, repairXeroBackReferences } = await import('@/lib/connectors/xero/sync-processor')
    const result = await processPendingXeroSync()
    // audit-H3: repair any documents whose back-reference was never written
    // (process died after the connector post, or retries exhausted to FAILED).
    let backReferenceRepair: Awaited<ReturnType<typeof repairXeroBackReferences>> | undefined
    try {
      backReferenceRepair = await repairXeroBackReferences()
    } catch (repairError) {
      console.error('accounting-sync cron: back-reference repair sweep failed', repairError)
    }
    return NextResponse.json({ ...result, backReferenceRepair, landedCostJournalOutbox })
  }

  if (await isIntegrationPluginEnabled('quickbooks')) {
    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks sync disabled' })
    }
    const token = await db.accountingToken.findFirst({ where: { connector: 'quickbooks' }, select: { id: true } })
    if (!token) {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks not connected' })
    }
    const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
    const result = await processPendingQuickBooksSync()
    return NextResponse.json(result)
  }

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled' })
}
