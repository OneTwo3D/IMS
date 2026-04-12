// Import each module to trigger registration side effects.
// To add a future module, add its import here — no UI changes needed.
import './system'
import './woocommerce'
import './xero'

export { getAllCronJobs, getCronJobsByModule } from '@/lib/cron-registry'
