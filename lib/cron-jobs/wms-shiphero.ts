import { registerCronJobs } from '@/lib/cron-registry'

// ShipHero is webhook-PRIMARY (the inverse of Mintsoft's poll model). The sweeper
// drains staged webhook events that failed or are awaiting a writeback dependency,
// on a fast cadence; the reconcile job is the slower, wider-lookback backstop.
registerCronJobs([
  {
    slug: 'shiphero-webhook-sweeper',
    settingKey: 'shiphero_webhook_sweeper',
    module: 'shiphero',
    moduleLabel: 'ShipHero',
    label: 'ShipHero Webhook Sweeper',
    description: 'Drain staged ShipHero webhook events (shipment/order/inventory) that failed or raced a writeback dependency.',
    defaultSchedule: '*/2 * * * *',
    defaultEnabled: true,
  },
  {
    slug: 'shiphero-reconcile',
    settingKey: 'shiphero_reconcile',
    module: 'shiphero',
    moduleLabel: 'ShipHero',
    label: 'ShipHero Reconcile Backstop',
    description: 'Re-queue ShipHero webhook events stuck unprocessed past the stale threshold and report the dead-letter backlog.',
    defaultSchedule: '*/30 * * * *',
    defaultEnabled: true,
  },
  {
    slug: 'shiphero-stock-sync',
    settingKey: 'shiphero_stock_sync',
    module: 'shiphero',
    moduleLabel: 'ShipHero',
    label: 'ShipHero Stock Alignment',
    description: 'Poll ShipHero warehouse stock for bound warehouses and log discrepancies (NOTIFICATION_ONLY); the reconcile backstop to inventory webhooks.',
    defaultSchedule: '0 * * * *',
    defaultEnabled: false,
  },
])
