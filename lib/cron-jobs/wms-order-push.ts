import { registerCronJobs } from '@/lib/cron-registry'

// Connector-agnostic outbound order push (Phase 8) — module 'wms' so it shows
// whenever any WMS connector is enabled, not tied to a specific connector.
registerCronJobs([
  {
    slug: 'wms-order-push',
    settingKey: 'wms_order_push',
    module: 'wms',
    moduleLabel: 'WMS',
    label: 'WMS Order Dispatch Push',
    description: 'Push paid, ready-to-fulfil sales orders for WMS-bound warehouses to the active WMS, and propagate cancellations.',
    defaultSchedule: '*/10 * * * *',
    defaultEnabled: false,
  },
])
