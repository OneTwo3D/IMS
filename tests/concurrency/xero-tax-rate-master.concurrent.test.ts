import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE XERO TAX-RATE MASTER STORE, THROUGH THE REAL SWEEP, AGAINST A REAL DATABASE.
 *
 * `runXeroTaxRateDriftSweep` reads the full list from Xero, validates every row, and replaces the connected organisation's list, its
 * header, the drift snapshot and the read-sync last-success stamp in ONE connection-fenced transaction. The Xero fetch is a hook
 * (no request leaves the process). Each refusal arm has a CONTROL that proves the write really happens when nothing is wrong.
 *
 *   - a refused body (empty, aliased field, malformed, duplicate, not the list) leaves the previous list, header, snapshot and stamp
 *     exactly as they were;
 *   - a failure in the MIDDLE of the replace (a trigger that rejects the header insert) rolls the rows, the snapshot and the stamp back;
 *   - a rebind: the new organisation never reads the old organisation's list as its own, before or after its first sweep, and the old
 *     organisation's rows are gone once the new one's list is stored;
 *   - the pack's reader (readImsSnapshot, section xeroTaxRates) proves the stored list, and only that list.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

type Hook = (path: string) => Promise<unknown>
let fetchHook: Hook = async () => { throw new Error('no fetch hook installed') }
const requested: string[] = []

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_rethrow: () => {} } })

config({ path: '.env.local', quiet: true })
config({ quiet: true })

const SNAPSHOT_KEY = 'xero_tax_rate_drift_current'
const CHECKED_KEY = 'xero_tax_rate_drift_last_checked_at'

let depsPromise: ReturnType<typeof loadDepsOnce> | null = null
function loadDeps() { return (depsPromise ??= loadDepsOnce()) }
async function loadDepsOnce() {
  const realApi = await import('../../lib/connectors/xero/api.ts')
  mock.module('@/lib/connectors/xero/api', {
    namedExports: {
      ...realApi,
      xeroGet: async (path: string) => { requested.push(path); return { ok: true, status: 200, data: await fetchHook(path) } },
      xeroGetCached: async (path: string) => { requested.push(path); return { ok: true, status: 200, data: await fetchHook(path) } },
    },
  })
  const [{ db }, drift, readers, listLib] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts'),
    import('../../lib/reconciliation-pack/ims-readers.ts'),
    import('../../lib/connectors/xero/tax-rate-list.ts'),
  ])
  const { default: pg } = await import('pg')
  return { db, drift, readers, listLib, pg }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>

const createdRates: string[] = []

async function wipe(deps: Deps) {
  const { db } = deps
  await db.setting.deleteMany({ where: { key: { in: [SNAPSHOT_KEY, CHECKED_KEY] } } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.xeroTaxRateList.deleteMany({})
  await db.xeroTaxRate.deleteMany({})
}
async function bindTo(deps: Deps, tenantId: string, run: string) {
  await deps.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await deps.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000), tenantId, tenantName: `Org ${tenantId}`, connectionGeneration: `gen-${tenantId}-${run}` } })
}

const rateRow = (type: string, over: Record<string, unknown> = {}) => ({
  Name: `Rate ${type}`, TaxType: type, Status: 'ACTIVE', ReportTaxType: 'OUTPUT', DisplayTaxRate: 20, EffectiveRate: 20,
  CanApplyToAssets: false, CanApplyToEquity: false, CanApplyToExpenses: true, CanApplyToLiabilities: false, CanApplyToRevenue: true,
  TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: false, IsNonRecoverable: false }], ...over,
})
const goodBody = (...types: string[]) => ({ Id: randomUUID(), Status: 'OK', ProviderName: 'x', DateTimeUTC: '/Date(1)/', TaxRates: types.map((t) => rateRow(t)) })
const setBody = (body: unknown) => { fetchHook = async () => body }

async function state(deps: Deps) {
  const [rows, headers, snapshot, checked] = await Promise.all([
    deps.db.xeroTaxRate.findMany({ orderBy: [{ tenantId: 'asc' }, { taxType: 'asc' }] }),
    deps.db.xeroTaxRateList.findMany({ orderBy: { tenantId: 'asc' } }),
    deps.db.setting.findUnique({ where: { key: SNAPSHOT_KEY } }),
    deps.db.setting.findUnique({ where: { key: CHECKED_KEY } }),
  ])
  return JSON.stringify({ rows, headers, snapshot: snapshot?.value ?? null, checked: checked?.value ?? null })
}

/** The pack's own reader over a fresh connection, exactly as the command opens one. */
async function readSection(deps: Deps) {
  const client = new deps.pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const read = await deps.readers.readImsSnapshot(client, { sections: ['xeroTaxRates'] })
    assert.ok(read.ok, 'the IMS read itself succeeds')
    const section = read.ok ? read.sections.xeroTaxRates : undefined
    assert.ok(section && section.ok, 'the section is readable')
    return section && section.ok ? section.value : null
  } finally { await client.end() }
}

after(async () => {
  if (!RUN) return
  const deps = await loadDeps()
  await wipe(deps)
  await deps.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS xtr_reject_header ON xero_tax_rate_lists')
  await deps.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS xtr_reject_header()')
  if (createdRates.length) {
    await deps.db.taxRateComponent.deleteMany({ where: { taxRateId: { in: createdRates } } })
    await deps.db.taxRate.deleteMany({ where: { id: { in: createdRates } } })
  }
})

test('CONTROL: a sweep stores the full list, the header and the stamp together, and the pack reader proves it for the connected organisation', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await wipe(deps)
  await bindTo(deps, `tenant-A-${run}`, run)
  requested.length = 0
  setBody({ ...goodBody('OUTPUT2', 'INPUT2'), TaxRates: [rateRow('OUTPUT2'), rateRow('INPUT2', { Status: 'ARCHIVED' }), rateRow('NONE', { TaxComponents: [{ Name: 'Zero', Rate: 0 }], EffectiveRate: undefined })] })

  // IMS has NO tax rate to compare: the list is still stored (Xero is the master), and the stamp advances because the list was stored.
  const result = await deps.drift.runXeroTaxRateDriftSweep()
  assert.deepEqual([result.checked, result.drifted], [0, 0])
  assert.deepEqual(requested, ['TaxRates'], 'exactly one GET, of the one collection')

  const rows = await deps.db.xeroTaxRate.findMany({ where: { tenantId: `tenant-A-${run}` }, orderBy: { taxType: 'asc' } })
  assert.deepEqual(rows.map((r) => [r.taxType, r.status]), [['INPUT2', 'ARCHIVED'], ['NONE', 'ACTIVE'], ['OUTPUT2', 'ACTIVE']], 'every status is kept')
  const out = rows.find((r) => r.taxType === 'OUTPUT2')!
  assert.equal(out.effectiveRate?.toString(), '20')
  assert.deepEqual(out.components, [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }])
  assert.deepEqual([out.canApplyToExpenses, out.canApplyToAssets, out.canApplyToRevenue], [true, false, true])
  assert.equal(rows.find((r) => r.taxType === 'NONE')!.effectiveRate, null)
  const header = await deps.db.xeroTaxRateList.findFirstOrThrow({ where: { tenantId: `tenant-A-${run}` } })
  assert.equal(header.rowCount, 3)
  const checked = (await deps.db.setting.findUniqueOrThrow({ where: { key: CHECKED_KEY } })).value
  assert.equal(header.fetchedAt.toISOString(), checked, 'the stamp IS the time of the stored list')
  assert.notEqual(await deps.db.setting.findUnique({ where: { key: SNAPSHOT_KEY } }), null)

  const section = await readSection(deps)
  // The proven store also carries the rows themselves (R13's set identity reads them): name, status, report type, both rates, the stored components and the can-apply flags, in taxType order.
  const canApply = { assets: false, equity: false, expenses: true, liabilities: false, revenue: true }
  const vat20 = [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }]
  assert.deepEqual(section, {
    state: 'proven', tenantId: `tenant-A-${run}`, fetchedAt: checked,
    taxTypes: [{ taxType: 'INPUT2', status: 'ARCHIVED' }, { taxType: 'NONE', status: 'ACTIVE' }, { taxType: 'OUTPUT2', status: 'ACTIVE' }],
    rows: [
      { taxType: 'INPUT2', name: 'Rate INPUT2', status: 'ARCHIVED', reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: vat20, canApply },
      { taxType: 'NONE', name: 'Rate NONE', status: 'ACTIVE', reportTaxType: 'OUTPUT', effectiveRate: null, displayTaxRate: '20.000000', components: [{ name: 'Zero', rate: '0.000000', compound: false, nonRecoverable: false }], canApply },
      { taxType: 'OUTPUT2', name: 'Rate OUTPUT2', status: 'ACTIVE', reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: vat20, canApply },
    ],
  })
})

// [mutation: the validation call removed from the sweep / the empty-list refusal removed]
test('REFUSED BODIES: an empty, partial, malformed or foreign response leaves the previous list, header, snapshot and stamp exactly as they were, and the run errors', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const A = `tenant-A-${run}`
  await wipe(deps)
  await bindTo(deps, A, run)
  setBody(goodBody('OUTPUT2', 'INPUT2'))
  await deps.drift.runXeroTaxRateDriftSweep()
  const before = await state(deps)
  assert.ok(before.includes('INPUT2'), 'PRECONDITION: a list is stored')

  const bad: Array<[string, unknown]> = [
    ['empty list', { TaxRates: [] }],
    ['no list', { Status: 'OK' }],
    ['not an object', 'TaxRates'],
    ['a different collection', { Accounts: [rateRow('OUTPUT2')] }],
    ['aliased row field', { TaxRates: [rateRow('OUTPUT2'), rateRow('INPUT2', { taxtype: 'OUTPUT2' })] }],
    ['malformed rate in the last row', { TaxRates: [rateRow('OUTPUT2'), rateRow('INPUT2'), rateRow('X', { TaxComponents: [{ Name: 'VAT', Rate: '20' }] })] }],
    ['duplicate tax type', { TaxRates: [rateRow('OUTPUT2'), rateRow('OUTPUT2')] }],
    ['aliased envelope field', { ...goodBody('OUTPUT2'), taxrates: [] }],
    ['not OK', { ...goodBody('OUTPUT2'), Status: 'ERROR' }],
  ]
  for (const [name, body] of bad) {
    setBody(body)
    await assert.rejects(deps.drift.runXeroTaxRateDriftSweep(), (error: Error) => error.name === 'XeroTaxRateListRefusedError', name)
    assert.equal(await state(deps), before, `${name}: nothing changed`)
  }
  // The control: the same sweep with a good body replaces the list.
  setBody(goodBody('OUTPUT2'))
  await deps.drift.runXeroTaxRateDriftSweep()
  assert.deepEqual((await deps.db.xeroTaxRate.findMany({ select: { taxType: true } })).map((r) => r.taxType), ['OUTPUT2'], 'CONTROL: a well-formed, shorter list replaces the previous one whole')
  assert.equal((await deps.db.xeroTaxRateList.findFirstOrThrow()).rowCount, 1)
})

test('UNKNOWN KEYS are dropped: the list is stored without them, the run succeeds, and one activity row names the keys (never values)', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await wipe(deps)
  await bindTo(deps, `tenant-A-${run}`, run)
  await deps.db.activityLog.deleteMany({ where: { action: 'xero_tax_rate_unknown_fields' } })
  setBody({ ...goodBody('OUTPUT2'), Pagination: { secret: 'v1' }, TaxRates: [rateRow('OUTPUT2', { Surprise: 'secret-value', TaxComponents: [{ Name: 'VAT', Rate: 20, Extra: 1 }] })] })
  await deps.drift.runXeroTaxRateDriftSweep()
  const section = await readSection(deps)
  assert.equal((section as { state: string }).state, 'proven')
  const logs = await deps.db.activityLog.findMany({ where: { action: 'xero_tax_rate_unknown_fields' } })
  assert.equal(logs.length, 1, 'once per run')
  assert.ok(!JSON.stringify(logs[0]).includes('secret'), 'names only')
  assert.deepEqual((logs[0]!.metadata as { ignored: unknown }).ignored, { body: ['Pagination'], row: ['Surprise'], component: ['Extra'] })
  await deps.db.activityLog.deleteMany({ where: { action: 'xero_tax_rate_unknown_fields' } })
})

// [mutation: the stamp written outside the transaction / before the list]
test('ATOMICITY: a failure in the middle of the replace (the header insert rejected) rolls back the rows, the snapshot and the stamp', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await wipe(deps)
  await bindTo(deps, `tenant-A-${run}`, run)
  setBody(goodBody('OUTPUT2', 'INPUT2'))
  await deps.drift.runXeroTaxRateDriftSweep()
  const before = await state(deps)

  await deps.db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION xtr_reject_header() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'xtr: header rejected'; END; $$ LANGUAGE plpgsql`)
  await deps.db.$executeRawUnsafe('CREATE TRIGGER xtr_reject_header BEFORE INSERT ON xero_tax_rate_lists FOR EACH ROW EXECUTE FUNCTION xtr_reject_header()')
  try {
    setBody(goodBody('OUTPUT2', 'INPUT2', 'EXTRA9'))
    await assert.rejects(deps.drift.runXeroTaxRateDriftSweep(), /xtr: header rejected/)
    assert.equal(await state(deps), before, 'rows, header, snapshot and stamp are all as they were')
    assert.equal((await readSection(deps) as { state: string }).state, 'proven', 'and the previous list still proves')
  } finally {
    await deps.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS xtr_reject_header ON xero_tax_rate_lists')
    await deps.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS xtr_reject_header()')
  }
  setBody(goodBody('OUTPUT2', 'INPUT2', 'EXTRA9'))
  await deps.drift.runXeroTaxRateDriftSweep()
  assert.equal(await deps.db.xeroTaxRate.count(), 3, 'CONTROL: without the trigger the same sweep stores the list')
})

// [mutation: the other-organisation delete removed from the store / the reader not keyed by organisation]
test('REBIND: the new organisation never reads the old one\'s list as its own, and its first stored list removes the old one', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await wipe(deps)
  await bindTo(deps, A, run)
  setBody(goodBody('OUTPUT2', 'INPUT2'))
  await deps.drift.runXeroTaxRateDriftSweep()
  assert.equal((await readSection(deps) as { state: string }).state, 'proven', 'PRECONDITION: A is proven')

  await bindTo(deps, B, run)
  assert.deepEqual(await readSection(deps), { state: 'unproven', cause: 'NO_HEADER' }, 'after the rebind, before any sweep: A\'s list does not stand for B')
  assert.equal(await deps.db.xeroTaxRate.count({ where: { tenantId: A } }), 2, '(A\'s rows are still stored; they are simply not B\'s)')

  setBody(goodBody('OUTPUT9'))
  await deps.drift.runXeroTaxRateDriftSweep()
  const section = await readSection(deps)
  assert.equal((section as { state: string; tenantId: string }).state, 'proven')
  assert.equal((section as { tenantId: string }).tenantId, B)
  assert.deepEqual((section as { taxTypes: unknown[] }).taxTypes, [{ taxType: 'OUTPUT9', status: 'ACTIVE' }])
  assert.equal(await deps.db.xeroTaxRate.count({ where: { tenantId: A } }), 0, 'A\'s rows are gone')
  assert.equal(await deps.db.xeroTaxRateList.count({ where: { tenantId: A } }), 0, 'and A\'s header')

  await bindTo(deps, A, run)
  assert.deepEqual(await readSection(deps), { state: 'unproven', cause: 'NO_HEADER' }, 'back to A: B\'s list is not A\'s, and A\'s old list was not kept')
})

// [mutation: the reader's count, digest or read-time check removed]
test('TAMPERING with the stored list is caught by the pack reader on a real database: a deleted row, an edited row, a swapped tax type, a mixed read, a removed header', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const A = `tenant-A-${run}`
  await wipe(deps)
  await bindTo(deps, A, run)
  const fresh = async () => { setBody(goodBody('OUTPUT2', 'INPUT2', 'TAX001')); await deps.drift.runXeroTaxRateDriftSweep(); assert.equal((await readSection(deps) as { state: string }).state, 'proven') }
  const cause = async () => (await readSection(deps) as { cause?: string }).cause

  await fresh()
  await deps.db.xeroTaxRate.delete({ where: { connector_tenantId_taxType: { connector: 'xero', tenantId: A, taxType: 'TAX001' } } })
  assert.equal(await cause(), 'COUNT_MISMATCH')
  await fresh()
  await deps.db.xeroTaxRate.update({ where: { connector_tenantId_taxType: { connector: 'xero', tenantId: A, taxType: 'TAX001' } }, data: { name: 'edited' } })
  assert.equal(await cause(), 'DIGEST_MISMATCH')
  await fresh()
  await deps.db.xeroTaxRate.update({ where: { connector_tenantId_taxType: { connector: 'xero', tenantId: A, taxType: 'TAX001' } }, data: { taxType: 'SWAP01' } })
  assert.equal(await cause(), 'DIGEST_MISMATCH', 'IDENTITY SWAP: same count, one tax type swapped')
  await fresh()
  await deps.db.xeroTaxRate.update({ where: { connector_tenantId_taxType: { connector: 'xero', tenantId: A, taxType: 'TAX001' } }, data: { fetchedAt: new Date(Date.now() - 86_400_000) } })
  assert.equal(await cause(), 'MIXED_READ')
  await fresh()
  await deps.db.xeroTaxRate.update({ where: { connector_tenantId_taxType: { connector: 'xero', tenantId: A, taxType: 'TAX001' } }, data: { components: [{ name: 'VAT' }] } })
  assert.equal(await cause(), 'MALFORMED_ROW')
  await fresh()
  await deps.db.xeroTaxRateList.deleteMany({})
  assert.equal(await cause(), 'NO_HEADER')
  await fresh()
  await deps.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  assert.equal(await cause(), 'NO_CONNECTION')
})

test('the database refuses what the store never writes: a blank organisation, a non-array components value, an empty or malformed header', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  await wipe(deps)
  const base = { tenantId: 't', taxType: 'X', name: 'n', status: 'ACTIVE', components: [], fetchedAt: new Date() }
  await assert.rejects(deps.db.xeroTaxRate.create({ data: { ...base, tenantId: '  ' } }), /xero_tax_rates_tenant_not_blank/)
  await assert.rejects(deps.db.xeroTaxRate.create({ data: { ...base, taxType: '' } }), /xero_tax_rates_tax_type_not_blank/)
  await assert.rejects(deps.db.xeroTaxRate.create({ data: { ...base, components: { a: 1 } } }), /xero_tax_rates_components_is_array/)
  await deps.db.xeroTaxRate.create({ data: base })
  await assert.rejects(deps.db.xeroTaxRate.create({ data: base }), /Unique constraint/, 'one row per (connector, organisation, tax type)')
  const header = { tenantId: 't', fetchedAt: new Date(), rowCount: 1, digest: 'a'.repeat(64) }
  await assert.rejects(deps.db.xeroTaxRateList.create({ data: { ...header, rowCount: 0 } }), /xero_tax_rate_lists_row_count_positive/)
  await assert.rejects(deps.db.xeroTaxRateList.create({ data: { ...header, digest: 'XYZ' } }), /xero_tax_rate_lists_digest_hex/)
  await deps.db.xeroTaxRateList.create({ data: header })
  await assert.rejects(deps.db.xeroTaxRateList.create({ data: header }), /Unique constraint/, 'one header per (connector, organisation)')
  await wipe(deps)
})
