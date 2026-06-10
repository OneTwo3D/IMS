export async function register() {
  const { assertProductionCronSecretConfigured } = await import('./lib/cron-secret-validation')
  assertProductionCronSecretConfigured()
}
