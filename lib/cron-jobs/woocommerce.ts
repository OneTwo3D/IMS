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
      'Re-checks orders refused as EU withdrawal requests against the live storefront status, by order ID. '
      + 'The only route that does not depend on another webhook or poll reaching the order, so a request '
      + 'rejected back to a status the poll does not query is still imported.',
    defaultSchedule: '*/15 * * * *',
    defaultEnabled: true,
  },
  {
    slug: 'wc-refusal-bell-retry',
    settingKey: 'wc_refusal_bell_retry',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Refusal Bell Retry',
    description:
      'Re-sends the admin notification for a WooCommerce order the store marked completed and IMS refused to '
      + 'fulfil, when the first attempt to write that notification failed. Without it the retry waits for the '
      + 'same order to be refused again — which, for the acknowledged out-of-stock refusal, may never happen.',
    defaultSchedule: '*/15 * * * *',
    // Enabled by default, on purpose: the recovery this provides must not itself
    // depend on somebody having found and turned on a switch.
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
