import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, allFiles, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { binding, creditNoteRow, eurInvoice, noSleep, paymentRow, rateDouble, uuid } from './xero-rate-fixtures.ts'

/**
 * THE WHOLE COMMAND, R16: the pack run end to end against a FAKE Xero client (a GET-only port, nothing on any network) and a scripted IMS
 * connection. Without --vendor-reads-only nothing is read; with it the rate check reads the IMS rates and the three Xero lists, publishes its
 * report and evidence, and makes no write. Mutations are listed in the PR.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))

const SID = '7000000000000000001'
const FX = [{ currency: 'EUR', rate: '1.25', manual: false, fetched: '2026-09-10T06:00:00.000Z' }]

type Rig = { sent: string[]; fxReads: number; out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(xero: ReturnType<typeof rateDouble>, base = 'GBP'): Rig {
  const r: Rig = { sent: [], fxReads: 0, out: [], err: [], deps: {} }
  const client: ImsQueryClient = {
    async query(sql) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: 'on' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/FROM organisations/.test(sql)) return { rows: [{ base }] }
      if (/FROM fx_rates/.test(sql)) { r.fxReads += 1; return { rows: FX.map((row) => ({ ...row })) } }
      return { rows: [] }
    },
  }
  r.deps = {
    now: () => NOW,
    openIms: async () => ({ client, close: async () => undefined }),
    runInvariant: async () => realEvidence(),
    disconnect: async () => undefined,
    liveness: healthyLiveness(),
    basis: fakeBasisPort(goodState()),
    xero: { port: xero, binding: binding() },
    xeroOptions: { sleep: noSleep },
  }
  return r
}
const run = (r: Rig, argv: string[]) => runPackCli({ argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps, stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t) })
const argv = (dir: string, ...more: string[]) => ['--phase', 'P1', '--as-of', D, '--items', 'R16', '--report-dir', dir, ...more]
const line = (r: Rig) => r.out.find((l) => l.startsWith('R16 '))

test('WITHOUT --vendor-reads-only R16 is inconclusive VENDOR_READS_OFF: the fake Xero is never touched and the IMS rates are never read', async () => {
  const xero = rateDouble({ invoices: [eurInvoice(1, 0.8)] })
  const r = rig(xero)
  assert.equal(await run(r, argv(scratchDir(bases))), 5)
  assert.equal(line(r), 'R16 inconclusive VENDOR_READS_OFF')
  assert.equal(xero.calls.length, 0)
  assert.equal(r.fxReads, 0)
  assert.ok(!r.sent.some((sql) => /fx_rates|organisations/.test(sql)))
})

// [mutation: the runner not registered / the vendor ports not handed to it / a write in the run]
test('WITH --vendor-reads-only R16 checks every foreign document and payment against the IMS rate, publishes its entries, and the whole run only reads', async () => {
  const xero = rateDouble({
    invoices: [eurInvoice(1, 0.8), eurInvoice(2, 0.8)],
    creditNotes: [creditNoteRow({ n: 3, date: '2026-09-11', currency: 'EUR', rate: 0.8 })],
    payments: [paymentRow({ n: 4, date: '2026-09-12', currency: 'EUR', rate: 0.8 })],
  })
  const r = rig(xero)
  const dir = scratchDir(bases)
  assert.equal(await run(r, argv(dir, '--vendor-reads-only')), 5, 'the other fifteen items are not selected, so the run is not a clean exit')
  assert.equal(line(r), 'R16 pass -')
  assert.equal(r.fxReads, 1)
  // Seven requests, all of the read shape the transport gate admits (the fake is the port the real transport implements).
  assert.deepEqual(xero.calls.map((c) => c.resource), ['Organisation', 'Invoices', 'Invoices', 'CreditNotes', 'CreditNotes', 'Payments', 'Payments'])
  assert.ok(xero.calls.every((c) => (c.resource === 'Organisation' ? Object.keys(c.params).length === 0 : typeof c.params.where === 'string' && c.params.page === '1')))
  assert.ok(!r.sent.some((sql) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql)), 'nothing was written to the database')
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const item = chain.head!.record.items.find((i) => i.id === 'R16')!
  assert.deepEqual([item.outcome, [...item.sources].sort(), item.counts.bothEqual], ['pass', ['ims-database', 'xero-api'], 4])
  const published = allFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const n of [1, 2]) assert.ok(published.includes(`xero-rate|sales-invoice|${uuid(n)}`))
  assert.ok(published.includes(`xero-rate|sales-cn|${uuid(3)}`) && published.includes(`xero-rate|payment|${uuid(4)}`))
})

test('a differing Xero rate fails the item with both rates in the evidence, and a missing IMS rate is listed with the lookup\'s reason', async () => {
  const xero = rateDouble({ invoices: [eurInvoice(1, 0.8), eurInvoice(2, 0.82), eurInvoice(3, 0.8, '2026-09-09')] })
  const r = rig(xero)
  const dir = scratchDir(bases)
  assert.equal(await run(r, argv(dir, '--vendor-reads-only')), 1)
  assert.equal(line(r), 'R16 fail DIFFERENCES,XERO_RATE_DIFFERS,IMS_RATE_MISSING')
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const evidence = allFiles(dir).filter((f) => f.endsWith('evidence.jsonl')).map((f) => readFileSync(f, 'utf8')).join('\n')
  const rows = evidence.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.item === 'R16')
  assert.deepEqual(rows.filter((l) => l.bucket === 'bothDiffer').map((l) => [l.key, l.ims, l.vendor]), [[`xero-rate|sales-invoice|${uuid(2)}`, '0.8', '0.82']])
  assert.deepEqual(rows.filter((l) => l.bucket === 'onlyVendor').map((l) => [l.key, l.ims, l.vendor]), [[`xero-rate|sales-invoice|${uuid(3)}|ims-rate-missing|no-rate`, null, '0.8']])
})

test('an unproven Xero list makes the command report R16 inconclusive and still publish', async () => {
  const xero = rateDouble({ invoices: [eurInvoice(1, 0.8)] }, { tweak: (call, _n, page) => (call.resource === 'CreditNotes' ? { ...page, body: { CreditNotes: [] } } : undefined) })
  const r = rig(xero)
  assert.equal(await run(r, argv(scratchDir(bases), '--vendor-reads-only')), 5)
  assert.equal(line(r), 'R16 inconclusive SOURCE_UNREADABLE')
})
