import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * A MAPPING WRITE DECIDES ON THE ROW AS IT IS WHEN IT WRITES (lib/tax/storefront-mapping-write.ts, the FOR UPDATE).
 *
 * Writer 1 (a re-key, say) re-points a stamped mapping row at another IMS rate and clears its stamp, and has not committed yet. Writer 2 is an import that changes nothing of what the row was
 * stamped for. Writer 2 must WAIT for writer 1 and then decide on what writer 1 left: the row is unstamped and stays so. A writer 2 that read the row before writer 1 committed would see a
 * stamped row it changes nothing of, write the stamp back, and leave a stamp on a row that now points at another IMS rate.
 * Real Postgres. Mutation: take the FOR UPDATE out of the helper -> the stamp comes back.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

test('an import that changes nothing waits for a concurrent re-point and does not write the old stamp back over it', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { writeStorefrontTaxMapping } = await import('@/lib/tax/storefront-mapping-write')
  const tag = `ZZ${Math.random().toString(36).slice(2, 8)}`
  const id = String(5_000_000 + Math.floor(Math.random() * 900_000))
  const a = await db.taxRate.create({ data: { name: `${tag} A`, rate: '0.2000', usedFor: 'SALES' } })
  const b = await db.taxRate.create({ data: { name: `${tag} B`, rate: '0.2000', usedFor: 'SALES' } })
  t.after(async () => {
    await db.shoppingTaxRateMapping.deleteMany({ where: { externalTaxRateId: id } })
    await db.taxRate.deleteMany({ where: { id: { in: [a.id, b.id] } } })
  })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: id, externalName: `${tag} A`, externalCountry: 'GB', externalRatePct: '20.0000', externalClass: 'standard', taxRateId: a.id, storeIdentity: 'https://store.example' } })
  const key = { connector: 'woocommerce', externalTaxRateId: id }

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const holding = new Promise<void>((resolve) => { held = resolve })
  const one = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM shopping_tax_rate_mappings WHERE "externalTaxRateId" = ${id} FOR UPDATE`
    await tx.shoppingTaxRateMapping.update({ where: { connector_externalTaxRateId: key }, data: { taxRateId: b.id, storeIdentity: null } })
    held()
    await gate
  })
  try {
    await holding
    const two = db.$transaction((tx) => writeStorefrontTaxMapping(tx, key, { externalName: `${tag} A` }, null))
    let waiting = 0
    for (let i = 0; i < 200 && waiting === 0; i++) {
      waiting = Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted`)[0]?.n ?? 0)
      if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(waiting >= 1, 'PRECONDITION: the second writer is blocked on the first writer\'s row')
    release()
    const [, result] = await Promise.all([one, two])
    const row = await db.shoppingTaxRateMapping.findUnique({ where: { connector_externalTaxRateId: key } })
    assert.equal(row?.taxRateId, b.id, 'the re-point stands')
    assert.equal(row?.storeIdentity, null, 'and the old stamp did not come back')
    assert.deepEqual(result, { created: false, stampCleared: false })
  } finally {
    release()
    await Promise.allSettled([one])
  }
})
