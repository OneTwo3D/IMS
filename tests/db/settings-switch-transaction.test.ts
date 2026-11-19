import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * `npm run settings:set` IS ONE TRANSACTION, against a real Postgres: the settings row, its activity-log entry and the read-back commit together,
 * and when the audit write fails the settings row does not change. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Uses wc_invoice_note_enabled and wms_refund_remainder_task_enabled, restoring the rows it found. The audit rows it writes are removed afterwards.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/settings-switch-transaction.test.ts would have been skipped')
}

test('settings switch: upsert + audit + read-back commit together; a failed audit rolls the row back', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { runSettingsCli } = await import('../../scripts/settings-cli.ts')
  const { findSwitch, writeSwitch, SWITCH_AUDIT_ACTION } = await import('../../lib/domain/settings/system-switches.ts')

  const KEY = 'wc_invoice_note_enabled'
  const KEY2 = 'wms_refund_remainder_task_enabled'
  const before = await db.setting.findMany({ where: { key: { in: [KEY, KEY2] } } })
  const priorAudits = new Set((await db.activityLog.findMany({ where: { action: SWITCH_AUDIT_ACTION, entityId: { in: [KEY, KEY2] } }, select: { id: true } })).map((r) => r.id))
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { action: SWITCH_AUDIT_ACTION, entityId: { in: [KEY, KEY2] }, id: { notIn: [...priorAudits] } } })
    await db.setting.deleteMany({ where: { key: { in: [KEY, KEY2] } } })
    for (const row of before) await db.setting.create({ data: { key: row.key, value: row.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: [KEY, KEY2] } } })

  const out: string[] = []; const err: string[] = []
  const cli = (mode: 'get' | 'set', argv: string[]) => runSettingsCli({
    mode, argv, db: db as never, stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) }, disconnect: async () => {},
  })
  const auditCount = async (key: string) => db.activityLog.count({ where: { action: SWITCH_AUDIT_ACTION, entityId: key, id: { notIn: [...priorAudits] } } })
  const args = ['--key', KEY, '--value', 'true', '--by', 'db-test', '--reason', 'transaction proof']

  // Dry run writes nothing.
  assert.equal(await cli('set', args), 0)
  assert.equal(await db.setting.findUnique({ where: { key: KEY } }), null)
  assert.equal(await auditCount(KEY), 0)

  // Apply: row + one audit entry, read back.
  assert.equal(await cli('set', [...args, '--yes']), 0, err.join('\n'))
  assert.equal((await db.setting.findUnique({ where: { key: KEY } }))?.value, 'true')
  const audits = await db.activityLog.findMany({ where: { action: SWITCH_AUDIT_ACTION, entityId: KEY, id: { notIn: [...priorAudits] } } })
  assert.equal(audits.length, 1)
  assert.equal(audits[0].entityType, 'SETTING')
  assert.deepEqual(audits[0].metadata, { by: 'db-test', reason: 'transaction proof', oldValue: null, newValue: 'true', via: 'settings:set' })
  out.length = 0
  assert.equal(await cli('get', ['--key', KEY]), 0)
  assert.match(out.join('\n'), /stored:    true/)
  assert.match(out.join('\n'), /by db-test/)

  // One transaction: a failing audit write leaves the row exactly as it was.
  const failing = {
    $transaction: <T,>(fn: (tx: never) => Promise<T>, options?: Record<string, unknown>) =>
      db.$transaction((tx) => fn(new Proxy(tx, {
        get: (target, prop, receiver) => (prop === 'activityLog'
          ? { create: async () => { throw new Error('audit write failed') } }
          : Reflect.get(target, prop, receiver)),
      }) as never), options as never),
  }
  await assert.rejects(writeSwitch(failing as never, { def: findSwitch(KEY2)!, value: 'true', by: 'db-test', reason: 'must roll back' }), /audit write failed/)
  assert.equal(await db.setting.findUnique({ where: { key: KEY2 } }), null, 'the settings row must not survive a failed audit write')
  assert.equal(await auditCount(KEY2), 0)

  // Cross-key refusal inside the transaction writes nothing.
  const refused = await writeSwitch(db as never, { def: findSwitch('mintsoft_parent_sku_delete_enabled')!, value: 'true', by: 'db-test', reason: 'needs parity' })
  const parity = await db.setting.findUnique({ where: { key: 'mintsoft_product_parity_enabled' } })
  if (!parity || parity.value !== 'true') assert.equal(refused.ok, false)
})
