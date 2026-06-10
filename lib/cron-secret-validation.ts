export const MIN_CRON_SECRET_LENGTH = 32

export function assertProductionCronSecretConfigured(
  env: Partial<Record<'NODE_ENV' | 'CRON_SECRET', string | undefined>> = process.env,
): void {
  if (env.NODE_ENV !== 'production') return

  const secret = env.CRON_SECRET?.trim() ?? ''
  if (secret.length === 0) {
    throw new Error('CRON_SECRET is required in production for cron endpoint authentication.')
  }
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    throw new Error(`CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters in production.`)
  }
}
