// `npm run test:db` (o3d-dzsd / o3d-7zes). Runs tests/db/** against the DATABASE_URL in the environment,
// then holds the run to the skip census in scripts/db-tier-census.mjs: every file on disk must have
// executed at least one test and skipped none.
//
// The gate variables below stay (the three RUN_DB_RETENTION_TESTS files still throw on load if handed the
// REQUIRE_ half alone), but nothing DEPENDS on them any more: a renamed pair, or both halves dropped, makes
// the gated files skip, and the census fails the run for it.
//
// FAIL-CLOSED ON THE CENSUS ITSELF. The verdict is read back from a file the reporter writes. A reporter
// that did not load, did not finish, or was dropped from the command line leaves no verdict, and no verdict
// is a failure - never "nothing to complain about".
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tierFiles } from './db-tier-census.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = tierFiles(repoRoot)
if (files.length === 0) {
  console.error('db-tier: no tests/db/**/*.test.ts files found')
  process.exit(1)
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'db-tier-census-'))
const verdictFile = path.join(scratch, 'verdict.json')
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

const result = spawnSync(
  tsx,
  [
    '--test',
    '--test-concurrency=1',
    '--experimental-test-module-mocks',
    '--import', './tests/no-outbound-network.cjs',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/db-tier-census.mjs', '--test-reporter-destination=stdout',
    ...files,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_DB_RETENTION_TESTS: '1',
      REQUIRE_DB_RETENTION_TESTS: '1',
      DB_TIER_ROOT: repoRoot,
      DB_TIER_CENSUS_OUT: verdictFile,
    },
  },
)

let exit = result.status ?? 1
let census
try {
  census = JSON.parse(readFileSync(verdictFile, 'utf8'))
} catch {
  console.error('db-tier census: NO VERDICT was written - the reporter did not load or did not finish. Failing the run.')
  exit = 1
}
if (census && !census.ok) exit = 1
rmSync(scratch, { recursive: true, force: true })
process.exit(exit)
