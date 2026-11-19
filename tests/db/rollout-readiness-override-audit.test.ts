import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { collectRolloutReadiness, createRolloutReadinessHandler, type RolloutReadinessAdapters } from '../../lib/ops/rollout-readiness'
import { READINESS_OVERRIDE_AUDIT_ACTION, recordReadinessOverride } from '../../lib/ops/rollout-readiness-override-audit'

/**
 * o3d-65f4b: the `?allowWarnings=true` override against a REAL activity_logs table: the row exists, names the
 * admin and the warnings, and is redacted. No override without the row.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1; use npm run test:db.')
}

const NOW = new Date('2026-05-01T10:00:00.000Z')
const adapters: RolloutReadinessAdapters = {
  now: () => NOW,
  runPreflight: async () => ({ ok: true, checks: [{ id: 'node-env', name: 'NODE_ENV', status: 'warn', message: 'contact ops@example.com token=abc123secret' }] }),
  collectAdminHealth: async () => { throw new Error('unused') },
  accountingReconciliationSnapshot: async () => ({ latest: null, history: { runs: [], overflow: false, recordedBeforeNewest: false } }),
}

test('[o3d-65f4b] DB: an admin override writes a redacted audit row naming the admin, the time and the warnings', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const admin = await db.user.create({ data: { email: 'p65f4b-admin@example.invalid', name: 'p65f4b', passwordHash: 'x', role: 'ADMIN' }, select: { id: true } })
  await db.activityLog.deleteMany({ where: { action: READINESS_OVERRIDE_AUDIT_ACTION } })
  try {
    const handler = createRolloutReadinessHandler({
      authorize: async () => null,
      collect: async () => {
        const report = await collectRolloutReadiness({ ...adapters, collectAdminHealth: async () => { throw new Error('x') } })
        // Force a warnings-only report: the preflight warning is the only finding that matters here.
        return { ...report, status: 'warning', blockers: [], warnings: [{ id: 'trusted-proxy', severity: 'warning', source: 'preflight', message: 'contact ops@example.com token=abc123secret' }] }
      },
      resolveOverrideActor: async () => ({ id: admin.id }),
      recordOverride: recordReadinessOverride,
    })
    const response = await handler(new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'))
    assert.equal(response.status, 200)
    const rows = await db.activityLog.findMany({ where: { action: READINESS_OVERRIDE_AUDIT_ACTION } })
    assert.equal(rows.length, 1)
    const row = rows[0]!
    assert.equal(row.userId, admin.id)
    assert.ok(Math.abs(row.createdAt.getTime() - Date.now()) < 5 * 60_000)
    const text = JSON.stringify(row.metadata) + row.description
    assert.match(text, /trusted-proxy/)
    assert.doesNotMatch(text, /ops@example\.com/)
    assert.doesNotMatch(text, /abc123secret/)

    // A user that does not exist makes the write fail (foreign key): the override must NOT be applied.
    const refused = createRolloutReadinessHandler({
      authorize: async () => null,
      collect: async () => ({ ...(await collectRolloutReadiness(adapters)), status: 'warning', blockers: [], warnings: [{ id: 'w', severity: 'warning', source: 's', message: 'm' }] }),
      resolveOverrideActor: async () => ({ id: 'no-such-user' }),
      recordOverride: recordReadinessOverride,
    })
    const res2 = await refused(new Request('https://ims.example.test/api/admin/rollout-readiness?allowWarnings=true'))
    assert.equal(res2.status, 412)
  } finally {
    await db.activityLog.deleteMany({ where: { action: READINESS_OVERRIDE_AUDIT_ACTION } })
    await db.user.delete({ where: { id: admin.id } })
  }
})
