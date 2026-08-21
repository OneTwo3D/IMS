import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { sweepDispatchEligibleWithdrawals, sweepWithdrawalSuppressions } from '@/lib/connectors/woocommerce/sync/withdrawal'
import { drainWcOrderAdmissionRefusals } from '@/lib/connectors/woocommerce/sync/order-admission'

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

      // o3d-rbyg round 2: and the other direction — orders IMS has ALREADY pushed, which no
      // tombstone covers because the push screen only looks at what it is about to push. This is
      // the only place that asks WooCommerce about them, and it lives HERE rather than in the
      // dispatch sweep on purpose: a storefront outage must not be able to interfere with dispatch
      // reconciliation shop-wide. It rotates a bounded slice per run (see the function's bound).
      //
      // Run AFTER the suppression sweep and independently of it: a failure to screen the dispatch
      // set must not lose the suppression sweep's work, and vice versa.
      let recon: Awaited<ReturnType<typeof sweepDispatchEligibleWithdrawals>> | null = null
      let reconError: string | null = null
      try {
        recon = await sweepDispatchEligibleWithdrawals()
      } catch (error) {
        reconError = error instanceof Error ? error.message : String(error)
        console.error('[wc-withdrawal-sweep] dispatch-eligible withdrawal screen failed:', error)
      }

      // A THIRD by-id backstop rides this job, for the same reason the two above do, and it rides this job for the same reason the withdrawal sweep
      // exists at all (o3d-tj6v r5): an order the "Import order statuses" boundary refused was
      // ACKNOWLEDGED, so WooCommerce never pushes it again, and the pull cursors have moved past
      // it. Nothing that depends on a `?modified_after=` sweep can reach it. This drain re-reads
      // each refused order BY ID and puts it back through the ordinary gated importer.
      //
      // Run even when the withdrawal sweep found nothing, and its own unresolved count is reported
      // rather than thrown: a WooCommerce outage already surfaces through the sweep above, and
      // failing this job on an order that is simply still excluded would make a correct refusal
      // look like a broken cron every fifteen minutes.
      const admissionRefusals = await drainWcOrderAdmissionRefusals()

      // Unresolved rows are orders we could not prove are safe to import. A
      // silent 200 here is exactly how a credential outage hides.
      if (sweep.unresolved > 0) {
        throw new Error(
          `${sweep.unresolved} withdrawal suppression(s) could not be resolved against WooCommerce `
          + `(scanned ${sweep.scanned}, imported ${sweep.imported}, still withdrawn ${sweep.stillWithdrawn})`,
        )
      }
      // Same rule for the dispatch screen: an unread slice means already-pushed orders went
      // unexamined this run, and the cursor was HELD rather than rotated past them. That is safe,
      // and it is exactly the state that must not report 200 for a week.
      if (reconError || (recon && recon.unresolved > 0)) {
        throw new Error(
          reconError
            ? `The dispatch-eligible withdrawal screen failed: ${reconError}`
            : `${recon?.unresolved} dispatch-eligible order(s) could not be screened against WooCommerce `
              + `(scanned ${recon?.scanned}, withdrawn ${recon?.withdrawn}, applied ${recon?.applied}) `
              + '— the rotation cursor was held, so they are re-screened next run',
        )
      }
      return { ...sweep, dispatchScreen: recon ?? undefined, admissionRefusals }
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
