import { getSettingValues } from '@/lib/settings-store'

export type MintsoftSettings = {
  mintsoft_api_key: string
  mintsoft_username: string
  mintsoft_password: string
  mintsoft_webhook_secret: string
}

export const MINTSOFT_SETTING_KEYS = [
  'mintsoft_api_key',
  'mintsoft_username',
  'mintsoft_password',
  'mintsoft_webhook_secret',
] as const

const MINTSOFT_DEFAULTS: MintsoftSettings = {
  mintsoft_api_key: '',
  mintsoft_username: '',
  mintsoft_password: '',
  mintsoft_webhook_secret: '',
}

export async function getMintsoftSettings(): Promise<MintsoftSettings> {
  const map = await getSettingValues([...MINTSOFT_SETTING_KEYS])
  const result = { ...MINTSOFT_DEFAULTS }

  for (const key of Object.keys(result) as (keyof MintsoftSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }

  return result
}
