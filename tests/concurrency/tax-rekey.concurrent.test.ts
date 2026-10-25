import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { config } from 'dotenv'

/**
 * THE RE-KEY OF IMS TAX RATES TO THE CONNECTED XERO ORGANISATION'S CUSTOM CODES, COMMITTED, AGAINST A REAL DATABASE (the matcher, the digest and the refusal rules are in tests/tax/tax-rekey.test.ts).
 * It lives in the concurrency tier because that tier positively identifies a disposable database before ANY write (scratch-database-setup.ts above). It seeds its own uniquely tagged Xero list
 * (header, rows, last-success stamp, token), IMS rates, components, suppliers, storefront mappings and documents, and removes only those by id at the end. It NEVER deletes data it did not create: the
 * run reads the whole stored Xero list, so the Xero store, the token and the stamp must be empty, and if foreign rows are there it FAILS LOUDLY at the precondition (before any write).
 *
 * The world (names carry the run tag; the old codes are the Demo organisation's numbering, the live codes are the connected organisation's, and they CLASH on purpose):
 *   IMS  "CY VAT" 19% on PB, "GR VAT" 24% on PA, "BE VAT" 21% on a code no live type has, "BG VAT" 20% on PB (already right), "AMB VAT", "PCT VAT" 12%, "NOPE VAT"
 *   LIVE BE VAT PA 21, BG VAT PB 20, CY VAT PC 19, GR VAT PD 24, AMB VAT PE+PF 5, PCT VAT PX 10
 * so CY, GR and BE are re-keyed (to PC, PD, PA: GR's old code is BE's new one, the swap), BG is ALREADY_CORRECT, AMB is AMBIGUOUS, PCT is PERCENTAGE_DIFFERS, NOPE is NO_MATCH.
 *
 * Mutations (seen red, reverted): the old row's code edited in place instead of a new row -> the "never edits a referenced row" arm; the supplier / mapping re-point removed -> the re-point arm;
 * the unposted check removed from applyRefusal -> the "unposted block" arm; the digest comparison removed -> the digest arm; the fence removed (write on db directly) -> the concurrent arm creates
 * twice; a write added to readRekeyPlan (an updateMany of an owned rate) -> the no-write digest arm.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1 (npm run test:concurrency)'

const run = randomBytes(4).toString('hex')
const TENANT = `tenant-rk-${run}`
const TAG = `ZQRK${run} `
const P = `ZQRK${run.toUpperCase()}`
const code = (s: string) => `${P}${s}`

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, rekey, listLib, drift, vat] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/tax/tax-rekey.ts'),
    import('../../lib/connectors/xero/tax-rate-list.ts'),
    import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts'),
    import('../../lib/tax/vat-difference-run.ts'),
  ])
  return { db, rekey, listLib, drift, vat }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const xero = (taxType: string, name: string, percent: string, expenses = false) => ({
  taxType, name: `${TAG}${name}`, status: 'ACTIVE' as const, reportTaxType: null, effectiveRate: `${percent}.000000`, displayTaxRate: `${percent}.000000`,
  components: [{ name: 'VAT', rate: `${percent}.000000`, compound: false, nonRecoverable: false }],
  canApply: { assets: false, equity: false, expenses, liabilities: false, revenue: true },
})
const LIVE = () => [
  xero(code('A'), 'BE VAT', '21'), xero(code('B'), 'BG VAT', '20'), xero(code('C'), 'CY VAT', '19'), xero(code('D'), 'GR VAT', '24', true),
  xero(code('E'), 'AMB VAT', '5'), xero(code('F'), 'AMB VAT', '5'), xero(code('X'), 'PCT VAT', '10'),
]

const created = { rates: [] as string[], suppliers: [] as string[], mappings: [] as string[], orders: [] as string[], pos: [] as string[], products: [] as string[], logs: [] as string[], events: [] as string[], invoices: [] as string[], digests: [] as string[] }

async function wipeOwn(d: Deps) {
  const { db } = d
  const rateIds = (await db.taxRate.findMany({ where: { OR: [{ id: { in: created.rates } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((r) => r.id)
  await db.accountingSyncLog.deleteMany({ where: { id: { in: created.logs } } })
  await db.accountingEvent.deleteMany({ where: { id: { in: created.events } } })
  await db.purchaseInvoice.deleteMany({ where: { id: { in: created.invoices } } })
  await db.purchaseOrderLine.deleteMany({ where: { OR: [{ poId: { in: created.pos } }, { taxRateId: { in: rateIds } }] } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.pos } } })
  await db.salesOrderLine.deleteMany({ where: { OR: [{ orderId: { in: created.orders } }, { taxRateId: { in: rateIds } }] } })
  await db.salesOrder.deleteMany({ where: { id: { in: created.orders } } })
  await db.shoppingTaxRateMapping.deleteMany({ where: { OR: [{ id: { in: created.mappings } }, { taxRateId: { in: rateIds } }] } })
  await db.supplier.deleteMany({ where: { OR: [{ id: { in: created.suppliers } }, { taxRateId: { in: rateIds } }] } })
  await db.product.deleteMany({ where: { id: { in: created.products } } })
  for (const digest of created.digests) await db.activityLog.deleteMany({ where: { action: 'tax_rates_rekeyed_to_xero_codes', metadata: { path: ['planDigest'], equals: digest } } })
  await db.taxRateComponent.deleteMany({ where: { taxRateId: { in: rateIds } } })
  await db.taxRate.deleteMany({ where: { id: { in: rateIds } } })
  for (const key of Object.keys(created) as Array<keyof typeof created>) created[key] = []
}
async function wipeXero(d: Deps) {
  await d.db.setting.deleteMany({ where: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING } })
  await d.db.accountingToken.deleteMany({ where: { connector: 'xero', tenantId: TENANT } })
  await d.db.xeroTaxRateList.deleteMany({ where: { tenantId: TENANT } })
  await d.db.xeroTaxRate.deleteMany({ where: { tenantId: TENANT } })
}

async function precondition(d: Deps) {
  const foreign = {
    xeroRates: await d.db.xeroTaxRate.count({ where: { NOT: { tenantId: TENANT } } }),
    xeroLists: await d.db.xeroTaxRateList.count({ where: { NOT: { tenantId: TENANT } } }),
    xeroTokens: await d.db.accountingToken.count({ where: { connector: 'xero', NOT: { tenantId: TENANT } } }),
  }
  assert.deepEqual(foreign, { xeroRates: 0, xeroLists: 0, xeroTokens: 0 }, 'PRECONDITION: this scratch database holds Xero rows this test did not create; it will not delete them. Use a database with an empty Xero store.')
}

async function seedXero(d: Deps, rows = LIVE(), fetchedAt = new Date(Date.now() - 300_000)) {
  await wipeXero(d)
  await d.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000), tenantId: TENANT, tenantName: `Org ${TENANT}`, connectionGeneration: `gen-${run}` } })
  await d.db.xeroTaxRate.createMany({
    data: rows.map((r) => ({
      connector: 'xero', tenantId: TENANT, fetchedAt, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components,
      canApplyToAssets: r.canApply.assets, canApplyToEquity: r.canApply.equity, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: r.canApply.liabilities, canApplyToRevenue: r.canApply.revenue,
    })),
  })
  await d.db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: TENANT, fetchedAt, rowCount: rows.length, digest: d.listLib.digestTaxRateList(TENANT, rows as never) } })
  await d.db.setting.upsert({ where: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, create: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: fetchedAt.toISOString() }, update: { value: fetchedAt.toISOString() } })
}

async function seedWorld(d: Deps) {
  const { db } = d
  await wipeOwn(d)
  await seedXero(d)
  const rate = async (key: string, name: string, fraction: string, oldCode: string, over: { usedFor?: string; isDefault?: boolean; components?: boolean } = {}) => {
    const row = await db.taxRate.create({
      data: {
        name: `${TAG}${name}`, rate: fraction, usedFor: over.usedFor ?? 'SALES', accountingTaxType: oldCode, countryCode: null, isDefault: over.isDefault ?? false, reportingCategory: 'EC_SALES', isCompound: false,
        components: over.components === false ? undefined : { create: [{ name: 'VAT', rate: fraction, sortOrder: 0, accountingTaxType: key === 'cy' ? code('DEMO') : key === 'gr' ? 'OUTPUT2' : null }] },
      },
    })
    created.rates.push(row.id)
    return [key, row.id] as const
  }
  const ids = Object.fromEntries([
    await rate('cy', 'CY VAT', '0.1900', code('B'), { isDefault: true }),
    await rate('gr', 'GR VAT', '0.2400', code('A'), { usedFor: 'BOTH' }),
    await rate('be', 'BE VAT', '0.2100', code('OLD1')),
    await rate('bg', 'BG VAT', '0.2000', code('B')),
    await rate('amb', 'AMB VAT', '0.0500', code('OLD2')),
    await rate('pct', 'PCT VAT', '0.1200', code('OLD3')),
    await rate('nope', 'NOPE VAT', '0.0700', code('OLD4')),
  ]) as Record<'cy' | 'gr' | 'be' | 'bg' | 'amb' | 'pct' | 'nope', string>
  const supplier = async (name: string, taxRateId: string) => { const s = await db.supplier.create({ data: { name: `${TAG}${name}`, taxRateId } }); created.suppliers.push(s.id); return s.id }
  const supCy = await supplier('Sup CY', ids.cy)
  const supGr = await supplier('Sup GR', ids.gr)
  const supBg = await supplier('Sup BG', ids.bg)
  const mapping = await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: `rk${run}1`, externalName: 'CY VAT', externalRatePct: '19', externalClass: 'standard', taxRateId: ids.cy } })
  const mappingBg = await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: `rk${run}2`, externalName: 'BG VAT', externalRatePct: '20', externalClass: 'standard', taxRateId: ids.bg } })
  created.mappings.push(mapping.id, mappingBg.id)
  const money = { subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10 }
  const lineData = { description: 'x', qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }
  const order = async (key: string, taxRateId: string, over: { status?: 'DRAFT' | 'PROCESSING' | 'CANCELLED'; invoiceId?: string } = {}) => {
    const o = await db.salesOrder.create({ data: { orderNumber: `RK${run}-${key}`, status: over.status ?? 'DRAFT', ...money, accountingInvoiceId: over.invoiceId ?? null, lines: { create: [{ ...lineData, taxRateId }] } }, select: { id: true, lines: { select: { id: true } } } })
    created.orders.push(o.id)
    return { id: o.id, lineId: o.lines[0]!.id }
  }
  const soPosted = await order('posted', ids.cy, { status: 'PROCESSING', invoiceId: `inv-${run}` })
  const soDraftCy = await order('draft-cy', ids.cy)
  const soDraftGr = await order('draft-gr', ids.gr)
  const soCancelled = await order('cancelled', ids.cy, { status: 'CANCELLED' })
  const product = await db.product.create({ data: { sku: `RK${run}`, name: `${TAG}product`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  created.products.push(product.id)
  const po = async (key: string, taxRateId: string, posted: boolean) => {
    const p = await db.purchaseOrder.create({
      data: {
        reference: `PO-RK${run}-${key}`, supplierId: supCy, status: 'DRAFT', currency: 'GBP', fxRateToBase: 1, ...money,
        lines: { create: [{ productId: product.id, qty: 1, unitCostForeign: 10, unitCostBase: 10, totalForeign: 10, totalBase: 10, taxRateId }] },
      }, select: { id: true, lines: { select: { id: true } } },
    })
    created.pos.push(p.id)
    if (posted) {
      const invoice = await db.purchaseInvoice.create({ data: { poId: p.id, invoiceDate: new Date(), totalForeign: 10, totalBase: 10, fxRateToBase: 1 } })
      created.invoices.push(invoice.id)
    }
    return { id: p.id, lineId: p.lines[0]!.id }
  }
  const poDraftBe = await po('be', ids.be, false)
  const poPostedCy = await po('posted-cy', ids.cy, true)
  return { ids, supCy, supGr, supBg, mapping: mapping.id, mappingBg: mappingBg.id, soPosted, soDraftCy, soDraftGr, soCancelled, poDraftBe, poPostedCy }
}
type World = Awaited<ReturnType<typeof seedWorld>>

/** A digest of every row this test owns (with xmin, so ANY write, even of the same value, changes it). */
async function ownedDigest(d: Deps, w: World): Promise<string> {
  const rateIds = (await d.db.taxRate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id)
  const parts: Array<[string, string, unknown[]]> = [
    ['rates', `SELECT t.*, t.xmin::text AS x FROM tax_rates t WHERE t."id" = ANY($1)`, [rateIds]],
    ['components', `SELECT c.*, c.xmin::text AS x FROM tax_rate_components c WHERE c."tax_rate_id" = ANY($1)`, [rateIds]],
    ['suppliers', `SELECT s.*, s.xmin::text AS x FROM suppliers s WHERE s."id" = ANY($1)`, [created.suppliers]],
    ['mappings', `SELECT m.*, m.xmin::text AS x FROM shopping_tax_rate_mappings m WHERE m."id" = ANY($1)`, [created.mappings]],
    ['so-lines', `SELECT l.*, l.xmin::text AS x FROM sales_order_lines l WHERE l."orderId" = ANY($1)`, [created.orders]],
    ['po-lines', `SELECT l.*, l.xmin::text AS x FROM purchase_order_lines l WHERE l."poId" = ANY($1)`, [created.pos]],
    ['xero-rates', `SELECT r.*, r.xmin::text AS x FROM xero_tax_rates r WHERE r."tenantId" = $1`, [TENANT]],
    ['xero-list', `SELECT l.*, l.xmin::text AS x FROM xero_tax_rate_lists l WHERE l."tenantId" = $1`, [TENANT]],
    ['logs', `SELECT a.id, a.xmin::text AS x FROM activity_logs a WHERE a.action = 'tax_rates_rekeyed_to_xero_codes' AND a.metadata->>'planDigest' = ANY($1)`, [created.digests]],
  ]
  void w
  const out: string[] = []
  for (const [name, sql, args] of parts) {
    const rows = await d.db.$queryRawUnsafe<Array<{ d: string; n: bigint }>>(`SELECT md5(coalesce(string_agg(q::text, '|' ORDER BY q::text), '')) AS d, count(*) AS n FROM (${sql}) q`, ...args)
    out.push(`${name}:${rows[0]!.n}:${rows[0]!.d}`)
  }
  return out.join(' ')
}

after(async () => {
  if (!RUN) return
  const d = await loadDeps()
  await wipeOwn(d)
  await wipeXero(d)
  await d.db.$disconnect()
})

const ours = <T extends { name: string }>(plan: { rows: T[] }) => plan.rows.filter((r) => r.name.startsWith(TAG))
const byName = (plan: { rows: Array<{ name: string; outcome: string }> }) => Object.fromEntries(ours(plan).map((r) => [r.name.slice(TAG.length), r.outcome]))
const WOO = { async get(): Promise<{ ok: true; status: number; total: string; totalPages: string; body: unknown[] }> { return { ok: true, status: 200, total: '0', totalPages: '1', body: [] } } }

// [mutation: a write (an updateMany of an owned rate) added to readRekeyPlan -> the digest arm fails]
test('the PREVIEW reads a real database, gives each rate its outcome, and writes nothing (not even on a refusal)', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const before = await ownedDigest(d, w)
  const preview = await d.rekey.runTaxRekey({ apply: false })
  assert.equal(preview.refusal, null)
  const plan = preview.plan!
  assert.deepEqual(byName(plan), { 'CY VAT': 'REKEY', 'GR VAT': 'REKEY', 'BE VAT': 'REKEY', 'BG VAT': 'ALREADY_CORRECT', 'AMB VAT': 'AMBIGUOUS', 'PCT VAT': 'PERCENTAGE_DIFFERS', 'NOPE VAT': 'NO_MATCH' })
  const target = (n: string) => ours(plan).find((r) => r.name === `${TAG}${n}`) as unknown as { target: { taxType: string }; matchedBy: string }
  assert.deepEqual([target('CY VAT').target.taxType, target('GR VAT').target.taxType, target('BE VAT').target.taxType], [code('C'), code('D'), code('A')])
  assert.equal(target('CY VAT').matchedBy, 'EXACT')
  assert.deepEqual(plan.blockers.filter((b) => ours(plan).some((r) => (r as unknown as { imsRateId: string }).imsRateId === b.imsRateId)), [], 'the swap (GR frees PA for BE) is not a blocker')
  // Documents: the cancelled order and the posted ones are not "unposted"; the drafts are.
  const refs = plan.references
  assert.deepEqual(
    [refs[w.ids.cy]!.unpostedSalesOrders, refs[w.ids.cy]!.postedSalesOrders, refs[w.ids.cy]!.postedPurchaseOrders, refs[w.ids.cy]!.suppliers, refs[w.ids.cy]!.storefrontMappings, refs[w.ids.cy]!.isDefault],
    [1, 1, 1, 1, 1, true],
  )
  assert.deepEqual([refs[w.ids.gr]!.unpostedSalesOrders, refs[w.ids.be]!.unpostedPurchaseOrders], [1, 1])
  assert.equal(await ownedDigest(d, w), before, 'the preview wrote nothing to the rows it read')

  const stale = await d.rekey.runTaxRekey({ apply: false, now: new Date(Date.now() + 3 * 24 * 3_600_000) })
  assert.deepEqual([stale.refusal?.code, stale.plan], ['XERO_LIST_STALE', null])
  const refusedApply = await d.rekey.runTaxRekey({ apply: true, confirm: plan.digest, now: new Date(Date.now() + 3 * 24 * 3_600_000) })
  assert.deepEqual([refusedApply.refusal?.code, refusedApply.wrote], ['XERO_LIST_STALE', false], 'an untrusted / stale list refuses an apply too')
  assert.equal(await ownedDigest(d, w), before, 'a refusal wrote nothing')

  // The report before: the old codes point at live types with other percentages.
  const report = await d.vat.runVatDifferenceReport({ db: d.db, now: () => new Date(), woo: WOO, wooOptions: { sleep: async () => undefined } })
  assert.equal(report.status, 'compared')
  if (report.status === 'compared') {
    assert.equal(report.differences.some((x) => x.reason === 'PERCENTAGE_MISMATCH_IMS_XERO' && x.imsRateId === w.ids.cy), true, 'control: CY VAT (19%) sits on a code that is BG VAT (20%) in the live organisation')
  }
  assert.equal(await ownedDigest(d, w), before, 'the report wrote nothing either')
})

// [mutation: the digest comparison removed from runTaxRekey -> the wrong-digest arm writes; mutation: the unposted check removed from applyRefusal -> the unposted arm writes]
test('an apply is refused without the previewed digest, while unposted orders reference a re-keyed rate, and while a payload carrying the old code is queued; each time nothing is written', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const before = await ownedDigest(d, w)
  const attempt = async (options: Parameters<Deps['rekey']['runTaxRekey']>[0]) => {
    const r = await d.rekey.runTaxRekey(options)
    assert.equal(r.wrote, false)
    assert.equal(await ownedDigest(d, w), before, `nothing written: ${r.refusal?.code}`)
    return r.refusal?.code ?? null
  }
  assert.equal(await attempt({ apply: true }), 'CONFIRM_REQUIRED')
  assert.equal(await attempt({ apply: true, confirm: 'not-a-digest' }), 'CONFIRM_REQUIRED')
  assert.equal(await attempt({ apply: true, confirm: '0'.repeat(64), allowUnposted: true }), 'DIGEST_MISMATCH')
  assert.equal(await attempt({ apply: true, confirm: preview.digest }), 'UNPOSTED_DOCUMENTS', 'the right digest still refuses while draft orders would post the old code')

  // A queued payload carrying the old code blocks even with the flag (the digest changes with the count: re-preview).
  const log = await d.db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: w.soDraftCy.id, payload: { lines: [{ description: 'x', taxType: code('B') }] } } })
  created.logs.push(log.id)
  const queued = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.notEqual(queued.digest, preview.digest, 'the queued payload is part of what the digest covers')
  assert.equal(queued.references[w.ids.cy]!.queuedSyncRows, 1)
  assert.equal(await attempt({ apply: true, confirm: queued.digest, allowUnposted: true }), 'QUEUED_PAYLOADS')
  // The old code in a payload that has been SENT (SYNCED) is history, not a block.
  await d.db.accountingSyncLog.update({ where: { id: log.id }, data: { status: 'SYNCED' } })
  const after = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.equal(after.references[w.ids.cy]!.queuedSyncRows, 0)
  // An accounting event not yet posted blocks the same way.
  const event = await d.db.accountingEvent.create({ data: { type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: w.soDraftCy.id, businessDate: new Date(), status: 'PENDING', idempotencyKey: `rk-${run}`, currency: 'GBP', linesJson: [{ taxType: code('B') }] } })
  created.events.push(event.id)
  assert.equal((await d.rekey.runTaxRekey({ apply: false })).plan!.references[w.ids.cy]!.queuedEvents, 1)
})

// [mutation: the old row's code edited in place instead of a new row -> the never-edited arm fails]
test('the apply creates new rows, deactivates the old and never edits a referenced row; defaults, storefront mappings and unposted lines move; posted lines stay; a re-run is a no-op', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const { db } = d
  const frozen = async (id: string) => { const r = await db.taxRate.findUniqueOrThrow({ where: { id }, include: { components: { orderBy: { sortOrder: 'asc' } } } }); const rest: Record<string, unknown> = { ...r }; for (const k of ['active', 'isDefault', 'updatedAt']) delete rest[k]; return JSON.stringify(rest) }
  const oldBefore = { cy: await frozen(w.ids.cy), gr: await frozen(w.ids.gr), be: await frozen(w.ids.be), bg: await frozen(w.ids.bg), amb: await frozen(w.ids.amb), pct: await frozen(w.ids.pct), nope: await frozen(w.ids.nope) }
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const result = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
  created.digests.push(preview.digest)
  assert.equal(result.refusal, null)
  assert.equal(result.wrote, true)
  assert.deepEqual(result.written!.created.map((c) => `${c.fromCode.slice(P.length)}->${c.toCode.slice(P.length)}`).sort(), ['A->D', 'B->C', 'OLD1->A'])

  // The old rows: only active/isDefault changed (name, rate, code, flags, components all as they were); the untouched outcomes are not touched at all.
  for (const [key, id] of Object.entries(w.ids)) assert.equal(await frozen(id), oldBefore[key as keyof typeof oldBefore], `${key}: nothing but active/isDefault may change on an existing row`)
  const oldRows = await db.taxRate.findMany({ where: { id: { in: [w.ids.cy, w.ids.gr, w.ids.be] } }, select: { id: true, active: true, isDefault: true } })
  assert.deepEqual(oldRows.map((r) => [r.active, r.isDefault]), [[false, false], [false, false], [false, false]])
  const untouched = await db.taxRate.findMany({ where: { id: { in: [w.ids.bg, w.ids.amb, w.ids.pct, w.ids.nope] } }, select: { active: true } })
  assert.deepEqual(untouched.map((r) => r.active), [true, true, true, true])

  // The new rows: the live code, everything else the old row's, components copied, active, the default moved.
  const fresh = await db.taxRate.findMany({ where: { name: { startsWith: TAG }, active: true, accountingTaxType: { in: [code('A'), code('C'), code('D')] }, NOT: { id: { in: [w.ids.bg] } } }, include: { components: true }, orderBy: { name: 'asc' } })
  assert.deepEqual(fresh.map((r) => [r.name.slice(TAG.length), r.accountingTaxType!.slice(P.length), r.rate.toFixed(4), r.usedFor, r.reportingCategory, r.isDefault, r.components.length, r.components[0]?.rate.toFixed(4)]), [
    ['BE VAT', 'A', '0.2100', 'SALES', 'EC_SALES', false, 1, '0.2100'],
    ['CY VAT', 'C', '0.1900', 'SALES', 'EC_SALES', true, 1, '0.1900'],
    ['GR VAT', 'D', '0.2400', 'BOTH', 'EC_SALES', false, 1, '0.2400'],
  ])
  // Components: a stale Demo code is cleared on the NEW row only; a built-in is kept; the old rows' components are untouched (the frozen snapshot above).
  assert.deepEqual(fresh.map((r) => [r.name.slice(TAG.length), r.components[0]?.accountingTaxType ?? null]), [['BE VAT', null], ['CY VAT', null], ['GR VAT', 'OUTPUT2']])
  assert.equal((await db.taxRateComponent.findFirstOrThrow({ where: { taxRateId: w.ids.cy } })).accountingTaxType, code('DEMO'), 'the referenced old row keeps its component as it was')
  const newId = (name: string) => fresh.find((r) => r.name === `${TAG}${name}`)!.id

  // References: suppliers and mappings follow; the untouched rate's follow nothing.
  const sup = async (id: string) => (await db.supplier.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await sup(w.supCy), await sup(w.supGr), await sup(w.supBg)], [newId('CY VAT'), newId('GR VAT'), w.ids.bg])
  const map = async (id: string) => (await db.shoppingTaxRateMapping.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await map(w.mapping), await map(w.mappingBg)], [newId('CY VAT'), w.ids.bg])
  // Documents: EVERY not-cancelled one moved (posted ones can still be edited / re-sent / credited / billed again and would send the old code); the cancelled one is left alone.
  const soLine = async (id: string) => (await db.salesOrderLine.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await soLine(w.soPosted.lineId), await soLine(w.soCancelled.lineId), await soLine(w.soDraftCy.lineId), await soLine(w.soDraftGr.lineId)], [newId('CY VAT'), w.ids.cy, newId('CY VAT'), newId('GR VAT')])
  const poLine = async (id: string) => (await db.purchaseOrderLine.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await poLine(w.poPostedCy.lineId), await poLine(w.poDraftBe.lineId)], [newId('CY VAT'), newId('BE VAT')])
  assert.equal(await db.activityLog.count({ where: { action: 'tax_rates_rekeyed_to_xero_codes', metadata: { path: ['planDigest'], equals: preview.digest } } }), 1)

  // The report afterwards: no percentage mismatch for a re-keyed rate.
  const report = await d.vat.runVatDifferenceReport({ db, now: () => new Date(), woo: WOO, wooOptions: { sleep: async () => undefined } })
  assert.equal(report.status, 'compared')
  if (report.status === 'compared') {
    const mine = report.differences.filter((x) => x.reason === 'PERCENTAGE_MISMATCH_IMS_XERO' && [newId('CY VAT'), newId('GR VAT'), newId('BE VAT'), w.ids.cy, w.ids.gr, w.ids.be].includes(x.imsRateId ?? ''))
    assert.deepEqual(mine, [], 'after the apply the re-keyed rates are not percentage mismatches')
  }

  // Idempotent: the same call again, and a fresh preview, change nothing at all.
  const settled = await ownedDigest(d, w)
  const again = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
  assert.deepEqual([again.refusal, again.wrote, again.written], [null, false, null])
  const replan = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.equal(replan.counts.REKEY, ours(replan).filter((r) => r.name === 'nothing').length, 'no rate of this run is left to re-key')
  assert.deepEqual(byName(replan), { 'BE VAT': 'ALREADY_CORRECT', 'CY VAT': 'ALREADY_CORRECT', 'GR VAT': 'ALREADY_CORRECT', 'BG VAT': 'ALREADY_CORRECT', 'AMB VAT': 'AMBIGUOUS', 'PCT VAT': 'PERCENTAGE_DIFFERS', 'NOPE VAT': 'NO_MATCH' })
  assert.equal(await ownedDigest(d, w), settled, 'a re-run wrote nothing')
})

// [mutation: the fence's lock removed (write on db directly) -> both writers create -> red]
test('two applies at once: exactly one writes, the other finds nothing to do; and a connection that changes between the plan and the write discards it', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  const [a, b] = await Promise.all([
    d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true }),
    d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true }),
  ])
  assert.equal([a, b].filter((r) => r.wrote).length, 1, 'only one of the two wrote')
  assert.deepEqual([a, b].map((r) => r.refusal === null || r.refusal.code === 'DIGEST_MISMATCH'), [true, true])
  const active = await d.db.taxRate.findMany({ where: { name: { startsWith: TAG }, active: true, id: { notIn: [w.ids.bg, w.ids.amb, w.ids.pct, w.ids.nope] } } })
  assert.equal(active.length, 3, 'each rate re-keyed exactly once')

  // The connection is rebound after the first plan has read the stored list and before the locked write.
  const w2 = await seedWorld(d)
  const preview2 = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const before = await ownedDigest(d, w2)
  const target = d.db.xeroTaxRateList as unknown as { findMany: (args: never) => Promise<unknown> }
  const original = target.findMany.bind(target)
  let calls = 0
  target.findMany = async (args: never) => {
    const result = await original(args)
    if (++calls === 1) await d.db.accountingToken.updateMany({ where: { connector: 'xero', tenantId: TENANT }, data: { connectionGeneration: `rebound-${run}` } })
    return result
  }
  try {
    const r = await d.rekey.runTaxRekey({ apply: true, confirm: preview2.digest, allowUnposted: true })
    assert.deepEqual([r.refusal?.code, r.wrote], ['XERO_CONNECTION_CHANGED', false])
    assert.equal(await ownedDigest(d, w2), before)
  } finally { target.findMany = original }
  const control = await d.rekey.runTaxRekey({ apply: true, confirm: preview2.digest, allowUnposted: true })
  assert.equal(control.wrote, true, 'control: with no rebind the same call writes')
})

// [mutation: posted documents excluded from the blocking set (back to "posted = stays") -> the arm applies without the flag and fails]
test('an ALREADY-POSTED invoiced order and a part-billed PO are future posting sources: they alone block the apply, and the flag re-points their lines', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const { db } = d
  // Leave only posted sources: the never-posted drafts are cancelled (a cancelled document is not a source).
  await db.salesOrder.updateMany({ where: { id: { in: [w.soDraftCy.id, w.soDraftGr.id] } }, data: { status: 'CANCELLED' } })
  await db.purchaseOrder.updateMany({ where: { id: { in: [w.poDraftBe.id] } }, data: { status: 'CANCELLED' } })
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  const cy = preview.references[w.ids.cy]!
  assert.deepEqual([cy.unpostedSalesOrders, cy.postedSalesOrders, cy.postedPurchaseOrders], [0, 1, 1])
  const before = await ownedDigest(d, w)
  const refused = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest })
  assert.deepEqual([refused.refusal?.code, refused.wrote], ['UNPOSTED_DOCUMENTS', false])
  assert.equal(await ownedDigest(d, w), before)
  const done = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
  assert.equal(done.wrote, true)
  const newCy = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}CY VAT`, active: true } })).id
  assert.equal((await db.salesOrderLine.findUniqueOrThrow({ where: { id: w.soPosted.lineId } })).taxRateId, newCy, 'the invoiced order\'s line follows')
  assert.equal((await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: w.poPostedCy.lineId } })).taxRateId, newCy, 'the billed PO\'s line follows')
  assert.equal((await db.salesOrderLine.findUniqueOrThrow({ where: { id: w.soCancelled.lineId } })).taxRateId, w.ids.cy, 'a cancelled order stays on the old row')
})
