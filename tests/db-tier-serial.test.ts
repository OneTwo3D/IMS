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
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const script = pkg.scripts['test:db']
  assert.ok(script, 'package.json has a test:db script')
  assert.match(script, /--test-concurrency=1(\s|$)/, 'test:db must pass --test-concurrency=1')
})
