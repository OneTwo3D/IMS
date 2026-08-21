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
    slug: 'wc-withdrawal-sweep',
    settingKey: 'wc_withdrawal_sweep',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Withdrawal Sweep',
    description:
      'Re-checks every order IMS refused — EU withdrawal requests, and orders held back by the "Import '
      + 'order statuses" selection or an unmapped status — against the live storefront, BY ORDER ID. The '
      + 'only route that does not depend on another webhook or poll reaching the order.',
    defaultSchedule: '*/15 * * * *',
    defaultEnabled: true,
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
