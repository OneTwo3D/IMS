import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * WHICH DRY RUNS COUNT AS EVIDENCE FOR GOING LIVE, PROVEN AGAINST A REAL POSTGRES.
 *
 * The evidence query filters on JSON paths of wms_sync_jobs.summary and on a start time compared with
 * external_wms_bindings."pairingChangedAt". Both are properties of Postgres, so this runs the SHARED query
 * (the one the confirm action and data retention use) in a transaction that is always rolled back.
 *
 *   * a new binding gets pairingChangedAt from the column default (so rows that existed when the
 *     migration ran were stamped with its time, and every earlier dry run is NOT evidence)
 *   * a run for the current pairing, started after the stamp, is found
 *   * a run before the stamp, for another external warehouse, for another connection, or with no
 *     connection stamp, is not
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

class Rollback extends Error {}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

test('only a dry run for the binding\'s current pairing, started after the last re-point, is evidence', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { alignmentDryRunEvidenceQuery } = await import('../../lib/domain/wms/alignment-dry-run.ts')

  await assert.rejects(
    db.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.create({ data: { code: `PX${Date.now() % 100000}`, name: 'Pairing probe' }, select: { id: true } })
      const connection = await tx.wmsConnection.create({ data: { connector: 'mintsoft', label: `probe-${Date.now()}` }, select: { id: true } })
      const binding = await tx.externalWmsBinding.create({
        data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: 'ext-1', stockSyncMode: 'ALIGN_TO_WMS' },
        select: { id: true, pairingChangedAt: true },
      })
      assert.ok(binding.pairingChangedAt instanceof Date, 'the column default stamps the binding')
      const paired = binding.pairingChangedAt

      let n = 0
      const job = (startedAt: Date, summary: Record<string, unknown>) => tx.wmsSyncJob.create({
        data: {
          connector: 'mintsoft', type: 'STOCK_SYNC', status: 'SUCCEEDED', warehouseId: warehouse.id,
          startedAt, finishedAt: new Date(startedAt.getTime() + 1000), summary: { dryRun: true, ...summary, n: ++n } as never,
        },
        select: { id: true },
      })
      const after = new Date(paired.getTime() + 60_000)
      const before = new Date(paired.getTime() - 60_000)
      const stamp = { externalWarehouseId: 'ext-1', connectionId: connection.id }

      const query = () => alignmentDryRunEvidenceQuery({
        connector: 'mintsoft', warehouseId: warehouse.id, externalWarehouseId: 'ext-1', connectionId: connection.id, pairingChangedAt: paired,
      })
      const find = () => tx.wmsSyncJob.findFirst({ ...query(), select: { id: true } })

      await job(before, stamp)
      await job(after, { ...stamp, externalWarehouseId: 'ext-OLD' })
      await job(after, { ...stamp, connectionId: 'conn-OLD' })
      await job(after, { externalWarehouseId: 'ext-1' }) // recorded before connectionId was stamped
      assert.equal(await find(), null, 'none of the four stale runs is evidence')

      const good = await job(after, stamp)
      assert.equal((await find())?.id, good.id, 'a run for this pairing started after the re-point is')
      throw new Rollback('probe complete')
    }),
    Rollback,
  )
})
