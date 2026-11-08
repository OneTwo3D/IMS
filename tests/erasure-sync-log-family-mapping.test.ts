import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { HELD_SALES_INVOICE_RECORD_KIND, WC_REFUND_PARK_RECORD_KIND } from '../lib/domain/sales/wc-sync-row-families.ts'

/**
 * The raw-payload projection finds a sync-log row's family from its recordKind column, in SQL (gdpr_sync_log_family). That mapping is the one place the database
 * restates the family rule, so it is pinned here to the shared constants: a renamed constant fails this test instead of silently mapping a family to 'unknown'.
 */
test('gdpr_sync_log_family names exactly the shared recordKind constants', () => {
  const dir = new URL('../prisma/migrations/', import.meta.url)
  const name = readdirSync(dir).find((n) => n.endsWith('_erasure_raw_payload_projection'))
  assert.ok(name)
  const sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8')
  const fn = /CREATE OR REPLACE FUNCTION gdpr_sync_log_family[\s\S]*?\$\$;/.exec(sql)?.[0]
  assert.ok(fn, 'the mapping function exists')
  assert.ok(fn.includes(`l."recordKind" = '${HELD_SALES_INVOICE_RECORD_KIND}' THEN 'held_invoice'`))
  assert.ok(fn.includes(`l."recordKind" = '${WC_REFUND_PARK_RECORD_KIND}' THEN 'refund_park'`))
  const named = [...fn.matchAll(/recordKind" = '([A-Z_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(named, [HELD_SALES_INVOICE_RECORD_KIND, WC_REFUND_PARK_RECORD_KIND].sort(), 'no other family value is named')
})
