/**
 * THE CONCURRENCY TIER'S BARRIER (o3d-yvn8). Loaded by `npm run test:concurrency` with
 * `--import`, so it runs in EVERY test-file process BEFORE that file is loaded — and, being an ES
 * module, its top-level `await` finishes before Node loads the file at all.
 *
 * WHY A PRELOAD, AND NOT A CALL IN EACH FILE. o3d-yvn8 found 31 of the 35 files in
 * tests/concurrency/ writing fixtures (and three of them running DDL) into whatever DATABASE_URL
 * reached, with no scratch-database check — the mechanism behind the 335 fixture rows once written
 * into the live-served dev database. Two obvious fixes do not work here, both measured:
 *   · a top-level `await` in a module each file imports: this project compiles to CommonJS, where
 *     tsx rejects top-level await outright;
 *   · a `before()` hook registered by such a module: node:test ran the FILE'S OWN root `before`
 *     (its seed) while the guard hook was still awaiting, and ran it even when the guard refused.
 * An `--import` preload is awaited by Node before the test file is evaluated, so no hook, no test
 * and no module the file imports can run first.
 *
 * WHAT IT DOES, only when the tier is switched on (`RUN_DB_CONCURRENCY_TESTS=1`):
 *   1. loads `.env.local` then `.env` exactly as every file's own `loadEnv()` does (dotenv never
 *      overrides an exported variable), so it checks the DATABASE_URL the file WILL use — not a
 *      different one;
 *   2. runs `assertScratchDatabaseBeforeAnyWrite()` — the server-side facts, the stamp naming the
 *      database and the exact declaration in IMS_CONCURRENCY_SCRATCH_DB. A refusal THROWS here, so
 *      the process fails and the test file is never loaded;
 *   3. records the verified name under `Symbol.for('o3d.scratchDatabaseVerified')`, which
 *      tests/concurrency/scratch-database-setup.ts — every file's FIRST import — requires. A run that
 *      bypasses this preload (e.g. `tsx --test tests/concurrency/x.test.ts` with the flag set)
 *      therefore throws at that import, before the file registers a single hook.
 */
import { config } from 'dotenv'

// The SAME key as scratch-database-setup.ts's SCRATCH_DATABASE_VERIFIED (Symbol.for is a global
// registry). Not imported from there: importing the setup module would run its check before the
// marker exists. tests/concurrency-scratch-database-census.test.ts pins that the two keys match.
const SCRATCH_DATABASE_VERIFIED = Symbol.for('o3d.scratchDatabaseVerified')

if (process.env.RUN_DB_CONCURRENCY_TESTS === '1') {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard.ts')
  const verified = await assertScratchDatabaseBeforeAnyWrite()
  ;(globalThis as Record<symbol, unknown>)[SCRATCH_DATABASE_VERIFIED] = verified
}
