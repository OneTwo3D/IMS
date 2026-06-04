import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ACTIVITY_LOG_LEVEL_TAG_MIGRATION = 'prisma/migrations/20260405212718_activity_log_level_tag/migration.sql'

test('activity log level/tag migration backfills before adding not-null constraints', () => {
  const sql = readFileSync(ACTIVITY_LOG_LEVEL_TAG_MIGRATION, 'utf8')

  assert.doesNotMatch(sql, /ADD COLUMN\s+"tag"\s+TEXT\s+NOT NULL/i)
  assert.match(sql, /ADD COLUMN\s+"tag"\s+TEXT\b/i)
  assert.match(sql, /UPDATE\s+"activity_logs"[\s\S]+SET\s+"tag"\s+=\s+'system'[\s\S]+WHERE\s+"tag"\s+IS\s+NULL/i)
  assert.match(sql, /UPDATE\s+"activity_logs"[\s\S]+SET\s+"description"\s+=\s+''[\s\S]+WHERE\s+"description"\s+IS\s+NULL/i)
  assert.match(sql, /ALTER TABLE\s+"activity_logs"[\s\S]+ALTER COLUMN\s+"tag"\s+SET NOT NULL[\s\S]+ALTER COLUMN\s+"description"\s+SET NOT NULL/i)
})
