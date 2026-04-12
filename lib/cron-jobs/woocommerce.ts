import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'wc-sync',
    settingKey: 'wc_sync',
    module: 'woocommerce',
    moduleLabel: 'WooCommerce',
    label: 'WooCommerce Sync',
    description: 'Polls WooCommerce for new/updated orders and products.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
])
