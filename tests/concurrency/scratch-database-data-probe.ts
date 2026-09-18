/**
 * "DOES THIS DATABASE HOLD APPLICATION DATA?" — asked once, used by both the stamper and the guard
 * (o3d-zzgp r8, hardened r9).
 *
 * Round 7 wrote this query inside scripts/stamp-scratch-database.ts, so only the STAMPER could ask
 * it; the review then showed the guard had no data term at all (r8 M-1). One implementation,
 * imported by both, keeps the two from answering the question differently.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE RULES FOR EVERY STATEMENT THIS MODULE SENDS (o3d-zzgp r9, review MEDIUM-1 and MEDIUM-2)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  1. NO CATALOGUE-DERIVED TEXT IS EVER A STRING LITERAL. Round 8 labelled each probe with a
 *     single-quoted `'schema.table'`. A literal's quoting depends on `standard_conforming_strings`,
 *     which a database owner can set with `ALTER DATABASE … SET standard_conforming_strings = off`;
 *     then a backslash escapes the closing quote. The reviewer used a schema named
 *     `" z;COMMIT;BEGIN READ WRITE;CREATE TABLE pwned();COMMIT;--"` holding tables `\` and `zz`
 *     and got `pwned` created THROUGH the stamper's read-only connection — reproduced here too.
 *     Probes are now labelled by their INDEX in a JS array (an integer this code generated) and
 *     mapped back in JS. Catalogue names appear only as DOUBLE-quoted identifiers, whose quoting
 *     has no backslash escape under any setting; the one value that is not an identifier (the
 *     table names searched for installation evidence) is a BIND PARAMETER.
 *  2. EVERY STATEMENT GOES THROUGH THE EXTENDED PROTOCOL (`queryMode: 'extended'`), whose Parse
 *     message accepts exactly one statement. A string that somehow still carried `;…` would be
 *     rejected by the server rather than run. Callers also pin `-c standard_conforming_strings=on`
 *     in their startup options; that is the third, independent layer, not the fix.
 *  3. FOREIGN TABLES ARE ENUMERATED FIRST AND STOP EVERYTHING. Round 8 said foreign tables were
 *     "refused on sight and never read"; that was false twice over. Its catalogue query filtered
 *     `NOT relispartition`, which hid a foreign PARTITION of a local partitioned table — and
 *     probing the parent then scanned it. And a foreign table that INHERITS a local table was
 *     reported, but the local parent was probed first, which scans its children. Measured with
 *     postgres_fdw: the remote tables' seq_scan went 0 → 1. Now every relkind 'f' relation is
 *     listed, partitions included, BEFORE any probe is built, and if there is one no probe runs
 *     at all — both callers refuse on the list.
 *
 * WHAT COUNTS as data: every row-storing relation — ordinary and partitioned tables and
 * materialized views — in every schema but the server's own (partitions themselves are skipped
 * because their parent sees their rows; with foreign tables excluded first, every partition is
 * local).
 *
 * WHAT DOES NOT COUNT: exactly three tables, IN THE APPLICATION'S OWN SCHEMA, which a fresh
 * `prisma migrate deploy` seeds (measured 2026-09-17: `_prisma_migrations` 262 rows, `settings` 2,
 * `shopping_status_mappings` 7, and nothing else across 109 tables). `appSchema` is the schema the
 * application resolves from DATABASE_URL (`public` unless the URL names another).
 */

export const MIGRATION_SEEDED_TABLE_NAMES = ['_prisma_migrations', 'settings', 'shopping_status_mappings'] as const

/**
 * Tables every INSTALLED application populates and the concurrency tier does not write — the guard's
 * data term (r8, review M-1).
 *
 * WHY NOT "ANY TABLE WITH DATA". Measured 2026-09-18: after ONE green `npm run test:concurrency`
 * (132/132) on a freshly migrated, stamped database, 23 non-seeded tables held rows — products 47,
 * warehouses 85, stock_transfers 41, wms_asn_maps 45 … — and `settings` grew from 2 to 12. Each tier
 * file is its own process, so a guard that refused on those rows would refuse whichever guarded file
 * started after another had seeded, and every re-run. A product row is therefore NOT evidence of
 * repurposing; the tier writes them.
 *
 * WHY THESE THREE. `prisma/seed.ts` upserts an organisation and the currencies, and the install
 * bootstrap creates a user; a fresh `prisma migrate deploy` leaves all three empty and a full tier
 * run leaves all three empty (both measured), and no file in tests/concurrency writes them (grep, and
 * the r8 reviewer independently searched for indirect writers and found none). `tax_rates` is NOT
 * here because two refund race tests create one. Since r9 they are searched in EVERY schema (review
 * L5), not only the application's.
 *
 * WHAT IT DOES NOT CATCH: a stamped database that gained application rows WITHOUT being set up as an
 * installation — product rows, stock — is indistinguishable from one the tier seeded, so no data
 * check refuses it; what remains is the declaration and the guard's name and server-state rules.
 */
export const INSTALLATION_EVIDENCE_TABLE_NAMES = ['users', 'organisations', 'currencies'] as const

/** One relation as the catalogue reports it. */
export type CatalogueRelation = { schema: string; name: string; kind: string }

/** EVERY foreign table, partitions included — nothing about it is filtered (review M-2). */
export const FOREIGN_TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, 'f' AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'f'
   ORDER BY 1, 2`

/** Every LOCAL row-storing relation outside the server's schemas. Foreign tables are listed above. */
export const ROW_STORING_RELATIONS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'm')
     AND NOT c.relispartition
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname !~ '^pg_(toast|temp)'
   ORDER BY 1, 2`

/** Installation-evidence tables in ANY schema; the names are a bind parameter, never interpolated. */
export const INSTALLATION_EVIDENCE_RELATIONS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND c.relname = ANY($1::text[])
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1, 2`

/** A double-quoted identifier. Its quoting has no backslash escape under any server setting. */
export function quoteIdentifier(value: string): string {
  if (value.includes('\u0000')) throw new Error('an identifier cannot contain NUL')
  return `"${value.replace(/"/g, '""')}"`
}

export type RelationProbe = {
  /** One statement answering "which of these hold a row?", or null when there is nothing to ask. */
  sql: string | null
  /** `schema.name` of every relation probed; a result row's `i` indexes into this array. */
  probed: string[]
  /** `schema.name` of the relations deliberately left out. */
  exempted: string[]
}

/**
 * PURE: one EXISTS per relation, UNION ALLed, each labelled by its array index. The statement
 * contains no string literal at all — every catalogue name is inside a double-quoted identifier —
 * which is what the unit tests assert.
 */
export function buildRelationProbe(
  relations: ReadonlyArray<CatalogueRelation>,
  exempt: (qualifiedName: string) => boolean = () => false,
): RelationProbe {
  const probed: string[] = []
  const exempted: string[] = []
  const members: string[] = []
  for (const relation of relations) {
    if (relation.kind === 'f') {
      // Unreachable through readDataFacts, which stops on foreign tables before building anything;
      // refused here too so no future caller can hand one in.
      throw new Error(`refusing to probe foreign table ${relation.schema}.${relation.name}: it would read another server`)
    }
    const qualifiedName = `${relation.schema}.${relation.name}`
    if (exempt(qualifiedName)) {
      exempted.push(qualifiedName)
      continue
    }
    members.push(
      `SELECT ${probed.length}::int AS i WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)})`,
    )
    probed.push(qualifiedName)
  }
  return { sql: members.length > 0 ? members.join(' UNION ALL ') : null, probed, exempted }
}

/** The data check's probe: everything except the three migration-seeded tables in `appSchema`. */
export function buildPopulatedTableProbe(relations: ReadonlyArray<CatalogueRelation>, appSchema: string): RelationProbe {
  const seeded = new Set(MIGRATION_SEEDED_TABLE_NAMES.map((name) => `${appSchema}.${name}`))
  return buildRelationProbe(relations, (qualifiedName) => seeded.has(qualifiedName))
}

/** The minimum a client must offer: a query config, always sent through the extended protocol. */
export type ExtendedQueryClient = {
  query: (config: { text: string; values: unknown[]; queryMode: 'extended' }) => Promise<{ rows: unknown[] }>
}

async function ask<T>(client: ExtendedQueryClient, text: string, values: unknown[] = []): Promise<T[]> {
  const { rows } = await client.query({ text, values, queryMode: 'extended' })
  return rows as T[]
}

async function runProbe(client: ExtendedQueryClient, probe: RelationProbe): Promise<string[]> {
  if (probe.sql === null) return []
  const rows = await ask<{ i: number }>(client, probe.sql)
  return rows.map((row) => {
    const name = probe.probed[Number(row.i)]
    if (name === undefined) throw new Error(`probe returned an index it did not issue: ${String(row.i)}`)
    return name
  })
}

/** `schema.name` of every foreign table present — asked FIRST by both callers. */
export async function readForeignTables(client: ExtendedQueryClient): Promise<string[]> {
  const rows = await ask<CatalogueRelation>(client, FOREIGN_TABLES_SQL)
  return rows.map((row) => `${row.schema}.${row.name}`)
}

export type DataFacts = {
  /** `schema.name` of every foreign table. When non-empty, NOTHING was probed. */
  foreign: string[]
  /** `schema.name` of every non-exempt relation holding at least one row. */
  populated: string[]
  /** Whether the row probe ran at all — false whenever `foreign` is non-empty. */
  probed: boolean
}

/** The stamper's data check. Foreign tables first; if there are any, stop before building a probe. */
export async function readDataFacts(client: ExtendedQueryClient, appSchema: string): Promise<DataFacts> {
  const foreign = await readForeignTables(client)
  if (foreign.length > 0) return { foreign, populated: [], probed: false }
  const relations = await ask<CatalogueRelation>(client, ROW_STORING_RELATIONS_SQL)
  const populated = await runProbe(client, buildPopulatedTableProbe(relations, appSchema))
  return { foreign, populated, probed: true }
}

export type InstallationFacts = {
  foreign: string[]
  /** `schema.name` of every installation-evidence table, in ANY schema, holding a row. */
  evidence: string[]
  probed: boolean
}

/** The guard's data term. Foreign tables first here too; then users/organisations/currencies anywhere. */
export async function readInstallationEvidence(client: ExtendedQueryClient): Promise<InstallationFacts> {
  const foreign = await readForeignTables(client)
  if (foreign.length > 0) return { foreign, evidence: [], probed: false }
  const relations = await ask<CatalogueRelation>(client, INSTALLATION_EVIDENCE_RELATIONS_SQL, [
    [...INSTALLATION_EVIDENCE_TABLE_NAMES],
  ])
  const evidence = await runProbe(client, buildRelationProbe(relations))
  return { foreign, evidence, probed: true }
}
