import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { openWcCompletionRefusalIndexPredicateSql } from '../../lib/domain/sales/wc-sync-row-families'

const MIGRATION = 'prisma/migrations/20261121130000_wc_completion_refusal_open_index/migration.sql'

/** The executable statements only: every `--` comment line removed. */
function statements(path: string): string {
  return readFileSync(path, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
}

test('the open completion-refusal index predicate IS the string the shared definition renders', () => {
  const sql = statements(MIGRATION)
  assert.match(sql, /CREATE INDEX/, 'precondition: the migration builds an index')
  assert.ok(sql.includes(`WHERE ${openWcCompletionRefusalIndexPredicateSql()};`), 'the WHERE clause is exactly what the shared module renders')
  assert.ok(sql.includes('ON "shopping_sync_logs" ("entityId")'))
})

test('the qualified rendering names every column of the unqualified one', () => {
  const plain = openWcCompletionRefusalIndexPredicateSql()
  const qualified = openWcCompletionRefusalIndexPredicateSql('"shopping_sync_logs"')
  assert.equal(qualified.replaceAll('"shopping_sync_logs".', ''), plain)
  assert.ok(qualified.includes('"shopping_sync_logs".status = \'QUARANTINED\''))
})
