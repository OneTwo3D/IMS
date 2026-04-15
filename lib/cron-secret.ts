export type CronSecretInfo = {
  value: string | null
  source: 'env' | 'none'
}

export async function getCronSecretInfo(): Promise<CronSecretInfo> {
  const envValue = process.env.CRON_SECRET
  if (envValue) {
    return { value: envValue, source: 'env' }
  }

  return { value: null, source: 'none' }
}

export async function getCronSecret(): Promise<string | null> {
  return (await getCronSecretInfo()).value
}
