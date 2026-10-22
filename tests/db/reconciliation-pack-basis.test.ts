import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE AS-OF BASIS AGAINST A REAL DATABASE: the read transaction is really read-only and really one snapshot, the
 * date is matched exactly, a synthesised zero keeps its label, and the whole load writes nothing.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db). Fixtures use a far-future cycle date and unique codes, are removed
 * afterwards, and the global settings the basis reads are restored.
 *
 * Mutations (verified red, listed in the PR): read-only statement removed from the transaction helper => the
 * "write is refused" arm fails; balanceDate filter loosened to on-or-before => the exact-date arm fails.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/reconciliation-pack-basis.test.ts would have been skipped.')
}

const D = '2031-03-05'
const PREV = '2031-03-04'
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const ref = (iso: string, absent = false) => `xero:trial-balance:${iso}${absent ? ':absent-from-tb' : ''}`

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, basis, readTx, constants, liveness, fixtures, live] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/reconciliation-pack/basis.ts'),
    import('../../lib/reconciliation-pack/read-tx.ts'),
    import('../../lib/reconciliation-pack/constants.ts'),
    import('../../lib/reconciliation-pack/liveness.ts'),
    import('../reconciliation-pack/liveness-fixtures.ts'),
    import('../../lib/integration-plugin-keys.ts'),
  ])
  return { db, ...basis, ...readTx, ...constants, ...liveness, ...fixtures, ...live }
}

test('as-of basis against a real database', { skip }, async () => {
  const d = await deps()
  const { db } = d
  const tag = randomBytes(4).toString('hex')
  const codes = Object.fromEntries(d.PACK_BASIS_ACCOUNTS.map((a, i) => [a.kind, `RB${tag}${i}`])) as Record<string, string>
  const settingKeys = [d.INTEGRATION_PLUGIN_SETTING_KEYS.xero, ...d.PACK_BASIS_ACCOUNTS.map((a) => a.settingKey)]
  const savedSettings = await db.setting.findMany({ where: { key: { in: settingKeys } } })
  const org = await db.organisation.findFirst({ select: { baseCurrency: true } })
  const savedToken = await db.accountingToken.findUnique({ where: { connector: 'xero' } })
  const tenant = `tenant-${tag}`
  const createdOrg = org ? null : await db.organisation.create({ data: { name: `rb-${tag}` } })
  const currency = org?.baseCurrency ?? 'GBP'
  const bracket = d.bracketLiveness(d.reduceStatusReport(d.goodReport()), d.reduceStatusReport(d.goodReport()))
  const product = await db.product.create({ data: { sku: `RB-${tag}`, name: 'rb' } })
  const warehouse = await db.warehouse.create({ data: { code: `RB${tag}`.toUpperCase(), name: 'rb' } })
  try {
    for (const [key, value] of [[d.INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'], ...d.PACK_BASIS_ACCOUNTS.map((a) => [a.settingKey, codes[a.kind]!] as const)] as const) {
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    await db.accountingToken.upsert({ where: { connector: 'xero' }, create: { connector: 'xero', accessToken: 'x', expiresAt: new Date('2031-01-01T00:00:00Z'), tenantId: tenant }, update: { tenantId: tenant } })
    const amounts: Record<string, string> = { inventory: '100.50', allocated: '20.25', transit: '0', cogs: '7', unearned: '-30' }
    for (const a of d.PACK_BASIS_ACCOUNTS) {
      await db.accountingAccountBalanceSnapshot.create({ data: { connector: 'xero', externalAccountId: `rb-${tag}-${a.kind}`, accountCode: codes[a.kind]!, accountName: 'rb', balanceDate: date(D), currency, amountForeign: amounts[a.kind]!, amountBase: amounts[a.kind]!, sourcePayloadRef: ref(D, a.kind === 'transit'), tenantId: tenant } })
    }
    await db.inventorySnapshotRun.create({ data: { snapshotDate: date(D), stockLevelCount: 1, snapshotCount: 1, source: 'rb-test' } })
    await db.inventorySnapshot.create({ data: { snapshotDate: date(D), productId: product.id, warehouseId: warehouse.id, qty: '1', valueBase: '120.75', unitCostBase: '120.75', valueReplayReliable: true } })

    // 1. Available, exact numbers, labels.
    const ok = await d.loadAsOfBasis(D, bracket)
    assert.equal(ok.available, true, JSON.stringify(ok))
    if (ok.available) {
      assert.deepEqual(ok.absentFromTrialBalance, ['transit'])
      assert.equal(ok.subledger.valueBase, '120.750000')
      assert.equal(ok.inventoryGl.action, 'balanced')
    }

    // 2. NO WRITE: row counts of every table the basis reads, and the tuple counters, are unchanged by a load.
    const tables = ['settings', 'accounting_tokens', 'organisations', 'accounting_account_balance_snapshots', 'inventory_snapshot_runs', 'inventory_snapshots']
    const counts = async () => {
      const out: Record<string, string> = {}
      for (const t of tables) out[t] = String((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n)
      const stat = await db.$queryRawUnsafe<Array<{ s: string }>>(`SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del),0)::text AS s FROM pg_stat_user_tables WHERE relname = ANY($1)`, tables)
      out.writes = stat[0]!.s
      return out
    }
    await new Promise((r) => setTimeout(r, 1600))
    const before = await counts()
    for (let i = 0; i < 3; i += 1) await d.loadAsOfBasis(D, bracket)
    await d.loadAsOfBasis(PREV, bracket)
    await new Promise((r) => setTimeout(r, 1600))
    assert.deepEqual(await counts(), before, 'a basis load changes no row and writes no tuple')

    // 3. EXACT DATE: PREV has no balances at all for these accounts, so D-1 is not_for_date (D has them) and a day with none is not_for_date too, never the D row.
    const prev = await d.loadAsOfBasis(PREV, bracket)
    assert.equal(prev.available, false)
    if (!prev.available) assert.equal(prev.reason, 'not_for_date')
    const next = await d.loadAsOfBasis('2031-03-06', bracket)
    assert.equal(next.available === false && next.reason, 'not_for_date')

    // 4. The read transaction is read-only and one snapshot.
    await assert.rejects(d.withReadOnlySnapshot(async (tx) => { await (tx as never as { $executeRawUnsafe(q: string): Promise<number> }).$executeRawUnsafe(`UPDATE "settings" SET "value" = "value" WHERE "key" = '${settingKeys[0]}'`) }), /read-only/i)
    const rr = await d.withReadOnlySnapshot(async (tx) => {
      const t = tx as never as { $queryRawUnsafe<T>(q: string): Promise<T> }
      const first = (await t.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "inventory_snapshot_runs"`))[0]!.n
      await db.inventorySnapshotRun.create({ data: { snapshotDate: date('2031-03-07'), stockLevelCount: 0, snapshotCount: 0, source: 'rb-test' } })
      const second = (await t.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "inventory_snapshot_runs"`))[0]!.n
      return { first, second }
    })
    assert.equal(rr.first, rr.second, 'a commit by another connection is not seen inside the transaction')
    await db.inventorySnapshotRun.deleteMany({ where: { source: 'rb-test', snapshotDate: date('2031-03-07') } })
    await assert.rejects(d.withReadOnlySnapshot(async (tx) => { await (tx as never as { $queryRawUnsafe(q: string): Promise<unknown> }).$queryRawUnsafe('SELECT pg_sleep(3)') }, { statementTimeoutMs: 200 }), /timeout|cancel/i)

    // 4b. REBIND: the connection moves to another organisation; the stored balances belong to the previous one.
    await db.accountingToken.update({ where: { connector: 'xero' }, data: { tenantId: `${tenant}-new` } })
    const rebound = await d.loadAsOfBasis(D, bracket)
    assert.equal(rebound.available === false && rebound.reason, 'gl_snapshot_other_tenant')
    await db.accountingAccountBalanceSnapshot.updateMany({ where: { externalAccountId: { startsWith: `rb-${tag}-` } }, data: { tenantId: null } })
    const unrecorded = await d.loadAsOfBasis(D, bracket)
    assert.equal(unrecorded.available === false && unrecorded.reason, 'gl_snapshot_other_tenant')
    await db.accountingToken.update({ where: { connector: 'xero' }, data: { tenantId: tenant } })
    await db.accountingAccountBalanceSnapshot.updateMany({ where: { externalAccountId: { startsWith: `rb-${tag}-` } }, data: { tenantId: tenant } })
    assert.equal((await d.loadAsOfBasis(D, bracket)).available, true)

    // 5. Unlabelled stored balance, and a sibling row, make it unavailable.
    await db.accountingAccountBalanceSnapshot.updateMany({ where: { accountCode: codes.cogs, balanceDate: date(D) }, data: { sourcePayloadRef: null } })
    const unlabelled = await d.loadAsOfBasis(D, bracket)
    assert.equal(unlabelled.available === false && unlabelled.reason, 'gl_snapshot_unlabelled')
    await db.accountingAccountBalanceSnapshot.updateMany({ where: { accountCode: codes.cogs, balanceDate: date(D) }, data: { sourcePayloadRef: ref(D) } })
    await db.inventorySnapshot.updateMany({ where: { productId: product.id }, data: { valueReplayReliable: false } })
    const unreliable = await d.loadAsOfBasis(D, bracket)
    assert.equal(unreliable.available === false && unreliable.reason, 'unreliable_subledger_snapshot')
    await db.inventorySnapshot.updateMany({ where: { productId: product.id }, data: { valueReplayReliable: true } })
    await db.inventorySnapshotRun.updateMany({ where: { snapshotDate: date(D) }, data: { snapshotCount: 2 } })
    const incomplete = await d.loadAsOfBasis(D, bracket)
    assert.equal(incomplete.available === false && incomplete.reason, 'subledger_snapshot_incomplete')
  } finally {
    await db.inventorySnapshot.deleteMany({ where: { productId: product.id } })
    await db.inventorySnapshotRun.deleteMany({ where: { source: 'rb-test' } })
    await db.accountingAccountBalanceSnapshot.deleteMany({ where: { externalAccountId: { startsWith: `rb-${tag}-` } } })
    await db.warehouse.delete({ where: { id: warehouse.id } })
    await db.product.delete({ where: { id: product.id } })
    for (const key of settingKeys) {
      const prior = savedSettings.find((row) => row.key === key)
      if (prior) await db.setting.update({ where: { key }, data: { value: prior.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
    if (savedToken) await db.accountingToken.update({ where: { connector: 'xero' }, data: { tenantId: savedToken.tenantId } })
    else await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
    if (createdOrg) await db.organisation.delete({ where: { id: createdOrg.id } })
    await db.$disconnect()
  }
})
