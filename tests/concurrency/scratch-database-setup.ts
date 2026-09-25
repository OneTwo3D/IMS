/**
 * EVERY FILE IN tests/concurrency/ IMPORTS THIS FIRST (o3d-yvn8) — the census test
 * (tests/concurrency-scratch-database-census.test.ts) fails if one does not.
 *
 * When the tier is switched on (`RUN_DB_CONCURRENCY_TESTS=1`) it requires that
 * tests/concurrency/scratch-database-preload.mts already verified the database in THIS process —
 * which `npm run test:concurrency` arranges with `--import`. If not, it THROWS, synchronously, at
 * import: the importing file then fails to load, so it registers no hook and no test, and nothing it
 * would have written is written. That closes the direct-invocation path (`tsx --test
 * tests/concurrency/x.test.ts` with the flag exported) that the preload alone cannot see.
 *
 * With the tier switched off — every `npm run test:unit`, which collects these files and skips them —
 * it does nothing.
 */
export const SCRATCH_DATABASE_VERIFIED = Symbol.for('o3d.scratchDatabaseVerified')

export const CONCURRENCY_TIER_ENABLED = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

if (CONCURRENCY_TIER_ENABLED
  && typeof (globalThis as Record<symbol, unknown>)[SCRATCH_DATABASE_VERIFIED] !== 'string') {
  throw new Error(
    'REFUSING to load a concurrency test: RUN_DB_CONCURRENCY_TESTS=1 but the scratch database was not '
    + 'verified in this process. Run the tier with `npm run test:concurrency`, which preloads '
    + 'tests/concurrency/scratch-database-preload.mts (or pass `--import '
    + './tests/concurrency/scratch-database-preload.mts` yourself). See docs/development.md, '
    + '"Database-backed tiers" (o3d-yvn8).',
  )
}
