import { registerCronJobs } from '@/lib/cron-registry'

// Connector-agnostic WMS order-status sweep — module 'wms' so it shows whenever
// any WMS connector is enabled (isIntegrationModuleVisible('wms', state)), not
// tied to a specific connector.
registerCronJobs([
  {
    slug: 'wms-order-status',
    settingKey: 'wms_order_status',
    module: 'wms',
    moduleLabel: 'WMS',
    label: 'WMS Order Status Sweep',
    description: 'Refresh cached WMS order statuses for in-flight sales orders (powers the sales-list status chips).',
    defaultSchedule: '*/15 * * * *',
    defaultEnabled: false,
  },
])
