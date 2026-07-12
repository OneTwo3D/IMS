import { registerCronJobs } from '@/lib/cron-registry'

// q66in.4.6: silent-failure watchdog — alerts once per breach on open ASNs past
// their ETA with no booked-in callback (whose stale alignment credits suppress
// real receipts) and on bindings whose stock sync went quiet past its cadence.
registerCronJobs([
  {
    slug: 'wms-watchdog',
    settingKey: 'wms_watchdog',
    module: 'wms',
    moduleLabel: 'WMS',
    label: 'WMS Silent-Failure Watchdog',
    description: 'Hourly SLO checks: open ASNs past ETA with no booked-in callback (stale alignment credits suppress real receipts), and bindings whose stock sync went quiet. Alerts admins once per breach.',
    defaultSchedule: '15 * * * *',
    defaultEnabled: false,
  },
])
