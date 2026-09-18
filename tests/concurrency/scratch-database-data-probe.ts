/**
 * "DOES THIS DATABASE HOLD APPLICATION DATA?" — asked once, used by both the stamper and the guard
 * (o3d-zzgp r8).
 *
 * Round 7 wrote this query inside scripts/stamp-scratch-database.ts, so only the STAMPER could ask
 * it; the review then showed the guard — the thing that decides whether the tier seeds and installs
 * DDL — had no data term at all (M-1). One implementation, imported by both, is what keeps the two
 * from answering the question differently.
 *
 * WHAT COUNTS. Every table-like relation that stores rows — ordinary and partitioned tables and
 * MATERIALIZED VIEWS (review L-2: a matview with rows is data as surely as a table is) — in every
 * schema but the server's own. Partitions are skipped because their parent is probed and sees
 * their rows. FOREIGN TABLES are not read at all: probing one is a query against ANOTHER server,
 * which this must never do on someone's behalf; their mere presence is reported instead, and both
 * callers refuse on it — a database wired to another server is not a self-contained scratch
 * database.
 *
 * WHAT DOES NOT COUNT: exactly three tables, IN THE APPLICATION'S OWN SCHEMA. A fresh
 * `prisma migrate deploy` seeds rows into them, measured 2026-09-17 on this branch (262
 * migrations, 109 tables): `_prisma_migrations` (262 rows), `settings` (2) and
 * `shopping_status_mappings` (7), and nothing else. Round 7 exempted those NAMES in ANY schema
 * (review L-1: `tenant.settings` holding a row was exempt), which lib/db/database-url-schema.mjs
 * makes a real gap — it documents `CREATE SCHEMA "ims"` as a per-tenant layout. The exemption is
 * now `<appSchema>.<name>`, where `appSchema` is the schema the application itself resolves from
 * DATABASE_URL (`public` unless the URL names another).
 */

export const MIGRATION_SEEDED_TABLE_NAMES = ['_prisma_migrations', 'settings', 'shopping_status_mappings'] as const

/** One row of the catalogue query below. */
export type CatalogueRelation = { schema: string; name: string; kind: string }

/** The catalogue query: every row-storing relation outside the server's own schemas. */
export const ROW_STORING_RELATIONS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'm', 'f')
     AND NOT c.relispartition
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_toast%'
     AND n.nspname NOT LIKE 'pg\\_temp%'
   ORDER BY 1, 2`

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export type PopulatedTableProbe = {
  /** One statement answering "which of these hold a row?", or null when there is nothing to ask. */
  sql: string | null
  /** `schema.name` of every relation the statement probes, in order — for tests and messages. */
  probed: string[]
  /** `schema.name` of the migration-seeded tables that were exempted, and nothing else. */
  exempted: string[]
  /** `schema.name` of foreign tables, which are never read. */
  foreign: string[]
}

/**
 * PURE: build the probe from the catalogue's answer. Exported so the exemption rule, the relkind
 * handling and the quoting are tested directly (review M-5: round 7's unit table injected the
 * populated-table array, so it proved the refusal branches, not that this statement is right).
 */
export function buildPopulatedTableProbe(relations: ReadonlyArray<CatalogueRelation>, appSchema: string): PopulatedTableProbe {
  const exemptQualified = new Set(MIGRATION_SEEDED_TABLE_NAMES.map((name) => `${appSchema}.${name}`))
  const probed: string[] = []
  const exempted: string[] = []
  const foreign: string[] = []
  const probes: string[] = []
  for (const relation of relations) {
    const qualifiedName = `${relation.schema}.${relation.name}`
    if (relation.kind === 'f') {
      foreign.push(qualifiedName)
      continue
    }
    if (exemptQualified.has(qualifiedName)) {
      exempted.push(qualifiedName)
      continue
    }
    probed.push(qualifiedName)
    probes.push(
      `SELECT ${quoteLiteral(qualifiedName)} AS t `
      + `WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)})`,
    )
  }
  return { sql: probes.length > 0 ? probes.join(' UNION ALL ') : null, probed, exempted, foreign }
}

export type DataFacts = {
  /** `schema.name` of every non-exempt relation holding at least one row. */
  populated: string[]
  /** `schema.name` of every foreign table present. */
  foreign: string[]
}

type QueryClient = { query: <T>(sql: string) => Promise<{ rows: T[] }> }

/** Ask the server. Two round trips: the catalogue, then one UNION ALL of EXISTS probes. */
export async function readDataFacts(client: QueryClient, appSchema: string): Promise<DataFacts> {
  const { rows: relations } = await client.query<CatalogueRelation>(ROW_STORING_RELATIONS_SQL)
  const probe = buildPopulatedTableProbe(relations, appSchema)
  if (probe.sql === null) return { populated: [], foreign: probe.foreign }
  const { rows } = await client.query<{ t: string }>(probe.sql)
  return { populated: rows.map((row) => row.t), foreign: probe.foreign }
}

// ---------------------------------------------------------------------------------------------
// THE GUARD'S DATA TERM (o3d-zzgp r8, review M-1) — narrower than the stamper's, and why
// ---------------------------------------------------------------------------------------------

/**
 * Tables every INSTALLED application populates and the concurrency tier never touches, so a row in
 * any of them means "this database has been set up as a real IMS" — and the guard refuses it even
 * when it carries a valid marker.
 *
 * WHY NOT THE STAMPER'S WHOLE CHECK. The review asked the guard to refuse "when a non-seeded table
 * has rows". MEASURED 2026-09-18, that would break the tier it protects: after ONE green
 * `npm run test:concurrency` (132/132) on a freshly migrated, stamped database, 23 non-seeded tables
 * held rows — products 47, warehouses 85, stock_transfers 41, wms_asn_maps 45 … — and `settings` had
 * grown from 2 to 12. Each tier file is its own process, started as the test runner schedules it,
 * so a guard that refused on those rows would refuse whichever guarded file started after another
 * file had seeded — and every re-run of the tier against the same database.
 * A product row is therefore NOT evidence that a database was repurposed; the tier writes them.
 *
 * WHAT IS EVIDENCE: the three tables below. `prisma/seed.ts` upserts an organisation and the
 * currencies, and the install bootstrap creates a user, so no installed IMS has them empty; a fresh
 * `prisma migrate deploy` leaves all three empty (measured), a full tier run leaves all three empty
 * (measured), and no file in tests/concurrency writes any of them (checked by grep; `tax_rates` was
 * a candidate and is NOT here because two refund race tests create and remove one mid-run). If a
 * future concurrency test does write one, the guard refuses in CI and names the table — loud, and
 * in the safe direction.
 *
 * WHAT IT STILL DOES NOT CATCH, said here and in the guard: a stamped database that has gained
 * application rows WITHOUT being set up as an installation — product rows, stock — is
 * indistinguishable from one the tier itself has seeded. For that database the declaration is the
 * only remaining barrier.
 */
export const INSTALLATION_EVIDENCE_TABLE_NAMES = ['users', 'organisations', 'currencies'] as const

/** Which installation-evidence tables, in the application's schema, hold a row. */
export async function readInstallationEvidence(client: QueryClient, appSchema: string): Promise<string[]> {
  const { rows: present } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${quoteLiteral(appSchema)}
        AND c.relkind IN ('r', 'p')
        AND c.relname IN (${INSTALLATION_EVIDENCE_TABLE_NAMES.map(quoteLiteral).join(', ')})`,
  )
  if (present.length === 0) return []
  const sql = present
    .map((row) => `SELECT ${quoteLiteral(`${appSchema}.${row.name}`)} AS t `
      + `WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(appSchema)}.${quoteIdentifier(row.name)})`)
    .join(' UNION ALL ')
  const { rows } = await client.query<{ t: string }>(sql)
  return rows.map((row) => row.t)
}
