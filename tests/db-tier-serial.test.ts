import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The tests/db files share ONE database and mutate rows no file owns (settings, tax rates, the xero
 * token row) inside rolled-back transactions, so run in parallel they deadlock (40P01), see each
 * other's writes and signal each other's connections (pg_terminate_backend). The tier must run one
 * file at a time. Dropping the flag brings those CI flakes back.
 */
test('npm run test:db runs the shared-database tier one file at a time', () => {
  // test:db is the census wrapper (scripts/run-db-tier.mjs), which owns the runner arguments.
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['test:db'], 'node scripts/run-db-tier.mjs', 'test:db runs the wrapper')
  const wrapper = readFileSync(join(__dirname, '..', 'scripts', 'run-db-tier.mjs'), 'utf8')
  assert.match(wrapper, /'--test-concurrency=1'/, 'the wrapper must pass --test-concurrency=1')
})
