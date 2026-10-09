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
    slug: 'mintsoft-bundle-verify',
    settingKey: 'mintsoft_bundle_verify',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Bundle Verification',
    description: 'Check IMS KIT product composition against the linked Mintsoft bundle and raise derivation conflicts.',
    defaultSchedule: '30 3 * * *',
    defaultEnabled: false,
  },
  {
    slug: 'mintsoft-dispatch-sync',
    settingKey: 'mintsoft_dispatch_sync',
    module: 'mintsoft',
    moduleLabel: 'Mintsoft',
    label: 'Mintsoft Despatch Poll',
    description: 'Poll Mintsoft for despatches of orders IMS has pushed and progress the IMS shipment, tracking and stock. Read-only towards Mintsoft: it never logs in, so it needs a fixed API key or an unexpired stored key.',
    defaultSchedule: '*/15 * * * *',
    // On by default, as docs/installation.md has always said. The poll only READS Mintsoft (the order list
    // and order detail endpoints on the outbound read allow-list) and never logs in (lib/connectors/mintsoft/
    // sync/dispatch-poll.ts: a login would replace the tenant API key), the route does nothing while the
    // Mintsoft plugin is off, and it has no candidates until IMS has pushed an order, so enabling it cannot
    // create anything in Mintsoft. Left off, a pushed order never progresses and the read-sync liveness check
    // reports the despatch poll as off.
    defaultEnabled: true,
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
