// Import each module to trigger registration side effects.
// To add a future module, add its import here — no UI changes needed.
// WMS connectors register via the ./wms barrel, so this bootstrap stays
// WMS-connector-agnostic (a new WMS connector is added to ./wms, not here).
import './system'
import './wms'
import './woocommerce'
import './xero'

export { getAllCronJobs, getCronJobsByModule } from '@/lib/cron-registry'
