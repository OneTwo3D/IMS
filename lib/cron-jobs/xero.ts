import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'xero-sync',
    settingKey: 'xero_sync',
    module: 'xero',
    moduleLabel: 'Xero',
    label: 'Xero Sync Queue',
    description: 'Processes pending journal entries and posts them to the Xero API.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
  {
    slug: 'xero-daily-batch',
    settingKey: 'xero_daily_batch',
    module: 'xero',
    moduleLabel: 'Xero',
    label: 'Xero Daily Batch',
    description: 'Runs the daily sub-ledger batch sync to Xero general ledger.',
    defaultSchedule: '0 2 * * *',
    defaultEnabled: true,
  },
  {
    slug: 'xero-payment-poll',
    settingKey: 'xero_payment_poll',
    module: 'xero',
    moduleLabel: 'Xero',
    label: 'Xero Payment Poll',
    description: 'Polls Xero for payment status changes and reconciles invoices.',
    defaultSchedule: '*/15 * * * *',
    defaultEnabled: true,
  },
])
