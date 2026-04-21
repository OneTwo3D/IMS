import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'mintsoft-stock-sync',
    settingKey: 'mintsoft_stock_sync',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Stock Alignment',
    description: 'Poll Mintsoft warehouse stock and queue discrepancy handling for bound warehouses.',
    defaultSchedule: '0 * * * *',
    defaultEnabled: false,
  },
  {
    slug: 'mintsoft-returns-sync',
    settingKey: 'mintsoft_returns_sync',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Returns Inbox',
    description: 'Poll Mintsoft returns feed and stage items for IMS review.',
    defaultSchedule: '15 * * * *',
    defaultEnabled: false,
  },
  {
    slug: 'mintsoft-product-verify',
    settingKey: 'mintsoft_product_verify',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Product Verification',
    description: 'Check Mintsoft product and barcode mappings against IMS products.',
    defaultSchedule: '0 3 * * *',
    defaultEnabled: false,
  },
  {
    slug: 'mintsoft-webhook-sweeper',
    settingKey: 'mintsoft_webhook_sweeper',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Webhook Sweeper',
    description: 'Drain unprocessed Mintsoft booked-in webhook events that failed or raced with ASN finalization.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
])
