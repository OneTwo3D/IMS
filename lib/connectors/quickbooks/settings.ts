import { getSettingValues } from '@/lib/settings-store'

export type QuickBooksSettings = {
  quickbooks_client_id: string
  quickbooks_client_secret: string
  quickbooks_company_id: string
  quickbooks_sync_enabled: string
}

export const QUICKBOOKS_SETTING_KEYS = [
  'quickbooks_client_id',
  'quickbooks_client_secret',
  'quickbooks_company_id',
  'quickbooks_sync_enabled',
] as const

const QUICKBOOKS_DEFAULTS: QuickBooksSettings = {
  quickbooks_client_id: '',
  quickbooks_client_secret: '',
  quickbooks_company_id: '',
  quickbooks_sync_enabled: 'false',
}

export async function getQuickBooksSettings(): Promise<QuickBooksSettings> {
  const map = await getSettingValues([...QUICKBOOKS_SETTING_KEYS])
  const result = { ...QUICKBOOKS_DEFAULTS }
  for (const key of Object.keys(result) as (keyof QuickBooksSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }
  return result
}
