import { registerCronJobs } from '@/lib/cron-registry'

registerCronJobs([
  {
    slug: 'accounting-sync',
    settingKey: 'xero_sync',
    module: 'accounting',
    moduleLabel: 'Accounting',
    label: 'Accounting Sync Queue',
    description: 'Processes pending accounting sync entries and posts them to the active connector.',
    defaultSchedule: '*/5 * * * *',
    defaultEnabled: true,
  },
  {
    slug: 'accounting-daily-batch',
    settingKey: 'xero_daily_batch',
    module: 'accounting',
    moduleLabel: 'Accounting',
    label: 'Accounting Daily Batch',
    description: 'Runs the daily accounting sub-ledger batch sync through the active connector.',
    defaultSchedule: '0 2 * * *',
    defaultEnabled: true,
  },
  {
    slug: 'accounting-payment-poll',
    settingKey: 'xero_payment_poll',
    module: 'accounting',
    moduleLabel: 'Accounting',
    label: 'Accounting Payment Poll',
    description: 'Polls the active accounting connector for payment status changes and reconciles invoices.',
    defaultSchedule: '*/15 * * * *',
    defaultEnabled: true,
  },
])
