import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INSTANCE_ROLE_DECLARATION_REQUIRED,
  INSTANCE_ROLE_ENV_VAR,
  instanceIsNonProduction,
  invalidInstanceRoleRefusal,
  readInstanceIdentity,
  undeclaredInstanceNotice,
} from '../../lib/ops/instance-identity.ts'
import {
  runProductionPreflight,
  type PreflightResult,
} from '../../lib/ops/production-preflight.ts'

/**
 * o3d-l89a. `NODE_ENV` is set by the BUILD, so `next start` reports `production` on the real
 * production server, on stage, on a second production-shaped copy and on the full-chain rig alike.
 * Every control that exempts production therefore exempts all of them — which is how a rig with no
 * Xero tenant control of its own stayed exempt from the requirement to name a ledger (o3d-iaqy, after
 * the o3d-t74p incident).
 *
 * These tests pin BOTH halves of the two-step rollout: the fallback that ships today (so the change is
 * provably behaviour-preserving for existing hosts) and the fail-closed reading that step 2 turns on
 * (so flipping `INSTANCE_ROLE_DECLARATION_REQUIRED` does not arrive untested).
 */

// ---------------------------------------------------------------------------
// The hole, stated as a test
// ---------------------------------------------------------------------------

test('a production-shaped instance with no declaration still reads as production, and says it is guessing', () => {
  // The stage server, the second production-shaped copy, and the rig whose E2E_TEST_MODE fell out of
  // its .env are all exactly this environment.
  const identity = readInstanceIdentity({ NODE_ENV: 'production' })

  assert.equal(identity.isProduction, true, 'today this still reads as production — that is o3d-l89a')
  assert.equal(identity.undeclared, true)
  assert.equal(identity.declaredRole, null)
  assert.equal(
    identity.basis,
    'node-env-fallback',
    'the verdict must carry HOW it was reached, so a caller can refuse the weak reading specifically',
  )
})

test('requiring the declaration closes it: the same environment reads as non-production', () => {
  const env = { NODE_ENV: 'production' }

  assert.equal(
    instanceIsNonProduction(env, { requireDeclaration: false }),
    false,
    'step 1 preserves the old reading exactly, so no caller changes behaviour on the day it merges',
  )
  assert.equal(
    instanceIsNonProduction(env, { requireDeclaration: true }),
    true,
    'step 2: an undeclared instance is not production, whatever the build said',
  )
})

test('the rollout switch is still on step 1, and it is what the default follows', () => {
  // If this ever flips, it must flip deliberately and with production's .env already carrying the
  // line — the assertion exists so that the flip is a decision someone made in this file too.
  assert.equal(INSTANCE_ROLE_DECLARATION_REQUIRED, false)
  assert.equal(
    instanceIsNonProduction({ NODE_ENV: 'production' }),
    INSTANCE_ROLE_DECLARATION_REQUIRED,
    'the no-options call must follow the constant, not a second copy of the rule',
  )
})

// ---------------------------------------------------------------------------
// The declaration itself
// ---------------------------------------------------------------------------

test('a declared stage instance is non-production even though the build says production', () => {
  const identity = readInstanceIdentity({ NODE_ENV: 'production', [INSTANCE_ROLE_ENV_VAR]: 'stage' })

  assert.equal(identity.isProduction, false)
  assert.equal(identity.declaredRole, 'stage')
  assert.equal(identity.undeclared, false)
  assert.equal(identity.basis, 'declaration', 'the declaration decided it, not NODE_ENV')
})

test('a declaration is matched case-insensitively and after trimming', () => {
  const identity = readInstanceIdentity({ NODE_ENV: 'production', [INSTANCE_ROLE_ENV_VAR]: '  Production \n' })

  assert.equal(identity.declaredRole, 'production')
  assert.equal(identity.isProduction, true)
  assert.equal(identity.basis, 'declaration')
})

test('E2E_TEST_MODE overrides a declaration of production — a rig handed production\'s .env is still a rig', () => {
  const identity = readInstanceIdentity({
    NODE_ENV: 'production',
    E2E_TEST_MODE: '1',
    [INSTANCE_ROLE_ENV_VAR]: 'production',
  })

  assert.equal(identity.isProduction, false, 'the e2e flag is the half that did not come from the copy')
  assert.equal(identity.basis, 'e2e-test-mode')
  assert.equal(identity.declaredRole, 'production', 'what was declared is still reported, so a refusal can name the contradiction')
})

test('an unrecognised value is refused rather than mapped to the nearest role', () => {
  const identity = readInstanceIdentity({ NODE_ENV: 'production', [INSTANCE_ROLE_ENV_VAR]: 'prod' })

  assert.equal(identity.invalidDeclaration, true)
  assert.equal(identity.declaredRole, null)
  assert.equal(identity.isProduction, false, 'a typo must not read as a promotion')
  assert.equal(identity.basis, 'invalid-declaration')

  const refusal = invalidInstanceRoleRefusal(identity)
  assert.match(refusal, /IMS_INSTANCE_ROLE="prod" is not a role this build knows/)
  assert.match(refusal, /production \| stage \| development \| e2e/, 'the remedy must name the allowed values')
  assert.match(refusal, /NON-PRODUCTION/)
})

test('an absent NODE_ENV is not production, and the notice names both signals it fell back to', () => {
  const identity = readInstanceIdentity({})

  assert.equal(identity.isProduction, false, '"we cannot tell" is not "this is production"')
  assert.equal(identity.undeclared, true)
  assert.match(undeclaredInstanceNotice(identity), /NODE_ENV \(unset\)/)
  assert.match(undeclaredInstanceNotice(identity), /set by the build, not by the deployment/)
})

test('the notice quotes the NODE_ENV it fell back to, so the operator sees what was believed', () => {
  const notice = undeclaredInstanceNotice(readInstanceIdentity({ NODE_ENV: 'production', E2E_TEST_MODE: '1' }))

  assert.match(notice, /NODE_ENV=production and E2E_TEST_MODE=1/)
  assert.match(notice, /IMS_INSTANCE_ROLE=production to this server's \.env/)
})

// ---------------------------------------------------------------------------
// Production preflight — the assertion point (o3d-l89a picked it because it is
// already the one place that claims to know what production looks like)
// ---------------------------------------------------------------------------

async function withStorageDirs<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-instance-role-test-'))
  try {
    const uploadRoot = path.join(root, 'uploads')
    const publicUploadRoot = path.join(root, 'public-uploads')
    const invoicePdfRoot = path.join(root, 'invoice-pdfs')
    const backupRoot = path.join(root, 'backups')
    await Promise.all([
      mkdir(path.join(uploadRoot, 'invoices'), { recursive: true }),
      mkdir(path.join(uploadRoot, 'quarantine', 'invoices'), { recursive: true }),
      mkdir(path.join(publicUploadRoot, 'avatars'), { recursive: true }),
      mkdir(path.join(publicUploadRoot, 'branding'), { recursive: true }),
      mkdir(invoicePdfRoot, { recursive: true }),
      mkdir(backupRoot, { recursive: true }),
    ])
    return await fn({
      UPLOAD_STORAGE_DIR: uploadRoot,
      PUBLIC_UPLOAD_STORAGE_DIR: publicUploadRoot,
      INVOICE_PDF_STORAGE_DIR: invoicePdfRoot,
      BACKUP_DIR: backupRoot,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function productionEnv(storage: Record<string, string>): Record<string, string> {
  return {
    ...storage,
    NODE_ENV: 'production',
    AUTH_SECRET: 'auth_secret_value_with_32_chars_ok',
    DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
    NEXT_PUBLIC_APP_URL: 'https://localhost:3001',
    AUTH_URL: 'https://localhost:3001',
    CRON_SECRET: 'cron_secret_value_with_32_chars_ok',
    SETTINGS_ENCRYPTION_KEY: 'settings_key_value_with_32_chars',
    FILE_SCAN_MODE: 'disabled',
    ALLOW_DATABASE_RESTORE: 'false',
    ALLOW_DATABASE_RESTORE_UPLOAD: 'false',
    E2E_TEST_MODE: '',
  }
}

function instanceRoleCheck(result: PreflightResult) {
  const check = result.checks.find((entry) => entry.id === 'instance-role')
  assert.ok(check, 'production preflight must report on the instance declaration')
  return check
}

test('preflight only WARNS while the declaration is absent, so an existing production host still passes', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({ env: productionEnv(storage) })
    const check = instanceRoleCheck(result)

    assert.equal(
      check.status,
      'warn',
      'step 1: every host alive today is undeclared, production included — failing here would break the release this check exists to protect',
    )
    assert.equal(result.ok, true, 'the warning must not fail the preflight')
    assert.match(check.message, /IMS_INSTANCE_ROLE is not set/)
    assert.match(check.message, /set by the build, not by the deployment/)
  })
})

test('preflight FAILS when the instance has declared itself something other than production', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: { ...productionEnv(storage), [INSTANCE_ROLE_ENV_VAR]: 'stage' },
    })
    const check = instanceRoleCheck(result)

    assert.equal(check.status, 'fail')
    assert.equal(result.ok, false)
    assert.match(
      check.message,
      /IMS_INSTANCE_ROLE=stage — this instance has declared itself something other than production/,
      'the refusal must name what was declared, not just report a generic failure',
    )
  })
})

test('preflight FAILS on an unrecognised declaration rather than ignoring it', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: { ...productionEnv(storage), [INSTANCE_ROLE_ENV_VAR]: 'prod' },
    })
    const check = instanceRoleCheck(result)

    assert.equal(check.status, 'fail')
    assert.equal(result.ok, false)
    assert.match(check.message, /IMS_INSTANCE_ROLE="prod" is not a role this build knows/)
  })
})

test('preflight FAILS when a production declaration is contradicted by E2E_TEST_MODE', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: { ...productionEnv(storage), [INSTANCE_ROLE_ENV_VAR]: 'production', E2E_TEST_MODE: '1' },
    })
    const check = instanceRoleCheck(result)

    assert.equal(check.status, 'fail')
    assert.equal(result.ok, false)
    assert.match(
      check.message,
      /but E2E_TEST_MODE=1 — an end-to-end test rig is never the production instance/,
    )
  })
})

test('preflight PASSES when the instance declares itself production', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: { ...productionEnv(storage), [INSTANCE_ROLE_ENV_VAR]: 'production' },
    })
    const check = instanceRoleCheck(result)

    assert.equal(check.status, 'pass')
    assert.equal(check.message, 'Instance is declared as production.')
    assert.equal(result.ok, true)
  })
})
