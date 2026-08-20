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
    // o3d-hl8l r4 (Codex r3 finding 1): DEFAULT ON. The refused-callback recovery was documented as
    // bounded by this job's overdue-ASN alert while it was registered `defaultEnabled: false` — so on
    // a default installation the bound did not exist and the loss produced no alert at all. It is a
    // detector: hourly, read-mostly, and it writes only a dedupe stamp and a notification per breach,
    // deduped to once per ASN. The automatic post-maintenance re-check now carries the fast recovery
    // (minutes, on the sweeper); this stays the days-scale backstop for an ASN that is stuck for a
    // reason maintenance mode had nothing to do with.
    defaultEnabled: true,
  },
])
