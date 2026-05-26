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
  {
    slug: 'shopping-webhook-inbox',
    settingKey: 'shopping_webhook_inbox',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Webhook Inbox',
    description: 'Processes persisted WooCommerce order, product, and refund webhook events outside the public request path.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
])
