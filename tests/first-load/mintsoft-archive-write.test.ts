/**
 * `first-load:mintsoft-archive --execute`: the WRITE half. Synthetic data only, no network and no database: the WMS census is a FAKE reader, the writer is
 * the real connector writer against a FAKE Mintsoft tenant on loopback (tests/connectors/mintsoft-archive-fake.ts), and the IMS target is a fake query port
 * that answers the command's own statements and records every activity-log insert.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, before } from 'node:test'
import { serializeCsv } from '../../lib/first-load/csv.ts'
import { EXIT_CODES } from '../../lib/first-load/spec.ts'
import { runLifecycleReviewCli, type WmsReader } from '../../lib/first-load/lifecycle-review/cli.ts'
import { LIFECYCLE_REVIEW_FILE_NAMES } from '../../lib/first-load/lifecycle-review/generation.ts'
import { runWmsArchiveCli, type WmsArchiveExecuteDeps, type WmsCensusReader } from '../../lib/first-load/wms-discontinue/cli.ts'
import type { WmsCensus } from '../../lib/first-load/wms-discontinue/plan.ts'
import { ARCHIVE_ACTIVITY_ACTIONS, ARCHIVE_TARGET_STATEMENTS, type ArchiveTargetPort } from '../../lib/first-load/wms-discontinue/target.ts'
import { FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY, findSwitch } from '../../lib/domain/settings/system-switches.ts'
import { createMintsoftArchiveWriter } from '../../lib/connectors/mintsoft/first-load-archive-write.ts'
import { configOf, fakeMintsoft, grantedEnv, stockRow, syntheticProduct, type FakeTenant, type Rig } from '../connectors/mintsoft-archive-fake.ts'
import { buildFixture, fakeWms, type Fixture } from './lifecycle-review-fixture.ts'

let fx: Fixture
let sheetDir: string
before(async () => {
  fx = await buildFixture()
  sheetDir = fx.fresh('review')
  const wms: WmsReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async () => fakeWms() }
  let stderr = ''
  const code = await runLifecycleReviewCli(['--manifest', fx.manifestPath, '--out', sheetDir, '--mintsoft-env-file', '/only/for/the/fake'], { stdout: () => {}, stderr: (s) => (stderr += s) }, { wms })
  assert.equal(code, EXIT_CODES.OK, stderr)
})
after(() => fx.cleanup())
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })

const sheetId = () => JSON.parse(readFileSync(path.join(sheetDir, LIFECYCLE_REVIEW_FILE_NAMES.generation), 'utf8')).sheetId as string
/** SIM-PRIV and SIM-DRAFT set to Archived, every other review row decided otherwise. */
function manifest(change?: (m: Record<string, unknown>) => void): string {
  const rows: Record<string, string> = { 'NEW-1': 'Active', 'NEW-ARCH': 'Discontinued', 'SIM-DRAFT': 'Archived', 'SIM-PRIV': 'Archived', 'VAR-02': 'Active' }
  const file = `${fx.fresh('decisions')}.csv`
  writeFileSync(file, serializeCsv(['sku', 'status', 'reason', 'sheetId'], Object.entries(rows).map(([sku, status]) => [sku, status, '', sheetId()])))
  return fx.writeManifest((m) => {
    m.lifecycleReview = { generation: path.join(sheetDir, LIFECYCLE_REVIEW_FILE_NAMES.generation) }
    ;(m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file })
    change?.(m)
  })
}

/** The tenant: SIM-DRAFT (12) and SIM-PRIV (13), both active, zero stock rows in warehouse 5. */
function tenant(): FakeTenant {
  return {
    products: new Map([['12', syntheticProduct(12, 'SIM-DRAFT')], ['13', syntheticProduct(13, 'SIM-PRIV')]]),
    stock: { '5': [stockRow(12, 'SIM-DRAFT', 0), stockRow(13, 'SIM-PRIV', 0)] },
  }
}
/** The census the plan is made from (what the tenant held at the dry run). */
function census(rig: Rig): WmsCensus {
  return {
    products: [{ sku: 'SIM-DRAFT', productId: '12', bundle: false, status: 'active' }, { sku: 'SIM-PRIV', productId: '13', bundle: false, status: 'active' }],
    physical: new Map([['SIM-DRAFT', 0], ['SIM-PRIV', 0]]),
    warehouses: ['5'],
    clientId: '89',
    origin: new URL(rig.base).origin,
  }
}

type Target = { queries: Array<{ sql: string; values?: unknown[] }>; records: Array<{ action: string; level: string; entityId: string; metadata: Record<string, unknown>; description: string }>; opened: number }
function fakeTarget(opts: { switchValue?: string | null; lifecycle?: Record<string, string | null>; db?: string; sid?: string; failRecord?: boolean } = {}): { deps: Pick<WmsArchiveExecuteDeps, 'openTarget'>; target: Target } {
  const target: Target = { queries: [], records: [], opened: 0 }
  const lifecycle = opts.lifecycle ?? { 'SIM-DRAFT': 'ARCHIVED', 'SIM-PRIV': 'ARCHIVED' }
  const port: ArchiveTargetPort = {
    query: async <T,>(sql: string, values?: unknown[]) => {
      target.queries.push({ sql, values })
      const rows = (r: unknown[]) => ({ rows: r as T[] })
      if (sql === ARCHIVE_TARGET_STATEMENTS.identity) return rows([{ db: opts.db ?? 'ims_test', sid: opts.sid ?? '7000000000000000001' }])
      if (sql === ARCHIVE_TARGET_STATEMENTS.switch) {
        assert.deepEqual(values, [FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY])
        const v = opts.switchValue === undefined ? 'true' : opts.switchValue
        return rows(v === null ? [] : [{ value: v }])
      }
      if (sql === ARCHIVE_TARGET_STATEMENTS.products) {
        const skus = values![0] as string[]
        return rows(skus.filter((s) => lifecycle[s] != null).map((s) => ({ id: `ims-${s}`, sku: s, lifecycle: lifecycle[s] })))
      }
      if (sql === ARCHIVE_TARGET_STATEMENTS.record) {
        if (opts.failRecord) throw new Error('insert failed')
        target.records.push({ entityId: values![1] as string, action: values![2] as string, level: values![3] as string, description: values![4] as string, metadata: JSON.parse(values![5] as string) })
      }
      return rows([])
    },
  }
  return { target, deps: { openTarget: async () => { target.opened++; return { port, close: async () => {} } } } }
}

const ENV = ['--mintsoft-env-file', '/only/for/the/fake']
const EXEC = (token: string, extra: string[] = []) => ['--execute', '--plan-token', token, '--env-file', '/only/for/the/fake.env', '--expect-db', 'ims_test', '--expect-system-id', '7000000000000000001', '--operator', 'Synthetic Operator', ...extra]

async function setup(t: FakeTenant = tenant(), targetOpts: Parameters<typeof fakeTarget>[0] = {}, censusChange?: (c: WmsCensus) => void) {
  const rig = await fakeMintsoft(t, rigs)
  const reads: string[] = []
  const c = census(rig)
  const reader: WmsCensusReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async (file) => { reads.push(file); return c } }
  const m = manifest()
  const io = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => (o.out += s), stderr: (s: string) => (o.err += s) } } }
  const dry = io()
  const dryCode = await runWmsArchiveCli(['--manifest', m, ...ENV], dry.io, reader, 'first-load-mintsoft-archive')
  assert.equal(dryCode, EXIT_CODES.OK, dry.o.err)
  const token = /plan token: (MSA-[0-9a-f]{16})/.exec(dry.o.out)![1]!
  censusChange?.(c)
  const { deps, target } = fakeTarget(targetOpts)
  const execDeps: WmsArchiveExecuteDeps = {
    switchKey: FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY,
    openWriter: () => createMintsoftArchiveWriter(configOf(rig), { env: grantedEnv(rig), sleep: async () => {} }),
    newId: (() => { let n = 0; return () => `log-${++n}` })(),
    ...deps,
  }
  const exec = async (args: string[]) => {
    const r = io()
    const code = await runWmsArchiveCli(['--manifest', m, ...ENV, ...args], r.io, reader, 'first-load-mintsoft-archive', execDeps)
    return { code, ...r.o }
  }
  return { rig, reads, token, target, exec }
}
const posts = (rig: Rig) => rig.seen.filter((s) => s.method === 'POST')

test('--execute writes each WOULD_ARCHIVE SKU once with the verified partial body, verifies it by read-back, records attempt and verified write, and prints a summary', async () => {
  const s = await setup()
  const r = await s.exec(EXEC(s.token))
  assert.equal(r.code, EXIT_CODES.OK, r.err)
  assert.deepEqual(posts(s.rig).map((p) => JSON.parse(p.body)), [{ ID: 12, SKU: 'SIM-DRAFT', DisCont: true }, { ID: 13, SKU: 'SIM-PRIV', DisCont: true }])
  // per SKU: GET product, GET stock, POST, GET product (one at a time, in plan order)
  assert.deepEqual(s.rig.seen.map((x) => `${x.method} ${x.url}`), [
    'GET /api/Product/12', 'GET /api/Product/StockLevels?WarehouseId=5', 'POST /api/Product', 'GET /api/Product/12',
    'GET /api/Product/13', 'GET /api/Product/StockLevels?WarehouseId=5', 'POST /api/Product', 'GET /api/Product/13',
  ])
  assert.equal(s.rig.tenant.products.get('12')!.DisCont, true)
  assert.equal(s.rig.tenant.products.get('13')!.DisCont, true)
  assert.deepEqual(s.target.records.map((x) => [x.action, x.level, x.entityId]), [
    [ARCHIVE_ACTIVITY_ACTIONS.ATTEMPT, 'INFO', 'ims-SIM-DRAFT'], [ARCHIVE_ACTIVITY_ACTIONS.VERIFIED, 'INFO', 'ims-SIM-DRAFT'],
    [ARCHIVE_ACTIVITY_ACTIONS.ATTEMPT, 'INFO', 'ims-SIM-PRIV'], [ARCHIVE_ACTIVITY_ACTIONS.VERIFIED, 'INFO', 'ims-SIM-PRIV'],
  ])
  assert.deepEqual(s.target.records[1]!.metadata, {
    sku: 'SIM-DRAFT', wms: 'Mintsoft', wmsProductId: '12', discontinuedBefore: false, discontinuedAfter: true, operator: 'Synthetic Operator', planToken: s.token, sheetId: sheetId(), outcome: 'VERIFIED', problem: null,
  })
  assert.equal(s.target.queries[0]!.sql, ARCHIVE_TARGET_STATEMENTS.begin, 'the target is read in a READ ONLY transaction first')
  assert.match(r.out, /written and verified: 2/)
  assert.match(r.out, /SIM-PRIV \(Mintsoft product 13\): discontinued false -> true/)
})

// [mutation: the switch is not checked, or read as on for anything but 'true']
test('switch OFF: unset, false or TRUE refuses (exit 3) before Mintsoft is read; nothing is sent or recorded', async () => {
  assert.equal(findSwitch(FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY)?.defaultValue, 'false')
  const script = readFileSync(path.join(process.cwd(), 'scripts/first-load-mintsoft-archive.ts'), 'utf8')
  assert.match(script, new RegExp(`ARCHIVE_SWITCH_KEY = '${FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY}'`), 'the script names the registered switch')
  for (const value of [null, 'false', 'TRUE']) {
    const s = await setup(tenant(), { switchValue: value })
    const readsBefore = s.reads.length
    const r = await s.exec(EXEC(s.token))
    assert.equal(r.code, EXIT_CODES.INPUT_UNUSABLE, String(value))
    assert.match(r.err, /system switch first_load_mintsoft_archive_enabled is not on/)
    assert.equal(s.reads.length, readsBefore, 'the census was not read')
    assert.deepEqual(s.rig.seen, [])
    assert.deepEqual(s.target.records, [])
  }
})

// [mutation: the token is not compared, or compared with a stale plan]
test('a plan token that does not match the plan made now is refused (exit 3): nothing is sent', async () => {
  const s = await setup(tenant(), {}, (c) => { (c.physical as Map<string, number>).delete('SIM-PRIV'); (c.physical as Map<string, number>).set('SIM-PRIV', 0); c.warehouses = ['5', '6'] })
  const r = await s.exec(EXEC(s.token))
  assert.equal(r.code, EXIT_CODES.INPUT_UNUSABLE)
  assert.match(r.err, /is not the token of the plan made now/)
  const other = await s.exec(EXEC('MSA-0000000000000000'))
  assert.equal(other.code, EXIT_CODES.INPUT_UNUSABLE)
  assert.deepEqual(s.rig.seen, [])
  assert.deepEqual(s.target.records, [])
})

// [mutation: the import proof is skipped, or a non-ARCHIVED lifecycle passes]
test('import proof missing: a SKU to be written that is not an IMS product, or whose IMS lifecycle is not ARCHIVED, refuses (exit 3); nothing is sent', async () => {
  for (const lifecycle of [{ 'SIM-DRAFT': 'ARCHIVED', 'SIM-PRIV': null }, { 'SIM-DRAFT': 'ARCHIVED', 'SIM-PRIV': 'ACTIVE' }]) {
    const s = await setup(tenant(), { lifecycle })
    const r = await s.exec(EXEC(s.token))
    assert.equal(r.code, EXIT_CODES.INPUT_UNUSABLE)
    assert.match(r.err, /the import is not proven in the target ims_test/)
    assert.match(r.err, lifecycle['SIM-PRIV'] === null ? /SIM-PRIV: no IMS product under exactly this SKU/ : /SIM-PRIV: the IMS lifecycle is ACTIVE, not ARCHIVED/)
    assert.deepEqual(s.rig.seen, [])
  }
})

test('the target must be the one named: another database or system id refuses (exit 3) before Mintsoft is read', async () => {
  for (const opts of [{ db: 'ims_other' }, { sid: '1' }]) {
    const s = await setup(tenant(), opts)
    const readsBefore = s.reads.length
    const r = await s.exec(EXEC(s.token))
    assert.equal(r.code, EXIT_CODES.INPUT_UNUSABLE)
    assert.match(r.err, /--expect-(db|system-id) does not equal/)
    assert.equal(s.reads.length, readsBefore)
    assert.deepEqual(s.rig.seen, [])
  }
})

// [mutation: the stock is not re-read right before the write, or a missing stock row reads as 0]
test('stock appearing between plan and execute stops the run (exit 4) before anything is sent; so does a stock row that disappeared', async () => {
  const t = tenant()
  t.stock['5'] = [stockRow(12, 'SIM-DRAFT', 1), stockRow(13, 'SIM-PRIV', 0)]
  const s = await setup(t)
  const r = await s.exec(EXEC(s.token))
  assert.equal(r.code, EXIT_CODES.OUTPUT_FAILED)
  assert.match(r.err, /STOPPED at SIM-DRAFT: the Mintsoft product 12 now shows physical stock 1/)
  assert.match(r.err, /nothing was sent for it/)
  assert.deepEqual(posts(s.rig), [])
  assert.deepEqual(s.target.records, [])
  assert.match(r.out, /not attempted: 1 \(SIM-PRIV\)/)
  const gone = tenant()
  gone.stock['5'] = [stockRow(13, 'SIM-PRIV', 0)]
  const g = await setup(gone)
  const rg = await g.exec(EXEC(g.token))
  assert.equal(rg.code, EXIT_CODES.OUTPUT_FAILED)
  assert.match(rg.err, /no configured Mintsoft warehouse has a stock row for product 12 now/)
  assert.deepEqual(posts(g.rig), [])
})

test('a product that changed since the plan (now discontinued, another SKU, a bundle, another client) stops the run before anything is sent', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ DisCont: true }, /already discontinued \(it was not when the plan was made\)/],
    [{ SKU: 'sim-draft' }, /now holds the SKU "sim-draft", not exactly "SIM-DRAFT"/],
    [{ Bundle: true }, /is a bundle/],
    [{ ClientId: 90 }, /does not name our client/],
  ]
  for (const [change, why] of cases) {
    const t = tenant()
    Object.assign(t.products.get('12')!, change)
    const s = await setup(t)
    const r = await s.exec(EXEC(s.token))
    assert.equal(r.code, EXIT_CODES.OUTPUT_FAILED, JSON.stringify(change))
    assert.match(r.err, why)
    assert.deepEqual(posts(s.rig), [])
  }
})

// [mutation: HTTP 200 is taken as success]
test('Success:false (the pallet-size refusal shape, or any other) stops the run at that SKU (exit 4); the attempt and the failure are recorded; nothing after it is attempted', async () => {
  for (const body of [{ Success: false, Message: 'One or more pallet sizes are not valid!', ID: 12 }, { Success: false, Message: 'Something else' }]) {
    const s = await setup({ ...tenant(), onPost: () => ({ body }) })
    const r = await s.exec(EXEC(s.token))
    assert.equal(r.code, EXIT_CODES.OUTPUT_FAILED)
    assert.match(r.err, new RegExp(`Mintsoft did not accept the discontinue request for product 12: ${body.Message}`))
    assert.match(r.err, /the request WAS sent/)
    assert.equal(posts(s.rig).length, 1, 'one request, then the stop')
    assert.equal(s.rig.tenant.products.get('12')!.DisCont, false)
    assert.deepEqual(s.target.records.map((x) => [x.action, x.level]), [[ARCHIVE_ACTIVITY_ACTIONS.ATTEMPT, 'INFO'], [ARCHIVE_ACTIVITY_ACTIONS.FAILED, 'ERROR']])
    assert.equal(s.target.records[1]!.metadata.discontinuedAfter, false, 'the flag as read back after the failure')
    assert.match(r.out, /not attempted: 1 \(SIM-PRIV\)/)
  }
})

// [mutation: the read-back is not compared field by field]
test('a write that changed another field stops the run (exit 4) and names the field; the failure is recorded', async () => {
  const s = await setup({ ...tenant(), afterWrite: (p) => { p.PalletSizes = '' } })
  const r = await s.exec(EXEC(s.token))
  assert.equal(r.code, EXIT_CODES.OUTPUT_FAILED)
  assert.match(r.err, /the write changed other fields of the Mintsoft product 12 as well: PalletSizes/)
  assert.equal(posts(s.rig).length, 1)
  assert.equal(s.target.records.at(-1)!.action, ARCHIVE_ACTIVITY_ACTIONS.FAILED)
  assert.equal(s.target.records.at(-1)!.metadata.discontinuedAfter, true)
})

test('an attempt that cannot be recorded stops the run before anything is sent', async () => {
  const s = await setup(tenant(), { failRecord: true })
  const r = await s.exec(EXEC(s.token))
  assert.equal(r.code, EXIT_CODES.OUTPUT_FAILED)
  assert.match(r.err, /could not be recorded in the IMS activity log, so nothing was sent/)
  assert.deepEqual(posts(s.rig), [])
})

test('usage: --execute needs every option, execute options need --execute, the operator is a name, and --execute without a wired writer is refused', async () => {
  const s = await setup()
  const bad: Array<[string[], RegExp]> = [
    [['--execute'], /--execute needs --plan-token, --env-file, --expect-db, --expect-system-id, --operator/],
    [['--plan-token', s.token], /only go with --execute/],
    [EXEC('not-a-token'), /--plan-token must be the MSA- token/],
    [[...EXEC(s.token).slice(0, -2), '--operator', 'someone@example.test'], /--operator must be a name/],
    [[...EXEC(s.token), '--env-file', 'x'], /--env-file was given twice/],
  ]
  for (const [args, why] of bad) {
    const r = await s.exec(args)
    assert.equal(r.code, EXIT_CODES.USAGE, args.join(' '))
    assert.match(r.err, why)
  }
  let err = ''
  const reader: WmsCensusReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async () => { throw new Error('not read') } }
  const code = await runWmsArchiveCli(['--manifest', manifest(), ...ENV, ...EXEC(s.token)], { stdout: () => {}, stderr: (t) => (err += t) }, reader, 'first-load-mintsoft-archive')
  assert.equal(code, EXIT_CODES.USAGE)
  assert.match(err, /--execute is not wired/)
  assert.deepEqual(s.rig.seen, [])
})

// [mutation: a blocked prepare exits 0, or --execute writes from a manifest a real prepare would refuse] (#1126 R1 LOW)
test('a real prepare blocked by another finding: the dry run exits 1 and says so, and --execute refuses before the target or Mintsoft is read', async () => {
  const blocked = manifest((m) => {
    const file = `${fx.fresh('renames')}.csv`
    writeFileSync(file, 'fromSku,toSku,reason\r\nOLD-1,NEW-1,Woo spelling (synthetic)\r\nGHOST-A,GHOST-B,no such product (synthetic)\r\n')
    m.inputs = (m.inputs as Array<{ dataset: string }>).map((i) => (i.dataset === 'sku-renames' ? { dataset: 'sku-renames', file } : i))
  })
  const rig = await fakeMintsoft(tenant(), rigs)
  const reads: string[] = []
  const reader: WmsCensusReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async (f) => { reads.push(f); return census(rig) } }
  let out = ''
  let err = ''
  const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) }
  const dry = await runWmsArchiveCli(['--manifest', blocked, ...ENV], io, reader, 'first-load-mintsoft-archive')
  assert.equal(dry, EXIT_CODES.BLOCKING_FINDINGS, err)
  assert.match(out, /BLOCKED: a real first-load:prepare of this manifest is blocked by other findings/)
  const { deps, target } = fakeTarget()
  const readsBefore = reads.length
  err = ''
  const code = await runWmsArchiveCli(['--manifest', blocked, ...ENV, ...EXEC('MSA-0123456789abcdef')], io, reader, 'first-load-mintsoft-archive', {
    switchKey: FIRST_LOAD_WMS_ARCHIVE_SWITCH_KEY, openWriter: () => { throw new Error('not opened') }, newId: () => 'x', ...deps,
  })
  assert.equal(code, EXIT_CODES.INPUT_UNUSABLE)
  assert.match(err, /blocked by other findings, so the import cannot have been made from it/)
  assert.equal(target.opened, 0)
  assert.equal(reads.length, readsBefore)
  assert.deepEqual(rig.seen, [])
})
