import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'wc-reconcile',
    settingKey: 'wc_reconcile',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Reconcile',
    description: 'Runs WooCommerce backup reconciliation for orders/products and drains queued stock retries after webhook-first sync.',
    // Hourly, not daily: the forceAll stock catch-up works through the catalogue in windows within a per-request time budget and
    // carries on from a saved cursor on the next run, so a daily job would need several days to finish a large catalogue. The job
    // does nothing for stock when no pass is due or unfinished, and the webhook-primary order/product reconciles keep their own
    // 24 hour gate.
    defaultSchedule: '0 * * * *',
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
    description: 'Processes persisted WooCommerce order, product, and refund webhook events outside the public request path, and retries any queued WooCommerce order completions (the "completed" push that follows an IMS shipment) that did not land.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
])
