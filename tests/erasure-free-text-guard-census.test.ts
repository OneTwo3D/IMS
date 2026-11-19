import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { ERASURE_CLASSIFICATION } from '../lib/domain/erasure/erasure-classification.ts'
import { GUARDED_FREE_TEXT, UNGUARDED_FREE_TEXT, sqlColumn } from '../lib/domain/erasure/free-text-guard.ts'

/**
 * THE FREE-TEXT COLUMN CENSUS. A free-text error / note / reason / detail / message / warning / payload column on a table linked to an order
 * is either GUARDED in the database (a trigger replaces it with the erasure marker for an erased order, whoever writes it), or listed in
 * UNGUARDED_FREE_TEXT with the reason. A new such column, classified `erased`, fails here until one or the other is true. The writers of the
 * guarded columns are pinned below as well, so a new writer is a conscious addition, though the trigger already covers it.
 */
const FREE_TEXT_NAME = /(error|message|detail|reason|note|notes|warning|description|payload|text)$/i
const cwd = new URL('..', import.meta.url).pathname

test('every erased free-text column on an order-linked table is guarded by a trigger or listed with a reason', () => {
  const guarded = new Set(GUARDED_FREE_TEXT.flatMap((g) => [...g.columns, ...(g.jsonColumns ?? [])].map((c) => `${g.model}.${c}`)))
  const unaccounted: string[] = []
  for (const [model, entry] of Object.entries(ERASURE_CLASSIFICATION)) {
    for (const column of entry.erased) {
      if (!FREE_TEXT_NAME.test(column)) continue
      const key = `${model}.${column}`
      if (!guarded.has(key) && !(key in UNGUARDED_FREE_TEXT)) unaccounted.push(key)
    }
  }
  assert.deepEqual(unaccounted, [], `guard these in a migration and in free-text-guard.ts, or list them in UNGUARDED_FREE_TEXT with a reason: ${unaccounted.join(', ')}`)
  // Nothing is guarded that the classification does not call erased, and every unguarded entry still names an erased column.
  for (const key of guarded) {
    const [model, column] = key.split('.') as [string, string]
    assert.ok(ERASURE_CLASSIFICATION[model]!.erased.includes(column), `${key} is guarded but not classified erased`)
  }
  for (const key of Object.keys(UNGUARDED_FREE_TEXT)) {
    const [model, column] = key.split('.') as [string, string]
    assert.ok(ERASURE_CLASSIFICATION[model]!.erased.includes(column), `${key} is listed unguarded but is not classified erased`)
  }
})

test('the migration installs a trigger for every guarded table and column, and the payment note guard', () => {
  const dir = new URL('../prisma/migrations/', import.meta.url)
  const name = readdirSync(dir).find((n) => n.endsWith('_erased_order_free_text_guard'))
  assert.ok(name, 'the migration exists')
  const sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8')
  for (const g of GUARDED_FREE_TEXT) {
    const create = new RegExp(`CREATE TRIGGER \\w+ BEFORE INSERT OR UPDATE OF ([^\\n]+) ON "${g.table}"[\\s\\S]*?erased_order_free_text_guard\\('${g.orderIdColumn}'([^)]*)\\)`).exec(sql)
    assert.ok(create, `a trigger on ${g.table}`)
    for (const c of g.columns) assert.ok(create[1]!.includes(`"${sqlColumn(g, c)}"`) && create[2]!.includes(`'${sqlColumn(g, c)}'`), `${g.table}.${c} is in the trigger`)
    for (const c of g.jsonColumns ?? []) assert.ok(create[1]!.includes(`"${c}"`) && create[2]!.includes(`'json:${c}'`), `${g.table}.${c} is in the trigger`)
  }
  assert.match(sql, /CREATE TRIGGER payments_erased_note BEFORE INSERT OR UPDATE OF "notes" ON "payments"/)
})

/** The writers of the guarded tables, by file and count. A new writer is covered by the trigger, and is added here on purpose. */
const WRITERS: Record<string, Record<string, number>> = {
  wmsOrderStatusSnapshot: { 'lib/domain/wms/order-status-sweep.ts': 3 },
  wmsOrderPushLink: {
    'app/actions/sync-exceptions.ts': 8, 'app/actions/wms-order-push.ts': 2,
    // The switchover take-over (G_create) adopts a Mintsoft order by upserting a link: ids, a state and timestamps only, no free text; the trigger covers it all the same.
    // The legacy bridge import (`cutover:legacy-import`, and `--resolve`) writes IMS's own link rows from the bridge's order meta: a create and a compare-and-set adopt of an unclaimed
    // placeholder. It writes ids, a state and timestamps; its only text column is `lastError` (a fixed constant dead-letter reason, never bridge or customer text), which is one of the trigger's guarded columns, so an erased order's
    // text cannot be written back by it; pinned on purpose.
    'lib/connectors/mintsoft/legacy-bridge-import/ports.ts': 2,
    'lib/connectors/mintsoft/switchover/gaps.ts': 1, 'lib/domain/outbound-shadow/retire-held-backlog.ts': 1,
    'lib/domain/wms/dispatch-sweep.ts': 10, 'lib/domain/wms/double-postage.ts': 1, 'lib/domain/wms/mixed-scope-record.ts': 6, 'lib/domain/wms/operator-task-done.ts': 1, 'lib/domain/wms/order-push-sweep.ts': 19, 'lib/domain/wms/order-reconcile-sweep.ts': 1, 'lib/domain/wms/scope-dirty.ts': 1, 'lib/fulfillment/external-fulfillment.ts': 1,
  },
  wmsOrderDiscrepancy: { 'app/actions/sync-exceptions.ts': 2, 'lib/domain/wms/dispatch-sweep.ts': 3, 'lib/domain/wms/order-reconcile-sweep.ts': 12 },
  wmsReturnsInbox: { 'app/actions/mintsoft-sync.ts': 2, 'lib/connectors/mintsoft/sync/returns-sync.ts': 1 },
  salesOrderRefund: {
    'app/actions/sales.ts': 2, 'lib/domain/accounting/back-reference.ts': 1, 'lib/domain/sales/refund-accounting-discharge.ts': 1,
    'lib/domain/sales/refund-basis-backfill.ts': 1, 'lib/domain/sales/refund-service.ts': 9,
    // Stamps `stockCorrectionQueuedAt`, a timestamp: not a free-text column, so the trigger is irrelevant to it; pinned all the same.
    'lib/connectors/woocommerce/sync/refund-stock-correction.ts': 1,
    // Stamps `deferralAdjustmentRef`, a daily-batch journal reference: not a free-text column, so the trigger is irrelevant to it; pinned all the same.
    'lib/connectors/xero/daily-sync.ts': 1,
    // Sets `externalRefundId` (a WooCommerce refund id) when a person confirms a storefront refund settles an IMS refund: not a free-text column, so the trigger is irrelevant to it; pinned all the same.
    'lib/domain/sales/shop-refund-tasks.ts': 1,
  },
}

test('the writers of the guarded tables are pinned (each is covered by the trigger)', () => {
  for (const [delegate, expected] of Object.entries(WRITERS)) {
    const out = execFileSync('git', ['grep', '-cE', `\\b${delegate}\\.(create|createMany|update|updateMany|upsert)\\(`, '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
    const found: Record<string, number> = {}
    for (const line of out) {
      const i = line.lastIndexOf(':')
      const file = line.slice(0, i)
      if (file.startsWith('lib/domain/erasure/')) continue // the erasure itself
      found[file] = Number(line.slice(i + 1))
    }
    assert.deepEqual(found, expected, delegate)
  }
})
