import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('installer cron entries read only the cron secret instead of embedding it', async () => {
  const installScript = await readFile('scripts/install.sh', 'utf8')

  assert.match(installScript, /CRON_ENV_FILE="\$\{APP_DIR\}\/\.env"/)
  assert.match(installScript, /grep -m 1 '\^CRON_SECRET=' '\$\{CRON_ENV_FILE\}' \| cut -d= -f2-/)
  assert.match(installScript, /Authorization: Bearer \\\$\{CRON_SECRET\}/)
  assert.doesNotMatch(
    installScript,
    /\. '\$\{CRON_ENV_FILE\}'/,
    'generated crontab lines must not source the full .env file',
  )
  assert.doesNotMatch(
    installScript,
    /Authorization: Bearer \$\{CRON_SECRET\}/,
    'install-time CRON_SECRET interpolation must not appear in generated crontab lines',
  )
})
