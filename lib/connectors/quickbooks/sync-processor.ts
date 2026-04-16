import { notImplementedResult } from '@/lib/connectors/not-implemented'

export async function processPendingQuickBooksSync() {
  return {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    error: notImplementedResult('sync processing', 'QuickBooks').error,
  }
}
