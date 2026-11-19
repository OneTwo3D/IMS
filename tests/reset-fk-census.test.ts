import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * Census: every model with a RESTRICT (default, or explicit) foreign key to a model the admin data reset deletes must itself be deleted by the
 * reset BEFORE its parent, or the reset fails on the foreign key after earlier stages have committed. A NEW such table fails here until the
 * reset is updated (or, if it is genuinely covered another way, it is added to KNOWN_UNCOVERED with the reason).
 */
// Pre-existing relationships this census found that the reset does not cover with a same-name deleteMany; they predate the census and are not
// in the scope of the change that added it. Do NOT add a new table here to make the test pass: fix the reset.
const KNOWN_UNCOVERED = new Set([
  'User->Supplier',
  'InventorySnapshot->Product',
  'InventorySnapshot->Warehouse',
  'InventoryReservationSnapshot->Product',
  'InventoryReservationSnapshot->Warehouse',
  'SupplierCreditNote->PurchaseOrder',
  'SupplierCreditNote->PurchaseInvoice',
  'Bom->Product',
])

const lower = (n: string) => n[0].toLowerCase() + n.slice(1)

test('the data reset deletes every RESTRICT-referencing child table before its parent', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
  const reset = await readFile(new URL('../app/actions/reset.ts', import.meta.url), 'utf8')
  const gaps: string[] = []
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const line of m[2].split('\n')) {
      const rel = line.match(/^\s*\w+\s+(\w+)\??\s+@relation\(.*fields:\s*\[\w+/)
      if (!rel || /onDelete:\s*(Cascade|SetNull)/.test(line)) continue
      const parentAt = reset.search(new RegExp(`\\.${lower(rel[1])}\\.deleteMany`))
      if (parentAt < 0) continue
      const childAt = reset.search(new RegExp(`\\.${lower(m[1])}\\.deleteMany`))
      if ((childAt < 0 || childAt > parentAt) && !KNOWN_UNCOVERED.has(`${m[1]}->${rel[1]}`)) gaps.push(`${m[1]} -> ${rel[1]}`)
    }
  }
  assert.deepEqual(gaps, [], 'reset.ts must delete these child tables before their parent')
})

test('the adoption rows are deleted before the inbox rows, in the admin reset and the Mintsoft e2e reset', async () => {
  const reset = await readFile(new URL('../app/actions/reset.ts', import.meta.url), 'utf8')
  assert.ok(reset.indexOf('db.salesOrderRefundInboxAdoption.deleteMany') > 0 && reset.indexOf('db.salesOrderRefundInboxAdoption.deleteMany') < reset.indexOf('db.wmsReturnsInbox.deleteMany'))
  const e2e = await readFile(new URL('../app/api/e2e/mintsoft/route.ts', import.meta.url), 'utf8')
  assert.ok(e2e.indexOf('db.salesOrderRefundInboxAdoption.deleteMany') > 0 && e2e.indexOf('db.salesOrderRefundInboxAdoption.deleteMany') < e2e.indexOf('db.wmsReturnsInbox.deleteMany'))
})
