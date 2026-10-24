import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, cleanup, readAll, realEvidence, scratchDir } from './helpers.ts'
import { ASOF, incomingCsv, writeExport } from './qoblex-fixtures.ts'

/**
 * THE COMMAND WITH R7, R8 AND R11: phase P2 only (at P0 and P1 nothing is read), the Qoblex export needed for R7 and R8, every IMS statement a
 * read, and no input reaching an output. Mutations are listed above each test.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))
const SID = '7000000000000000001'
const cuid = (n: number) => `c${String(n).padStart(24, '0')}`

type Rig = { sent: string[]; out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(over: { orders?: Array<Record<string, unknown>>; lines?: Array<Record<string, unknown>>; net?: Array<Record<string, unknown>> } = {}): Rig {
  const r: Rig = { sent: [], out: [], err: [], deps: {} }
  const orders = over.orders ?? [{ id: cuid(1), reference: 'QBX-PO1', status: 'PO_SENT', currency: 'GBP', created: '2026-09-02T10:00:00.000Z' }]
  const lines = over.lines ?? [{ id: cuid(11), po_id: cuid(1), sku: 'SKU-1', qty: '6', received: '0', cost: '2.5' }, { id: cuid(12), po_id: cuid(1), sku: 'SKU-2', qty: '3', received: '0', cost: '10' }]
  const client: ImsQueryClient = {
    async query(sql) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/FROM first_load_apply_runs/.test(sql)) return { rows: [{ status: 'VERIFIED', cut: '2026-10-01T00:00:00.000Z' }] }
      if (/FROM settings WHERE key = \$1/.test(sql)) return { rows: [{ value: '2026-01-01' }] }
      if (/FROM transit_subledger_movements/.test(sql)) return { rows: over.net ?? [{ po_id: cuid(1), source_type: 'PURCHASE_BILL', net: '50' }] }
      if (/po\.type::text = 'GOODS'/.test(sql) && !/purchase_order_lines/.test(sql)) return { rows: orders }
      if (/po\.id = ANY/.test(sql) || /po\.status::text = ANY\(\$1::text\[\]\) ORDER BY po\.id/.test(sql) && /createdAt/.test(sql)) return { rows: [{ id: cuid(1), reference: 'QBX-PO1', status: 'PO_SENT', type: 'GOODS', created: '2026-09-01T10:00:00.000Z' }] }
      if (/FROM purchase_order_lines/.test(sql)) return { rows: lines }
      if (/FROM purchase_orders/.test(sql)) return { rows: orders }
      return { rows: [] }
    },
  }
  r.deps = { now: () => NOW, openIms: async () => ({ client, close: async () => undefined }), runInvariant: async () => realEvidence(), disconnect: async () => undefined, liveness: healthyLiveness(), basis: fakeBasisPort(goodState()) }
  return r
}
const run = (r: Rig, argv: string[]) => runPackCli({
  argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps,
  stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t),
})
const args = (dir: string, phase: string, items: string, ...more: string[]) => ['--phase', phase, '--as-of', ASOF, '--items', items, '--report-dir', dir, ...more]
const line = (r: Rig, id: string) => r.out.find((l) => l.startsWith(`${id} `))
const exportWith = (csv?: string) => writeExport(bases, { purchaseOrders: csv === undefined ? { csv: incomingCsv([{ po: 'PO1', sku: 'SKU-1', ordered: '10', received: '4', price: '2.5' }, { po: 'PO1', sku: 'SKU-2', ordered: '3', received: '0', price: '10' }]) } : { csv } })
const reads = (r: Rig) => r.sent.filter((sql) => /purchase_order|transit_subledger|first_load_apply_runs/.test(sql))
void D

// [mutation: the phase gate removed from the run, or the runner reading before the catalogue is consulted]
test('PHASES: at P0 and P1 R7, R8 and R11 are not-applicable and the command reads NOTHING for them (no statement for purchase orders, the transit ledger or the first-load record, no export file)', async () => {
  for (const phase of ['P0', 'P1']) {
    const r = rig()
    const exportDir = exportWith()
    await run(r, args(scratchDir(bases), phase, 'R7,R8,R11', '--qoblex-export', exportDir))
    for (const id of ['R7', 'R8', 'R11']) assert.equal(line(r, id), `${id} not-applicable PHASE_NOT_APPLICABLE`, `${id} ${phase}`)
    assert.deepEqual(reads(r), [], phase)
  }
})

test('P2: R7, R8 and R11 pass on agreeing data, every IMS statement is a read, the IMS side is read once for R7 and R8 each and the export is the only file; sources are exactly the catalogue\'s', async () => {
  const r = rig()
  assert.equal(await run(r, args(scratchDir(bases), 'P2', 'R7,R8,R11', '--qoblex-export', exportWith())), 5)
  assert.equal(line(r, 'R7'), 'R7 pass -')
  assert.equal(line(r, 'R8'), 'R8 pass -')
  assert.equal(line(r, 'R11'), 'R11 pass -')
  assert.ok(r.sent.every((sql) => /^\s*(SELECT|SET LOCAL|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)/i.test(sql)))
  assert.ok(!r.sent.some((sql) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql)))
  const dir = scratchDir(bases)
  const again = rig()
  await run(again, args(dir, 'P2', 'R7,R8,R11', '--qoblex-export', exportWith()))
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const items = chain.head!.record.items
  assert.deepEqual(items.find((i) => i.id === 'R7')!.sources.slice().sort(), ['ims-database', 'qoblex-file'])
  assert.deepEqual(items.find((i) => i.id === 'R8')!.sources.slice().sort(), ['ims-database', 'qoblex-file'])
  assert.deepEqual(items.find((i) => i.id === 'R11')!.sources.slice().sort(), ['ims-database', 'xero-trial-balance'])
})

// [mutation: the export check moved after the runner / R7 and R8 read IMS before knowing the export is named]
test('WITHOUT --qoblex-export R7 and R8 are QOBLEX_EXPORT_OFF and read nothing; R11 needs no export and runs', async () => {
  const r = rig()
  await run(r, args(scratchDir(bases), 'P2', 'R7,R8,R11'))
  assert.equal(line(r, 'R7'), 'R7 inconclusive QOBLEX_EXPORT_OFF')
  assert.equal(line(r, 'R8'), 'R8 inconclusive QOBLEX_EXPORT_OFF')
  assert.equal(line(r, 'R11'), 'R11 pass -')
  assert.ok(!r.sent.some((sql) => /purchase_order_lines|po\.type::text = 'GOODS'/.test(sql)), 'and the incoming purchase orders were not read')
})

test('P2 differences name identities and fail: a quantity the export has but IMS has not, an order IMS holds that the export lacks, and a transit balance the schedule does not explain', async () => {
  const short = rig({ lines: [{ id: cuid(11), po_id: cuid(1), sku: 'SKU-1', qty: '6', received: '0', cost: '2.5' }] })
  assert.equal(await run(short, args(scratchDir(bases), 'P2', 'R7,R8', '--qoblex-export', exportWith())), 1)
  assert.equal(line(short, 'R8'), 'R8 fail DIFFERENCES')
  assert.equal(line(short, 'R7'), 'R7 fail DIFFERENCES')
  const none = rig()
  await run(none, args(scratchDir(bases), 'P2', 'R7,R8', '--qoblex-export', exportWith(incomingCsv([]))))
  assert.equal(line(none, 'R7'), 'R7 fail DIFFERENCES')
  const off = rig({ net: [{ po_id: cuid(1), source_type: 'PURCHASE_BILL', net: '49' }] })
  await run(off, args(scratchDir(bases), 'P2', 'R11'))
  assert.equal(line(off, 'R11'), 'R11 pass -', 'within GBP 1')
  const far = rig({ net: [{ po_id: cuid(1), source_type: 'PURCHASE_BILL', net: '40' }] })
  await run(far, args(scratchDir(bases), 'P2', 'R11'))
  assert.equal(line(far, 'R11'), 'R11 fail DIFFERENCES')
})

test('nothing in any output carries a path, a file name, a URL, a credential or a raw reference: only closed codes, counts and sanitised tokens', async () => {
  const r = rig()
  const exportDir = exportWith()
  const dir = scratchDir(bases)
  await run(r, args(dir, 'P2', 'R7,R8,R11', '--qoblex-export', exportDir))
  // the terminal output AND every file the run published (the Markdown, the evidence lines, the JSON)
  const files = readAll(dir)
  assert.ok(files.length >= 3, 'precondition: the run published its report')
  const all = [...r.out, ...r.err, ...files.map((f) => f.text)].join('\n')
  for (const needle of [exportDir, 'incoming.csv', 'incoming-map.json', 'manifest.json', 'Supplier', 'postgresql://', 'QBX-PO1', 'QBX-', '127.0.0.1:1']) assert.ok(!all.includes(needle), needle)
  // and the identities that ARE published are the sanitised tokens of the order number and SKU (the evidence names which line differs)
  const evidence = files.find((f) => f.file.endsWith('evidence.jsonl'))
  assert.ok(evidence !== undefined && evidence.text.includes('PO1|SKU-1') && evidence.text.includes('ledger-transit-balance'), 'the evidence names the compared identities')
})

// [mutation: the new identity kind unknown to the report reader's token screen]
test('an order number the identity screen digests (it contains a credential-ish word) still publishes, reads back through the chain reader and is never printed', async () => {
  const dir = scratchDir(bases)
  const r = rig({ orders: [{ id: cuid(1), reference: 'QBX-PO-KEY-1', status: 'PO_SENT', currency: 'GBP', created: '2026-09-02T10:00:00.000Z' }], lines: [{ id: cuid(11), po_id: cuid(1), sku: 'SKU-1', qty: '6', received: '0', cost: '2.5' }] })
  const csv = incomingCsv([{ po: 'PO-KEY-1', sku: 'SKU-1', ordered: '10', received: '4', price: '2.5' }])
  assert.equal(await run(r, args(dir, 'P2', 'R7,R8', '--qoblex-export', exportWith(csv))), 5)
  assert.equal(line(r, 'R7'), 'R7 pass -')
  assert.equal(line(r, 'R8'), 'R8 pass -')
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head, JSON.stringify(chain))
  const text = readAll(dir).map((f) => f.text).join('\n')
  assert.ok(!text.includes('PO-KEY-1'))
  assert.match(text, /order-ref#[0-9a-f]{8}/)
})
