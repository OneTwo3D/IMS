import type { CronFieldDeclaration } from '@/lib/ops/cron-outcome-fields'

/** The failure-field declarations of the Mintsoft cron routes (see lib/ops/cron-outcome-fields.ts for the contract). */
export const mintsoftCronFailureFields = {
  'mintsoft-bundle-verify': {
    skipState: { status: 'SKIPPED' },
    consumed: ['errors'],
    ignored: { conflicts: 'bundle derivation conflicts: each is recorded as a BUNDLE_DERIVATION_CONFLICT discrepancy in the operator discrepancy inbox and the bundle is left untouched, like `mismatched` on the other verifiers; not a failed run' },
  },
  'mintsoft-dispatch-sync': { consumed: ['errors'], skipState: { status: 'SKIPPED' } },
  'mintsoft-product-verify': {
    skipState: { status: 'SKIPPED' },
    consumed: ['errors'],
    breakdownOf: { 'content.errors': 'errors' },
  },
  'mintsoft-returns-sync': { consumed: ['errors'], skipState: { status: 'SKIPPED' } },
  'mintsoft-stock-sync': { consumed: ['details[].errors'] },
  'mintsoft-webhook-sweeper': {
    consumed: ['failed', 'postMaintenanceRecheck.failed'],
    ignored: { 'postMaintenanceRecheck.refusal': 'why the post-maintenance re-check did not run (maintenance still on, window reopened): a by-design refusal, not a failure' },
  },
} satisfies Record<string, CronFieldDeclaration>
