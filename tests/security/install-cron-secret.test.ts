import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('installer cron entries read the secret at runtime and never embed it', async () => {
  const installScript = await readFile('scripts/install.sh', 'utf8')

  assert.match(installScript, /CRON_ENV_FILE="\$\{APP_DIR\}\/\.env"/)
  // Runtime read of the secret from .env (grep|cut|tr), matching the in-app
  // managed format (onetwo3d-ims-ryxy): no embedded literal, tr-stripped
  // quotes, and an empty-secret guard.
  assert.match(installScript, /grep -m1 '\^CRON_SECRET=' '\$\{CRON_ENV_FILE\}' \| cut -d= -f2- \| tr -d/)
  assert.match(installScript, /\[ -n \\"\\\$CRON_SECRET\\" \]/)
  assert.match(installScript, /Authorization: Bearer \\\$CRON_SECRET/)

  // Bootstrap jobs are written INSIDE the OTI markers so the first in-app sync
  // replaces the block in place (no unmanaged duplicate lines that drift).
  assert.match(installScript, /# --- OTI CRON START ---/)
  assert.match(installScript, /# --- OTI CRON END ---/)

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

test('installer bootstrap schedules the always-on durability crons (o3d-67y)', async () => {
  const installScript = await readFile('scripts/install.sh', 'utf8')
  const block = installScript.match(/CRON_JOBS=\(([\s\S]*?)\)/)
  assert.ok(block, 'install.sh must declare a CRON_JOBS bootstrap array')
  const jobs = block![1]
  // These run every store regardless of which integrations are configured; registry
  // registration alone does not touch the OS crontab until an operator saves the
  // scheduler, so the durability backstops must be bootstrapped at install time.
  for (const slug of ['delivery-status', 'refund-reservation-release']) {
    assert.match(jobs, new RegExp(`\\|${slug}\\|`), `bootstrap crontab must include ${slug}`)
  }
})
