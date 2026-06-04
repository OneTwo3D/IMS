import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ACTIVITY_LOG_LEVEL_TAG_MIGRATION = 'prisma/migrations/20260405212718_activity_log_level_tag/migration.sql'

test('activity log level/tag migration backfills before adding not-null constraints', () => {
  const sql = readFileSync(ACTIVITY_LOG_LEVEL_TAG_MIGRATION, 'utf8')

  assert.doesNotMatch(sql, /ADD COLUMN\s+"tag"\s+TEXT\s+NOT NULL/i)
  assert.match(sql, /ADD COLUMN\s+"tag"\s+TEXT\b/i)
  assert.match(sql, /UPDATE\s+"activity_logs"[\s\S]+SET\s+"tag"\s+=\s+CASE[\s\S]+WHEN\s+"entityType"::text\s+=\s+'USER'\s+THEN\s+'auth'/i)
  assert.match(sql, /WHEN\s+"entityType"::text\s+IN\s+\('SALES_ORDER',\s*'CUSTOMER'\)\s+THEN\s+'sales'/i)
  assert.match(sql, /WHEN\s+"entityType"::text\s+IN\s+\('SUPPLIER',\s*'PURCHASE_ORDER'\)\s+THEN\s+'purchase'/i)
  assert.match(sql, /ELSE\s+'system'[\s\S]+END[\s\S]+WHERE\s+"tag"\s+IS\s+NULL/i)
  assert.doesNotMatch(sql, /SET\s+"tag"\s+=\s+'system'\s+WHERE\s+"tag"\s+IS\s+NULL/i)
  assert.match(sql, /UPDATE\s+"activity_logs"[\s\S]+SET\s+"description"\s+=\s+'\([^']*no description recorded\)'[\s\S]+WHERE\s+"description"\s+IS\s+NULL/i)
  assert.doesNotMatch(sql, /SET\s+"description"\s+=\s+''\s+WHERE\s+"description"\s+IS\s+NULL/i)
  assert.match(sql, /ALTER TABLE\s+"activity_logs"[\s\S]+ALTER COLUMN\s+"tag"\s+SET NOT NULL[\s\S]+ALTER COLUMN\s+"description"\s+SET NOT NULL/i)
})
