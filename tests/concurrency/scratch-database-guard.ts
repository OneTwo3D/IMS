/**
 * REFUSE TO TOUCH ANY DATABASE THAT HAS NOT BEEN MARKED DISPOSABLE — AND DO IT BEFORE
 * ANYTHING WRITES (o3d-zzgp round 4, Codex HIGH-2; rounds 5 and 6).
 *
 * Round 3's race test checked `current_database() <> 'onetwo3d_ims_dev'` AFTER it had
 * already seeded products, warehouses, a transfer, stock and an active WMS binding — so
 * the one database it named was mutated before the refusal, and every OTHER database
 * passed the check and went on to receive DDL. Running FIRST, on a read-only connection,
 * is the half that made that a P1 fix and is unchanged.
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * WHY THE NAME IS NO LONGER EVIDENCE OF ANYTHING (round 6, independent review HIGH-1)
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * Round 4 asked for an `ims_scratch_*` NAME. Round 5 added "or an exact declaration",
 * and defended it with a refuse-list built on the claim that "every real database in this
 * estate is named onetwo3d…". THAT CLAIM WAS FALSE, and this repository's own provisioner
 * says so: scripts/provision-ims-tenant.sh names every tenant's LIVE database
 * `ims_<slug>` (`DB_NAME="${DB_NAME:-ims_${DB_SAFE_SLUG}}"`), .env.example ships
 * `…/onetwoinventory`, and scripts/install.sh prompts for an arbitrary name. So an
 * operator on a tenant host could export `IMS_CONCURRENCY_SCRATCH_DB=ims_acme` — the very
 * value round 5's refusal message told them to set — and this suite would have seeded a
 * live tenant database and installed a trigger in it. Two rounds of guessing which names
 * are safe produced two wrong lists; a third guess is not the answer.
 *
 * SO THE SERVER IS ASKED FOR PROOF INSTEAD, and all of these must hold:
 *
 *   1. DECLARED — `IMS_CONCURRENCY_SCRATCH_DB` names the connected database EXACTLY.
 *      (Round 5 let a scratch-shaped NAME satisfy this on its own; that is restored to a
 *      conjunction — see the review's MEDIUM-3. A declaration that names a different
 *      database is not a declaration about this one.)
 *   2. MARKED — the database carries `SCRATCH_DATABASE_MARKER` as its own comment
 *      (`COMMENT ON DATABASE … IS '…'`, read back with `shobj_description`). Whoever
 *      created the database stamped it; a database that was created to hold real data
 *      has no such stamp and cannot acquire one by accident.
 *   3. NOT A REPLICA, NOT A TEMPLATE — `pg_is_in_recovery()` is false, `datistemplate` is
 *      false, and no logical-replication subscription targets it. A replica of production
 *      is invisible to every name rule, and a logical one is writable.
 *   4. NOT OBVIOUSLY REAL — `ALWAYS_REFUSED_DATABASE` does not match. This is the BELT,
 *      checked first so it outranks everything above: it cannot be the fix (it is a name
 *      rule, and name rules are what failed twice), but it means a stamp applied to an
 *      obviously-real database is still refused.
 *
 * WHY A DATABASE COMMENT AND NOT A MARKER TABLE. The comment lives in `pg_shdescription`,
 * outside every schema, so it is invisible to `prisma migrate diff` and to the schema-drift
 * gate that runs beside these tests — a marker TABLE would show up as drift and could fail
 * the very CI job this guard runs in. It survives `prisma migrate deploy`, it needs
 * ownership of the database to set, and `scripts/stamp-scratch-database.ts` is the one
 * thing that sets it (and refuses to stamp anything rule 3 or 4 rejects).
 *
 * WHAT THIS STILL DOES NOT STOP, said plainly: someone who deliberately stamps a live
 * database AND declares it by name has performed two deliberate acts naming that database,
 * and the guard will accept it. That is what turning a convention into a capability means.
 * What it removes is the accident — a stale `DATABASE_URL`, an inherited `.env.local`, a
 * tenant host, a mistyped name — which is every way this has actually gone wrong.
 *
 * The check runs on its own connection with `default_transaction_read_only=on`, so the
 * guard itself cannot write even if it is wrong, and it asks the SERVER for every fact
 * rather than trusting the URL. Call it first in every test, before importing anything
 * that opens the application pool.
 */

export const SCRATCH_DATABASE_OPT_IN_ENV = 'IMS_CONCURRENCY_SCRATCH_DB'

/**
 * The stamp. Exact-match, and deliberately a sentence no one writes by accident.
 * `scripts/stamp-scratch-database.ts` applies it; docs/development.md tells operators to.
 */
export const SCRATCH_DATABASE_MARKER =
  'ims-scratch-database: created for a test run and safe to destroy (o3d-zzgp)'

/**
 * THE BELT, not the fix. Names that can never be a scratch database however they are
 * stamped or declared: the product's canonical database (`onetwoinventory`), this estate's
 * own (`onetwo3d…`), the server's (`postgres…`, `template…`, `pg_…`), and anything whose
 * name contains `prod` or `live` in ANY form — `ims-prod`, `imslive`, `ims-production`,
 * `prod_ims` all matched, which round 5's `(^|_)` anchoring missed.
 *
 * DELIBERATELY BLUNT, reversing round 5's carve-out for `delivery` (which contains
 * `live`) and catching `…products…` too. A false refusal costs one rename of a throwaway
 * database; the substring rule has no edge cases to get wrong, and since round 6 the belt
 * is not what admits anything — the marker is.
 *
 * NOT IN THE LIST, on purpose: the tenant shape `ims_<slug>`. It is indistinguishable by
 * name from CI's own `ims_ci`, so a name rule cannot separate them — which is exactly why
 * rule 2 exists. `ims_acme` is refused for having no stamp, and the unit table proves it.
 */
export const ALWAYS_REFUSED_DATABASE = /^(postgres|template|pg_)|onetwo3d|onetwoinventory|prod|live/i

export class NotAScratchDatabaseError extends Error {
  override readonly name = 'NotAScratchDatabaseError'
}

/** Everything the decision rests on, every field answered by the SERVER (except `optIn`). */
export type ScratchDatabaseFacts = {
  /** `current_database()`. */
  connectedDatabase: string
  /** `process.env.IMS_CONCURRENCY_SCRATCH_DB`. */
  optIn: string | undefined
  /** `shobj_description(<this database>, 'pg_database')` — null when unstamped. */
  databaseComment: string | null
  /** `pg_is_in_recovery()`. */
  inRecovery: boolean
  /** `pg_database.datistemplate`. */
  isTemplate: boolean
  /**
   * Logical-replication subscriptions targeting this database, or `null` when the catalog
   * could not be read. `null` does NOT refuse: a subscriber that is a copy of production
   * is already refused for having no stamp, and refusing on an unreadable catalog would
   * refuse every ordinary scratch database on a locked-down server.
   */
  subscriptionCount: number | null
}

/** The pure decision, exported so every refusal path can be tested without a server. */
export function scratchDatabaseVerdict(facts: ScratchDatabaseFacts): { ok: true } | { ok: false; reason: string } {
  const db = facts.connectedDatabase
  if (!db) {
    return { ok: false, reason: 'the server reported no database name; refusing because nothing can be established about it' }
  }
  // THE BELT, first, so it outranks the declaration and the stamp alike.
  if (ALWAYS_REFUSED_DATABASE.test(db)) {
    return {
      ok: false,
      reason: `connected database "${db}" is a real or server-owned database by name (${ALWAYS_REFUSED_DATABASE}); `
        + 'no declaration and no marker makes one of these acceptable',
    }
  }
  if (facts.inRecovery) {
    return { ok: false, reason: `connected database "${db}" is on a server in recovery (a replica); it is not ours to seed` }
  }
  if (facts.isTemplate) {
    return { ok: false, reason: `connected database "${db}" is a template database; seeding it would spread into every database cloned from it` }
  }
  if (facts.subscriptionCount !== null && facts.subscriptionCount > 0) {
    return {
      ok: false,
      reason: `connected database "${db}" is the target of ${facts.subscriptionCount} logical-replication subscription(s), `
        + 'so it is a copy of another database rather than one created for this run',
    }
  }
  if (facts.optIn !== db) {
    return {
      ok: false,
      reason: `${SCRATCH_DATABASE_OPT_IN_ENV} must name the connected database exactly ("${db}"); it is `
        + `${facts.optIn === undefined ? 'unset' : `"${facts.optIn}"`}`,
    }
  }
  if (facts.databaseComment !== SCRATCH_DATABASE_MARKER) {
    return {
      ok: false,
      reason: `connected database "${db}" is not marked disposable: its database comment is `
        + `${facts.databaseComment === null ? 'unset' : `"${facts.databaseComment}"`}, not the scratch marker. `
        + 'A database created for a test run is stamped by scripts/stamp-scratch-database.ts; if this is a real '
        + 'database, it is not one these tests may seed',
    }
  }
  return { ok: true }
}

let verified: Promise<string> | null = null

/**
 * Resolve to the verified scratch database name, or throw before anything has been
 * written. Memoised per process: the URL cannot change underneath a test run, and the
 * application pool is created from the same environment afterwards.
 */
export function assertScratchDatabaseBeforeAnyWrite(): Promise<string> {
  verified ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new NotAScratchDatabaseError('DATABASE_URL is not set')

    const { default: pg } = await import('pg')
    const client = new pg.Client({
      connectionString: databaseUrl,
      options: '-c default_transaction_read_only=on',
      application_name: 'o3d-scratch-database-guard',
    })
    await client.connect()
    let facts: ScratchDatabaseFacts
    try {
      const { rows } = await client.query<{
        name: string
        comment: string | null
        in_recovery: boolean
        is_template: boolean
      }>(`SELECT current_database() AS name,
                 shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS comment,
                 pg_is_in_recovery() AS in_recovery,
                 (SELECT datistemplate FROM pg_database WHERE datname = current_database()) AS is_template`)
      // Separate, and allowed to fail: pg_subscription is not readable to every role.
      let subscriptionCount: number | null = null
      try {
        const subscriptions = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_subscription
            WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
        subscriptionCount = Number(subscriptions.rows[0]!.count)
      } catch {
        subscriptionCount = null
      }
      facts = {
        connectedDatabase: String(rows[0]!.name ?? ''),
        optIn: process.env[SCRATCH_DATABASE_OPT_IN_ENV],
        databaseComment: rows[0]!.comment ?? null,
        inRecovery: rows[0]!.in_recovery === true,
        isTemplate: rows[0]!.is_template === true,
        subscriptionCount,
      }
    } finally {
      await client.end().catch(() => {})
    }

    const verdict = scratchDatabaseVerdict(facts)
    if (!verdict.ok) throw new NotAScratchDatabaseError(`REFUSING before any write: ${verdict.reason}`)
    return facts.connectedDatabase
  })()
  return verified
}
