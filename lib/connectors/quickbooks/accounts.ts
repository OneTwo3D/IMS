import { notImplementedResult } from '@/lib/connectors/not-implemented'

const CONNECTOR = 'QuickBooks'

export async function syncChartOfAccounts() {
  return { synced: 0, errors: [notImplementedResult('chart of accounts sync', CONNECTOR).error] }
}

export async function listStoredAccounts() {
  return []
}

export async function listStoredBankAccounts() {
  return []
}
