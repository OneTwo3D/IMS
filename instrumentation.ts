export async function register() {
  const { assertProductionCronSecretConfigured } = await import('./lib/cron-auth')
  assertProductionCronSecretConfigured()
}
