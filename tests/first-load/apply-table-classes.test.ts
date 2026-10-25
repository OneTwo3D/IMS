import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { FRESH_RUN_MAY_HOLD, TABLE_CLASSES, tablesOfKind } from '../../lib/first-load/apply/table-classes.ts'
import { precondition } from './helpers.ts'

/** Every table of the schema is classified; the registry has no stale entry; a new table forces a decision. */

function schemaTables(): string[] {
  const text = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const tables: string[] = []
  for (const match of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) tables.push(/@@map\("([^"]+)"\)/.exec(match[2]!)?.[1] ?? match[1]!)
  return tables.sort()
}

test('every table of prisma/schema.prisma is classified, and the registry names no table the schema does not have', (t) => {
  // Mutation named: delete one entry (or add a model to the schema) -> the first assertion fails and names it.
  const tables = schemaTables()
  precondition(t, 'schema tables', tables.length)
  const registry = Object.keys(TABLE_CLASSES).filter((name) => name !== '_prisma_migrations').sort()
  assert.deepEqual(tables.filter((name) => !(name in TABLE_CLASSES)), [], 'a schema table nobody classified')
  assert.deepEqual(registry.filter((name) => !tables.includes(name)), [], 'a registry entry for a table the schema does not have')
  assert.ok('_prisma_migrations' in TABLE_CLASSES)
})

test('every entry carries a reason, the three kinds are all used, and the runner-written tables are the ones the importers write', (t) => {
  const kinds = new Set(Object.values(TABLE_CLASSES).map((c) => c.kind))
  precondition(t, 'entries', Object.keys(TABLE_CLASSES).length)
  assert.deepEqual([...kinds].sort(), ['CONFIG_ALLOWED', 'MUST_BE_EMPTY', 'RUNNER_WRITES'])
  for (const [name, entry] of Object.entries(TABLE_CLASSES)) assert.ok(entry.reason.trim().length >= 10, `${name} has a reason`)
  assert.deepEqual(tablesOfKind('RUNNER_WRITES'), [
    'activity_logs', 'bom_items', 'boms', 'cost_layers', 'first_load_apply_runs', 'product_categories', 'product_components', 'products', 'purchase_order_lines', 'purchase_orders',
    'stock_levels', 'stock_movements', 'supplier_products', 'suppliers', 'tax_rate_components', 'tax_rates',
  ])
  for (const name of FRESH_RUN_MAY_HOLD) assert.equal(TABLE_CLASSES[name]?.kind, 'RUNNER_WRITES')
})

test('the tables a stock count, a stock transfer, a sale, a customer, an invoice, a payment, manufacturing and a return live in are MUST_BE_EMPTY', () => {
  for (const name of ['stock_counts', 'stock_count_lines', 'stock_transfers', 'stock_transfer_lines', 'sales_orders', 'sales_order_lines', 'customers', 'purchase_invoices', 'payments', 'production_orders', 'purchase_returns', 'sales_order_refunds', 'shipments', 'kits']) {
    assert.equal(TABLE_CLASSES[name]?.kind, 'MUST_BE_EMPTY', name)
  }
})
