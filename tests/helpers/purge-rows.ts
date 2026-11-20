// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/**
 * Remove EVERYTHING this fixture created, in foreign-key order, failing loudly on a violation. The children of each row are found from the catalogue
 * (the constraints that reference it) and deleted first, recursively; rows no constraint ties to an order (activity and sync logs) are removed by
 * the order id. Nothing is swallowed: a table the import started writing that this does not reach fails the run, so no test residue is left to disturb
 * a later test (the reconciliation tests count findings over the whole database).
 */
/** Refuse to delete anything unless the connected database is plainly disposable: its name says scratch / test / ci, or IMS_SCRATCH_DB=1 says so. */
async function assertDisposableDatabase(db: Any): Promise<void> {
  if (process.env.IMS_SCRATCH_DB === '1') return
  const rows: Array<{ name: string }> = await db.$queryRawUnsafe('SELECT current_database() AS name')
  const name = rows[0]?.name ?? ''
  if (!/(scratch|_ci$|_test|^test_)/i.test(name)) throw new Error(`purge-rows refuses to delete from database "${name}": it is not recognisably a scratch database (set IMS_SCRATCH_DB=1 to override)`)
}

export async function purge(db: Any, table: string, column: string, ids: string[], seen = new Set<string>()): Promise<void> {
  if (ids.length === 0) return
  await assertDisposableDatabase(db)
  const key = `${table}.${column}:${[...ids].sort().join(',')}`
  if (seen.has(key)) return
  seen.add(key)
  const fks: Array<{ child: string; childcol: string; refcol: string }> = await db.$queryRawUnsafe(
    `SELECT c.conrelid::regclass::text AS child, a.attname AS childcol, ra.attname AS refcol
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND c.confdeltype IN ('a', 'r') AND array_length(c.conkey, 1) = 1`,
    table,
  )
  for (const fk of fks) {
    if (fk.refcol !== column) continue
    const hasId: Array<{ n: number }> = await db.$queryRawUnsafe(`SELECT 1 AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`, fk.child.replace(/"/g, ''))
    if (hasId.length === 0) {
      await db.$executeRawUnsafe(`DELETE FROM ${fk.child} WHERE "${fk.childcol}" = ANY($1::text[])`, ids)
      continue
    }
    const children: Array<{ id: string }> = await db.$queryRawUnsafe(`SELECT id FROM ${fk.child} WHERE "${fk.childcol}" = ANY($1::text[])`, ids)
    await purge(db, fk.child, 'id', children.map((row) => row.id), seen)
  }
  await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE "${column}" = ANY($1::text[])`, ids)
}

