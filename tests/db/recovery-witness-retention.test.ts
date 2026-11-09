import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * WHICH WITNESSED ROWS RETENTION KEEPS, PROVEN AGAINST A REAL POSTGRES.
 *
 * The exemption for the sync-log rows a refund-park recovery names is a SQL predicate, so its behaviour is a
 * property of Postgres. Everything runs inside a transaction that is always rolled back, with its own seeded rows.
 *
 *   * no verification pass recorded  -> every witnessed row is kept
 *   * pass recorded                  -> only a witnessed row check 7 would accuse is kept; a clean one is released
 *   * a row with no witness is never kept by this exemption
 *   * check 7 (run from the migration's own verify.sql) reports the kept, accused row, which is the reason it must
 *     be kept: check 7 drives from the table, so a deleted accused row would read as zero.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

class Rollback extends Error {}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

const MIGRATION = '20260822120000_shopping_sync_log_record_kind'

test('a recorded verification pass releases clean witnessed rows and keeps the accused ones', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const { recoveryWitnessRetainsRowSql } = await import('../../lib/data-retention.ts')
  const { WC_REFUND_PARK_RECOVERED_ACTION } = await import('../../lib/domain/sales/refund-park-recovery.ts')

  const verify = readFileSync(path.join(process.cwd(), 'prisma/migrations', MIGRATION, 'verify.sql'), 'utf8')
  const check7 = verify.slice(verify.lastIndexOf("SELECT 'shopping_sync_logs recovered refund park"))

  const base = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR' as const,
    status: 'SYNCED' as const,
    entityType: 'SalesOrder',
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
  }

  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM migration_verification_passes WHERE migration_name = ${MIGRATION}`

      const clean = await tx.shoppingSyncLog.create({ data: { ...base, entityId: 'order-clean', payload: { id: 11, note: 'refund' } }, select: { id: true } })
      const heldKind = await tx.shoppingSyncLog.create({ data: { ...base, entityId: 'order-held', recordKind: 'WC_HELD_SALES_INVOICE', payload: { reason: 'x' } }, select: { id: true } })
      const heldShape = await tx.shoppingSyncLog.create({
        data: { ...base, entityId: 'order-shape', payload: { reason: 'missing_wc_invoice_number', accountingPayload: { a: 1 }, metaKey: 'k' } },
        select: { id: true },
      })
      const unwitnessed = await tx.shoppingSyncLog.create({ data: { ...base, entityId: 'order-none', recordKind: 'WC_HELD_SALES_INVOICE', payload: { reason: 'x' } }, select: { id: true } })
      for (const row of [clean, heldKind, heldShape]) {
        await tx.activityLog.create({
          data: {
            entityType: 'SALES_ORDER', action: WC_REFUND_PARK_RECOVERED_ACTION, tag: 'sync', level: 'WARNING',
            description: 'probe', metadata: { shoppingSyncLogId: row.id },
          },
        })
      }
      const ids = [clean.id, heldKind.id, heldShape.id, unwitnessed.id]

      async function retained(): Promise<string[]> {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM "shopping_sync_logs" WHERE id = ANY(${ids}::text[]) AND ${recoveryWitnessRetainsRowSql()}`,
        )
        return rows.map((r) => r.id).sort()
      }

      // No pass: everything witnessed is kept, the unwitnessed row is not.
      assert.deepEqual(await retained(), [clean.id, heldKind.id, heldShape.id].sort())

      // Pass recorded: the clean row is released, both accused rows (by stamp and by payload shape) stay.
      await tx.$executeRaw`INSERT INTO migration_verification_passes (migration_name, checks_passed) VALUES (${MIGRATION}, 7)`
      assert.deepEqual(await retained(), [heldKind.id, heldShape.id].sort())

      // And check 7, run from the migration's own file, accuses exactly the rows retention kept.
      const [{ violations }] = await tx.$queryRawUnsafe<Array<{ violations: bigint }>>(check7.replace(/;\s*$/, ''))
      assert.ok(Number(violations) >= 2, `check 7 sees the accused rows retention kept (saw ${String(violations)})`)

      throw new Rollback('probe complete')
    }),
    Rollback,
  )
})
