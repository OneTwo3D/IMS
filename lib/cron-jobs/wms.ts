// WMS connector cron registrations.
//
// The generic cron bootstrap (./index.ts) imports this single barrel rather than
// any connector-specific module, so the WMS layer stays connector-agnostic
// there. Adding a WMS connector means registering its cron module HERE (next to
// its registry entry + WMS_CONNECTOR_IDS), not editing index.ts.
//
// Registration is an eager side effect (registerCronJobs at module load), so the
// imports must be static — keep one line per WMS cron module.
import './wms-order-status' // connector-agnostic (module 'wms')
import './wms-order-push' // connector-agnostic (module 'wms')
import './wms-mintsoft' // Mintsoft connector jobs
