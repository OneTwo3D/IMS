import { registerCronJobs } from '@/lib/cron-registry'

// q66in.4.4: scheduled order-level reconciliation — IMS intent vs WMS truth,
// catching drift the incremental sweeps never see (unpushed eligible orders,
// WMS-deleted orders, cancelled orders still active in the WMS).
registerCronJobs([
  {
    slug: 'wms-order-reconcile',
    settingKey: 'wms_order_reconcile',
    module: 'wms',
    moduleLabel: 'WMS',
    label: 'WMS Order Reconciliation',
    description: 'Daily order-level reconcile of IMS intent vs WMS truth: flags eligible orders never pushed, WMS-deleted orders, and cancelled orders still active in the WMS.',
    defaultSchedule: '30 5 * * *',
    defaultEnabled: false,
  },
])
