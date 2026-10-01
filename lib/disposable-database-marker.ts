/**
 * THE DISPOSABLE-DATABASE STAMP, DEFINED ONCE (o3d-1q28).
 *
 * A database carries this exact text as its `COMMENT ON DATABASE` when — and only when — somebody
 * deliberately declared it destroyable: `npm run db:stamp-scratch -- <name>` issues it, and
 * `tests/concurrency/scratch-database-guard.ts` is the gate that reads it back before the
 * concurrency tier writes anything (o3d-zzgp).
 *
 * WHY THE DEFINITION LIVES IN `lib/` RATHER THAN BESIDE THAT GATE. `purgeExpiredActivityLogs`
 * (lib/activity-log-cleanup.ts) now refuses to run under the concurrency tier against a database
 * that does not carry this stamp, and shipped code may not import from `tests/`. The alternative —
 * writing the sentence out a second time in `lib/` — is the exact hazard this repository has
 * already been bitten by twice: a constant reproduced from memory agrees with the original until
 * the day one of the two copies is edited, and then the guard silently stops matching the stamp
 * the stamper issues. So there is ONE definition, here, and the test-side gate re-exports it.
 *
 * THE DATABASE NAME IS INSIDE THE MARKER on purpose (o3d-zzgp r7): a bare sentinel is keyed to the
 * database's OID, which a RENAME preserves and which `pg_dump -C`/`pg_dumpall` carry into a
 * restore, so a scratch database repurposed as a real one would have kept the capability for ever.
 * Every reader recomputes the expected text from `current_database()` and compares exactly.
 */

export const DISPOSABLE_DATABASE_MARKER_PREFIX = 'ims-scratch-database'

/** The exact database comment that marks `databaseName` destroyable. Compare with `===`. */
export function expectedDisposableDatabaseMarker(databaseName: string): string {
  return `${DISPOSABLE_DATABASE_MARKER_PREFIX}(${databaseName}): created for a test run and safe to destroy (o3d-zzgp)`
}
