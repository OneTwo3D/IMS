import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'wc-reconcile',
    settingKey: 'wc_reconcile',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Reconcile',
    description: 'Runs WooCommerce backup reconciliation for orders/products and drains queued stock retries after webhook-first sync.',
    defaultSchedule: '0 4 * * *',
    defaultEnabled: true,
    legacyEnabledKey: 'cron_wc_sync_enabled',
  },
])
