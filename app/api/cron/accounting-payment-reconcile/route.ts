import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

/**
 * Backlog reconciliation sweep (o3d-2s8). The payment poll only ever sees Xero's modified-since
 * delta, so an invoice paid before its local link existed — or paid back when the pre-#494 poller
 * was reading only the oldest 100 — is never revisited. This starts from every locally-linked
 * document instead and asks Xero its current status by id.
 *
 * Report-only by default (xero_payment_reconcile_apply != 'true'): it surfaces missed payments and
 * suspect advances for an operator without mutating anything, which is also the read-only answer to
 * the o3d-1d9 "were orders wrongly advanced" question. Flip the setting to collect missed payments.
 */
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-payment-reconcile', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (await isIntegrationPluginEnabled('xero')) {
    const [syncEnabled, applySetting] = await Promise.all([
      db.setting.findUnique({ where: { key: 'xero_sync_enabled' } }),
      db.setting.findUnique({ where: { key: 'xero_payment_reconcile_apply' } }),
    ])
    if (syncEnabled?.value !== 'true') return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })

    const apply = applySetting?.value === 'true'
    const { reconcileXeroPayments } = await import('@/lib/connectors/xero/payment-reconcile')
    const report = await reconcileXeroPayments({ apply })
    return NextResponse.json({ mode: apply ? 'apply' : 'report', ...report })
  }

  // o3d-remove-parked-connectors: the QuickBooks arm here answered a NAMED skip — "payment reconcile
  // not yet implemented for QuickBooks" — rather than falling through to "no accounting plugin
  // enabled", which would have read as a configuration problem. That distinction is the pattern a
  // second ledger without a reconcile sweep should copy; the arm itself went with the connector.

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled' })
}
