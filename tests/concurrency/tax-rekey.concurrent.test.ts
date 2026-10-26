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
  // The apply is allowed only while Xero is held (xeroHoldState); the scratch environment is not, so the run is handed a held one.
  const held = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }
  return { db, rekey: { ...rekey, runTaxRekey: (o: Parameters<typeof rekey.runTaxRekey>[0]) => rekey.runTaxRekey({ producerEnv: held, ...o }) }, listLib, drift, vat }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const xero = (taxType: string, name: string, percent: string, expenses = false) => ({
  taxType, name: `${TAG}${name}`, status: 'ACTIVE' as const, reportTaxType: 'ECOUTPUTSERVICES' /* the IMS fixture rates are EC_SALES sales rates: the box the report-type helper assigns them */, effectiveRate: `${percent}.000000`, displayTaxRate: `${percent}.000000`,
  components: [{ name: 'VAT', rate: `${percent}.000000`, compound: false, nonRecoverable: false }],
  canApply: { assets: false, equity: false, expenses, liabilities: false, revenue: true },
})
const LIVE = () => [
  xero(code('A'), 'BE VAT', '21'), xero(code('B'), 'BG VAT', '20'), xero(code('C'), 'CY VAT', '19'), xero(code('D'), 'GR VAT', '24', true),
  xero(code('E'), 'AMB VAT', '5'), xero(code('F'), 'AMB VAT', '5'), xero(code('X'), 'PCT VAT', '10'),
]

const created = { rates: [] as string[], suppliers: [] as string[], mappings: [] as string[], orders: [] as string[], pos: [] as string[], products: [] as string[], logs: [] as string[], events: [] as string[], invoices: [] as string[], refunds: [] as string[], digests: [] as string[] }

async function wipeOwn(d: Deps) {
  const { db } = d
  const rateIds = (await db.taxRate.findMany({ where: { OR: [{ id: { in: created.rates } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((r) => r.id)
  await db.accountingPostingRefusal.deleteMany({ where: { referenceId: { in: created.orders } } })
  await db.accountingSyncLog.deleteMany({ where: { OR: [{ id: { in: created.logs } }, { referenceId: { in: created.orders } }] } })
  const retiredSetting = await db.setting.findUnique({ where: { key: 'tax_rekey_retired_codes' } })
  if (retiredSetting) {
    const kept = Object.fromEntries(Object.entries(JSON.parse(retiredSetting.value) as Record<string, unknown>).filter(([k]) => !k.startsWith(P)))
    if (Object.keys(kept).length === 0) await db.setting.deleteMany({ where: { key: 'tax_rekey_retired_codes' } })
    else await db.setting.update({ where: { key: 'tax_rekey_retired_codes' }, data: { value: JSON.stringify(kept) } })
  }
  await db.accountingEvent.deleteMany({ where: { id: { in: created.events } } })
  await db.purchaseInvoice.deleteMany({ where: { id: { in: created.invoices } } })
  await db.purchaseOrderLine.deleteMany({ where: { OR: [{ poId: { in: created.pos } }, { taxRateId: { in: rateIds } }] } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.pos } } })
  await db.salesOrderRefundLine.deleteMany({ where: { refundId: { in: created.refunds } } })
  await db.salesOrderRefund.deleteMany({ where: { id: { in: created.refunds } } })
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
  const po = async (key: string, taxRateId: string, posted: boolean, status: 'DRAFT' | 'CANCELLED' = 'DRAFT') => {
    const p = await db.purchaseOrder.create({
      data: {
        reference: `PO-RK${run}-${key}`, supplierId: supCy, status, currency: 'GBP', fxRateToBase: 1, ...money,
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
  const refund = async (key: string, orderId: string, taxType: string, posted: boolean) => {
    const r = await db.salesOrderRefund.create({
      data: { orderId, totalForeign: 10, totalBase: 10, accountingCreditNoteId: posted ? `cn-${run}-${key}` : null, lines: { create: [{ description: 'x', qty: 1, unitPriceBase: 10, totalBase: 10, accountingTaxType: taxType }] } },
      select: { id: true, lines: { select: { id: true } } },
    })
    created.refunds.push(r.id)
    return { id: r.id, lineId: r.lines[0]!.id }
  }
  const refundGrPending = await refund('gr-pending', soDraftGr.id, code('A'), false)
  const refundGrPosted = await refund('gr-posted', soDraftGr.id, code('A'), true)
  const poDraftBe = await po('be', ids.be, false)
  const poPostedCy = await po('posted-cy', ids.cy, true)
  const poCancelledCy = await po('cancelled-cy', ids.cy, false, 'CANCELLED')
  return { refundGrPending, refundGrPosted, ids, supCy, supGr, supBg, mapping: mapping.id, mappingBg: mappingBg.id, soPosted, soDraftCy, soDraftGr, soCancelled, poDraftBe, poPostedCy, poCancelledCy }
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
/** The apply started during a writer's transaction waits for its locks, then plans from the committed state: either it applies, or the digest no longer matches and it refuses having written nothing; the operator previews again. Consistency is what matters either way. */
async function applyThroughRace(d: Deps, digest: string): Promise<{ firstRefusal: string | null }> {
  const first = await d.rekey.runTaxRekey({ apply: true, confirm: digest, allowUnposted: true })
  if (first.wrote) return { firstRefusal: null }
  assert.equal(first.refusal?.code, 'DIGEST_MISMATCH', 'the only acceptable refusal of a race is the digest (nothing written)')
  const again = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(again.digest)
  const second = await d.rekey.runTaxRekey({ apply: true, confirm: again.digest, allowUnposted: true })
  assert.equal(second.wrote, true)
  return { firstRefusal: 'DIGEST_MISMATCH' }
}
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
  assert.equal(await attempt({ apply: true, confirm: preview.digest }), 'PENDING_REFUND_SNAPSHOTS', 'the right digest still refuses while an unposted refund line stores the old code')

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
  const frozen = async (id: string) => { const r = await db.taxRate.findUniqueOrThrow({ where: { id }, include: { components: { orderBy: { sortOrder: 'asc' } } } }); const rest: Record<string, unknown> = { ...r }; for (const k of ['active', 'isDefault', 'updatedAt', 'replacedById']) delete rest[k]; return JSON.stringify(rest) }
  const oldBefore = { cy: await frozen(w.ids.cy), gr: await frozen(w.ids.gr), be: await frozen(w.ids.be), bg: await frozen(w.ids.bg), amb: await frozen(w.ids.amb), pct: await frozen(w.ids.pct), nope: await frozen(w.ids.nope) }
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.deepEqual([preview.references[w.ids.gr]!.pendingRefunds, preview.references[w.ids.gr]!.pendingRefundLines, preview.references[w.ids.gr]!.refundSnapshotConflict], [1, 1, false])
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
  assert.deepEqual((await db.taxRate.findMany({ where: { id: { in: [w.ids.cy, w.ids.gr, w.ids.be] } }, select: { replacedById: true }, orderBy: { name: 'asc' } })).map((r) => r.replacedById), [fresh.find((r) => r.name === `${TAG}BE VAT`)!.id, fresh.find((r) => r.name === `${TAG}CY VAT`)!.id, fresh.find((r) => r.name === `${TAG}GR VAT`)!.id], 'each retired row points at its replacement')
  const newId = (name: string) => fresh.find((r) => r.name === `${TAG}${name}`)!.id

  // References: suppliers and mappings follow; the untouched rate's follow nothing.
  const sup = async (id: string) => (await db.supplier.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await sup(w.supCy), await sup(w.supGr), await sup(w.supBg)], [newId('CY VAT'), newId('GR VAT'), w.ids.bg])
  const map = async (id: string) => (await db.shoppingTaxRateMapping.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await map(w.mapping), await map(w.mappingBg)], [newId('CY VAT'), w.ids.bg])
  // Documents: EVERY not-cancelled one moved (posted ones can still be edited / re-sent / credited / billed again and would send the old code); the cancelled one is left alone.
  const soLine = async (id: string) => (await db.salesOrderLine.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await soLine(w.soPosted.lineId), await soLine(w.soCancelled.lineId), await soLine(w.soDraftCy.lineId), await soLine(w.soDraftGr.lineId)], [newId('CY VAT'), newId('CY VAT'), newId('CY VAT'), newId('GR VAT')])
  // CANCELLED documents (sales and purchase) follow without blocking; reopened afterwards, the line reads the LIVE code.
  const poCancelledLine = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: w.poCancelledCy.lineId }, include: { taxRate: true } })
  assert.deepEqual([poCancelledLine.taxRateId, poCancelledLine.taxRate?.accountingTaxType], [newId('CY VAT'), code('C')])
  assert.equal(result.written!.cancelledLinesRepointed, 2)
  await db.salesOrder.update({ where: { id: w.soCancelled.id }, data: { status: 'PROCESSING' } })
  const reopened = await db.salesOrderLine.findUniqueOrThrow({ where: { id: w.soCancelled.lineId }, include: { taxRate: true } })
  assert.equal(reopened.taxRate?.accountingTaxType, code('C'), 'a cancelled order reopened by a status sync posts the live code, not the retired one')
  const poLine = async (id: string) => (await db.purchaseOrderLine.findUniqueOrThrow({ where: { id } })).taxRateId
  assert.deepEqual([await poLine(w.poPostedCy.lineId), await poLine(w.poDraftBe.lineId)], [newId('CY VAT'), newId('BE VAT')])
  // Refund-line snapshots: the not-yet-posted refund's code is migrated (its identity is GR VAT alone); the posted credit note's is history and stays.
  const refundCode = async (id: string) => (await db.salesOrderRefundLine.findUniqueOrThrow({ where: { id } })).accountingTaxType
  assert.deepEqual([await refundCode(w.refundGrPending.lineId), await refundCode(w.refundGrPosted.lineId)], [code('D'), code('A')])
  assert.equal(result.written!.refundLinesRepointed, 1)
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
  await db.salesOrderRefund.update({ where: { id: w.refundGrPending.id }, data: { accountingCreditNoteId: `cn-${run}-late` } })
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
  assert.equal((await db.salesOrderLine.findUniqueOrThrow({ where: { id: w.soCancelled.lineId } })).taxRateId, (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}CY VAT`, active: true } })).id, 'a cancelled order follows too (it never blocks, and a status sync can reopen it)')
})

// [mutation: the refund-line migration removed from writeTaxRekey -> the main arm fails; mutation: the PENDING_REFUND_SNAPSHOTS refusal removed -> this arm applies without the flag]
test('a pending refund line that stores a code shared with a rate of another name is NEVER migrated (REFUND_SNAPSHOT_IDENTITY), flag or not; and a pending refund blocks without the flag', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const { db } = d
  // CY VAT's old code (PB) is also BG VAT's code: a stored "PB" on an unposted refund cannot be shown to mean CY VAT.
  const refund = await db.salesOrderRefund.create({ data: { orderId: w.soDraftCy.id, totalForeign: 10, totalBase: 10, lines: { create: [{ description: 'x', qty: 1, unitPriceBase: 10, totalBase: 10, accountingTaxType: code('B') }] } }, select: { id: true, lines: { select: { id: true } } } })
  created.refunds.push(refund.id)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const cy = preview.references[w.ids.cy]!
  assert.deepEqual([cy.pendingRefundLines, cy.refundSnapshotConflict], [1, true])
  const before = await ownedDigest(d, w)
  for (const allowUnposted of [false, true]) {
    const r = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted })
    assert.deepEqual([r.refusal?.code, r.wrote], ['REFUND_SNAPSHOT_IDENTITY', false])
  }
  assert.equal(await ownedDigest(d, w), before)
  assert.equal((await db.salesOrderRefundLine.findUniqueOrThrow({ where: { id: refund.lines[0]!.id } })).accountingTaxType, code('B'))
})

// [mutation: only `taxType` scanned in queuedCounts (the pre-R3 jsonpath) -> the shipping / discount arms apply with the payload queued]
test('a queued payload with the old code ONLY in shippingTaxType or discountTaxType blocks the apply, with no event mirror; a sent row, and a rate-sync row, do not', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const { db } = d
  const queuedFor = async () => (await d.rekey.runTaxRekey({ apply: false })).plan!
  const add = async (status: 'PENDING' | 'SYNCED', type: 'SALES_INVOICE' | 'TAX_RATE_SYNC', payload: unknown) => {
    const row = await db.accountingSyncLog.create({ data: { type, status, referenceType: 'SalesOrder', referenceId: w.soDraftCy.id, payload: payload as never } })
    created.logs.push(row.id)
    return row.id
  }
  assert.equal((await queuedFor()).references[w.ids.cy]!.queuedSyncRows, 0)
  await add('SYNCED', 'SALES_INVOICE', { lines: [], shippingTaxType: code('B') })
  await add('PENDING', 'TAX_RATE_SYNC', { name: 'x', components: [{ accountingTaxType: code('B') }] })
  assert.equal((await queuedFor()).references[w.ids.cy]!.queuedSyncRows, 0, 'a sent row and a rate-definition row are not queued uses of the code')
  const ship = await add('PENDING', 'SALES_INVOICE', { lines: [{ taxType: 'OUTPUT2' }], shippingTaxType: code('B') })
  let plan = await queuedFor()
  assert.equal(plan.references[w.ids.cy]!.queuedSyncRows, 1, 'old code only in shippingTaxType')
  const r1 = await d.rekey.runTaxRekey({ apply: true, confirm: plan.digest, allowUnposted: true })
  assert.deepEqual([r1.refusal?.code, r1.wrote], ['QUEUED_PAYLOADS', false])
  await db.accountingSyncLog.update({ where: { id: ship }, data: { status: 'SYNCED' } })
  await add('PENDING', 'SALES_INVOICE', { lines: [], discountTaxType: code('B') })
  plan = await queuedFor()
  assert.equal(plan.references[w.ids.cy]!.queuedSyncRows, 1, 'old code only in discountTaxType')
  const r2 = await d.rekey.runTaxRekey({ apply: true, confirm: plan.digest, allowUnposted: true })
  assert.deepEqual([r2.refusal?.code, r2.wrote], ['QUEUED_PAYLOADS', false])
})

// [mutation: the guard call removed from createAccountingSyncLogRow -> the refusal arm inserts the stale payload; mutation: the advisory lock removed from the guard -> the interleaving arm: the apply commits during the producer's pause]
test('THE ENQUEUE GUARD: after a re-key, a payload built from the old code is refused at the insert (named, with an inbox row); a producer that inserts first makes the apply see it and refuse', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { createAccountingSyncLogRow } = await import('../../lib/domain/accounting/sync-log-row.ts')
  const { RetiredTaxCodeInPayloadError } = await import('../../lib/tax/retired-tax-code-guard.ts')
  const { db } = d
  const w = await seedWorld(d)
  const insert = (client: unknown, payload: unknown) => createAccountingSyncLogRow(client as never, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: w.soDraftCy.id, payload: payload as never })

  // (1) build-before / enqueue-after: the payload carries BE VAT's old code, which the apply retires.
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  const done = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
  assert.equal(done.wrote, true)
  const before = await db.accountingSyncLog.count({ where: { referenceId: w.soDraftCy.id } })
  // BE VAT's old code OLD1 was retired. A payload that read it from the OLD row (bound to it) is refused, in any tax-code field, whenever it is enqueued.
  await assert.rejects(insert(db, { lines: [{ taxType: code('OLD1'), taxRateId: w.ids.be }] }), (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.codes.join() === code('OLD1') && e.reason === 'retired_tax_code')
  await assert.rejects(insert(db, { lines: [], shippingTaxType: code('OLD1'), shippingTaxRateId: w.ids.be }), RetiredTaxCodeInPayloadError, 'in any tax-code field')
  // A retired code with NO binding is refused as unbound.
  await assert.rejects(insert(db, { lines: [{ taxType: code('OLD1') }] }), (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.reason === 'retired_tax_code_unbound')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: w.soDraftCy.id } }), before, 'nothing was queued')
  const inbox = await db.accountingPostingRefusal.findFirst({ where: { type: 'SALES_INVOICE', referenceId: w.soDraftCy.id } })
  assert.ok(['retired_tax_code', 'retired_tax_code_unbound'].includes(inbox?.reason ?? ''), 'the refusal is in the posting-refusal inbox with a named reason')
  // Normal enqueues are unaffected: the live code, a built-in, a code no rate carries, and a payload with no tax code at all.
  for (const payload of [{ lines: [{ taxType: code('C') }] }, { lines: [{ taxType: 'OUTPUT2' }] }, { lines: [{ taxType: code('NOSUCHRATE') }] }, { lines: [] }]) {
    const ok = await insert(db, payload)
    assert.ok(ok.row, JSON.stringify(payload))
    created.logs.push(ok.row!.id)
  }

  // (1b) THE SWAP and CODEX'S SCENARIO: GR VAT's old code A is retired while BE VAT's NEW row carries it. A GR payload that read A from the OLD GR row, enqueued at ANY later time (no clock is consulted),
  // is refused; a payload built from the NEW BE row (bound to it) is admitted whenever it is enqueued; an unbound A is refused.
  const newBeRow = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}BE VAT`, active: true, NOT: { id: w.ids.be } } })).id
  await db.setting.update({ where: { key: 'tax_rekey_retired_codes' }, data: { value: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: 'tax_rekey_retired_codes' } })).value) as Record<string, { at: string }>).map(([k, v]) => [k, { ...v, at: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString() }]))) } })
  await assert.rejects(insert(db, { lines: [{ taxType: code('A'), taxRateId: w.ids.gr }] }), (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.reason === 'retired_tax_code', 'stale read of the old GR row, enqueued days later')
  assert.equal((await db.accountingPostingRefusal.findFirst({ where: { type: 'SALES_INVOICE', referenceId: w.soDraftCy.id } }))?.reason, 'retired_tax_code')
  await assert.rejects(insert(db, { lines: [{ taxType: code('A') }] }), (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.reason === 'retired_tax_code_unbound')
  await assert.rejects(insert(db, { lines: [{ taxType: code('A'), taxRateId: newBeRow }, { taxType: code('A'), taxRateId: w.ids.gr }] }), RetiredTaxCodeInPayloadError, 'ONE stale line among valid ones refuses the payload')
  await assert.rejects(insert(db, { lines: [{ taxType: code('A'), taxRateId: newBeRow }], discountTaxType: code('A') }), (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.reason === 'retired_tax_code_unbound', 'every occurrence needs its own binding')
  const fresh = await insert(db, { lines: [{ taxType: code('A'), taxRateId: newBeRow }], shippingTaxType: code('A'), shippingTaxRateId: newBeRow })
  assert.ok(fresh.row, 'a payload built from the new row is admitted, however long after the apply')
  created.logs.push(fresh.row!.id)
  await assert.rejects(insert(db, { lines: [{ taxType: code('A'), taxRateId: w.ids.cy }] }), RetiredTaxCodeInPayloadError, 'bound to a rate that does not carry the code')

  // (2) the interleaving: a producer INSERTS first (the code is not retired yet) and holds the lock to its commit; the apply started meanwhile must wait for it and then see the queued row.
  const w2 = await seedWorld(d)
  const preview2 = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const producer = db.$transaction(async (tx) => {
    const r = await createAccountingSyncLogRow(tx as never, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: w2.soDraftCy.id, payload: { lines: [{ taxType: code('OLD1') }] } as never })
    assert.ok(r.row)
    await new Promise((resolve) => setTimeout(resolve, 900))
    return r.row!.id
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const racing = await d.rekey.runTaxRekey({ apply: true, confirm: preview2.digest, allowUnposted: true })
  await producer
  assert.equal(racing.wrote, false, 'the apply did not commit past a producer that had already queued the old code')
  assert.ok(racing.refusal?.code === 'QUEUED_PAYLOADS' || racing.refusal?.code === 'DIGEST_MISMATCH', String(racing.refusal?.code))
  assert.equal((await db.taxRate.findUniqueOrThrow({ where: { id: w2.ids.be } })).active, true)
})

// [mutation: the hold check removed from runTaxRekey -> the not-held and live arms apply]
test('THE STRUCTURAL GUARANTEE: an apply is refused unless Xero writes are HELD (hold enforced for xero, no grant, no live-from instant); a preview is not', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const before = await ownedDigest(d, w)
  const rekey = await import('../../lib/tax/tax-rekey.ts')
  const envs: Array<[string, Record<string, string>]> = [
    ['not enforced', {}],
    ['enforced for another destination', { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }],
    ['destination live', { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: '11111111-2222-3333-4444-555555555555', XERO_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }],
    ['live-from without grant', { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }],
  ]
  for (const [label, producerEnv] of envs) {
    const r = await rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true, producerEnv })
    assert.deepEqual([r.refusal?.code, r.wrote], ['XERO_NOT_HELD', false], label)
    assert.equal(await ownedDigest(d, w), before, `${label}: nothing written`)
    const p = await rekey.runTaxRekey({ apply: false, producerEnv })
    assert.deepEqual([p.refusal, p.hold.held], [null, false], `${label}: a preview still works and says so`)
  }
  const held = await rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true, producerEnv: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' } })
  created.digests.push(preview.digest)
  assert.deepEqual([held.refusal, held.wrote], [null, true], 'control: the same call writes while held')
})

// [mutation: the meaning comparison reduced to name + percentage -> every variant but the identical one applies]
test('REFUND SNAPSHOT IDENTITY: ANY other carrier of the old code that differs in country, side, component breakdown, isCompound, reverseCharge or reportingCategory blocks the migration; an identical carrier does not', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { db } = d
  const variants: Array<[string, Record<string, unknown>, boolean]> = [
    ['identical inactive copy', {}, false],
    ['country', { countryCode: 'ZZ' }, true],
    ['side', { usedFor: 'PURCHASE' }, true],
    ['isCompound', { isCompound: true }, true],
    ['reverseCharge', { reverseCharge: true }, true],
    ['reportingCategory', { reportingCategory: 'OSS' }, true],
    ['component breakdown (same headline 24%)', { components: { create: [{ name: 'a', rate: '0.1000', sortOrder: 0 }, { name: 'b', rate: '0.1400', sortOrder: 1 }] } }, true],
  ]
  for (const [label, over, conflict] of variants) {
    const w = await seedWorld(d)
    // GR VAT (code A, unique in the world) has a pending refund line storing A. A historical INACTIVE rate also carries A.
    const twin = await db.taxRate.create({
      data: {
        name: `${TAG}GR VAT`, rate: '0.2400', usedFor: 'BOTH', accountingTaxType: code('A'), countryCode: null, reportingCategory: 'EC_SALES', isCompound: false, reverseCharge: false, active: false,
        components: { create: [{ name: 'VAT', rate: '0.2400', sortOrder: 0 }] }, ...over,
      } as never,
    })
    created.rates.push(twin.id)
    const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
    const gr = preview.references[w.ids.gr]!
    assert.deepEqual([gr.pendingRefundLines, gr.refundSnapshotConflict], [1, conflict], label)
    created.digests.push(preview.digest)
    const r = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
    if (conflict) assert.deepEqual([r.refusal?.code, r.wrote], ['REFUND_SNAPSHOT_IDENTITY', false], label)
    else {
      assert.deepEqual([r.refusal, r.wrote], [null, true], label)
      assert.equal((await db.salesOrderRefundLine.findUniqueOrThrow({ where: { id: w.refundGrPending.lineId } })).accountingTaxType, code('D'), 'control: an identical carrier lets the snapshot migrate')
    }
  }
})

// [mutation: replacedById not written by the apply -> the resolution arm rejects the old id; mutation: the helper's share lock removed -> the race arm: the apply commits past the writer and the document keeps the retired row]
test('WRITERS AFTER THE APPLY: a supplied id of a retired rate resolves to its replacement, a plainly inactive rate is refused, an edit keeps what it had; a document created DURING the apply is never left on the retired row', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { resolveLinesTaxRates, TaxRateNotUsableError } = await import('../../lib/tax/writable-tax-rate.ts')
  const { db } = d
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  assert.equal((await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })).wrote, true)
  const newGr = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}GR VAT`, active: true } })).id
  // The WooCommerce import builds its payload codes from the rate rows its lines are persisted with, read NOW (currentTaxRates): the retired GR row's id yields the live row and its live code.
  const { currentTaxRates } = await import('../../lib/tax/writable-tax-rate.ts')
  const nowRates = await currentTaxRates(db, [w.ids.gr, w.ids.cy, null])
  assert.deepEqual([nowRates.get(w.ids.gr)?.id, nowRates.get(w.ids.gr)?.accountingTaxType, nowRates.get(w.ids.cy)?.accountingTaxType], [newGr, code('D'), code('C')], 'a retired id reads as its replacement and the LIVE code')

  // A form opened before the apply submits the old id: a NEW order and a NEW purchase order created in a transaction end up on the replacement.
  const so = await db.$transaction(async (tx) => {
    const lines = [{ taxRateId: w.ids.gr, description: 'x', qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }]
    assert.equal(await resolveLinesTaxRates(tx, lines), 1)
    return tx.salesOrder.create({ data: { orderNumber: `RK${run}-after`, subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10, lines: { create: lines } }, select: { id: true, lines: { select: { taxRateId: true } } } })
  })
  created.orders.push(so.id)
  assert.equal(so.lines[0]!.taxRateId, newGr, 'SO created with the old id is on the replacement')
  const po = await db.$transaction(async (tx) => {
    const lines = [{ taxRateId: w.ids.gr, productId: w.poDraftBe.lineId ? (await db.product.findFirstOrThrow({ where: { sku: `RK${run}` } })).id : '', qty: 1, unitCostForeign: 10, unitCostBase: 10, totalForeign: 10, totalBase: 10 }]
    assert.equal(await resolveLinesTaxRates(tx, lines), 1)
    return tx.purchaseOrder.create({ data: { reference: `PO-RK${run}-after`, supplierId: w.supCy, status: 'DRAFT', currency: 'GBP', fxRateToBase: 1, subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10, lines: { create: lines } }, select: { id: true, lines: { select: { taxRateId: true } } } })
  })
  created.pos.push(po.id)
  assert.equal(po.lines[0]!.taxRateId, newGr, 'PO created with the old id is on the replacement')

  // A plainly inactive rate (an operator switched it off) is refused for a new record, kept on an edit, and let through for an inbound order.
  const plain = await db.taxRate.create({ data: { name: `${TAG}Plain off`, rate: '0.0500', usedFor: 'SALES', accountingTaxType: code('PLAIN'), active: false } })
  created.rates.push(plain.id)
  await assert.rejects(db.$transaction((tx) => resolveLinesTaxRates(tx, [{ taxRateId: plain.id }])), (e: unknown) => e instanceof TaxRateNotUsableError && e.code === 'TAX_RATE_INACTIVE')
  assert.equal(await db.$transaction((tx) => resolveLinesTaxRates(tx, [{ taxRateId: plain.id }], { keep: new Set([plain.id]) })), 0)
  assert.equal(await db.$transaction((tx) => resolveLinesTaxRates(tx, [{ taxRateId: plain.id }], { lenient: true })), 0)

  // THE RACE: a writer has locked the rate GR VAT (still active) and is about to commit a new order that references it; the apply started meanwhile must wait for the writer.
  const w2 = await seedWorld(d)
  await db.salesOrder.updateMany({ where: { id: { in: [w2.soDraftGr.id] } }, data: { status: 'CANCELLED' } })
  await db.salesOrderRefund.update({ where: { id: w2.refundGrPending.id }, data: { accountingCreditNoteId: `cn-${run}-race` } })
  const preview2 = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.deepEqual([preview2.references[w2.ids.gr]!.unpostedSalesOrders, preview2.references[w2.ids.gr]!.postedSalesOrders], [0, 0], 'no source for GR VAT yet')
  let lateOrder = ''
  const writer = db.$transaction(async (tx) => {
    const lines = [{ taxRateId: w2.ids.gr, description: 'x', qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }]
    await resolveLinesTaxRates(tx, lines) // GR VAT is active: kept, and now share-locked
    await new Promise((resolve) => setTimeout(resolve, 900))
    const o = await tx.salesOrder.create({ data: { orderNumber: `RK${run}-race`, subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10, lines: { create: lines } }, select: { id: true } })
    lateOrder = o.id
    created.orders.push(o.id)
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const racing = applyThroughRace(d, preview2.digest)
  await writer
  // The apply waited for the writer's commit (its row lock conflicts with the writer's share lock), then planned from / re-pointed the order the writer created; it is never left on the retired row.
  await racing
  const newGr2 = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}GR VAT`, active: true } })).id
  assert.equal((await db.salesOrderLine.findFirstOrThrow({ where: { orderId: lateOrder } })).taxRateId, newGr2, 'the order created during the apply is on the replacement')
  assert.equal((await db.taxRate.findUniqueOrThrow({ where: { id: w2.ids.gr } })).active, false)
})

// [mutation: the helper's share lock removed -> the apply commits during the writer's pause and the supplier keeps the retired rate]
test('A SUPPLIER WRITE concurrent with the apply ends on the new rate (the apply waits for the writer\'s share lock, then re-points)', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { resolveWritableTaxRateId } = await import('../../lib/tax/writable-tax-rate.ts')
  const { db } = d
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  const supplier = await db.supplier.create({ data: { name: `${TAG}Racing supplier` } })
  created.suppliers.push(supplier.id)
  // The supplier action's shape: resolve in the writing transaction (share lock held to commit), pause, write.
  const supplierWrite = db.$transaction(async (tx) => {
    const writable = await resolveWritableTaxRateId(tx, w.ids.gr)
    await new Promise((resolve) => setTimeout(resolve, 900))
    await tx.supplier.update({ where: { id: supplier.id }, data: { taxRateId: writable } })
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const applied = applyThroughRace(d, preview.digest)
  await supplierWrite
  await applied
  const newGr = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}GR VAT`, active: true } })).id
  assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).taxRateId, newGr, 'the supplier written during the apply ends on the new rate')
})

// [mutation: the post-deactivation recount of refund snapshots removed -> the snapshot keeps the old code]
test('A REFUND created concurrently with the apply ends with its snapshot on the new code (the apply waits for the refund\'s share lock, recounts, migrates)', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { shareLockOrderTaxRates } = await import('../../lib/tax/writable-tax-rate.ts')
  const { db } = d
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)
  // The refund's shape (refund-service.ts): share-lock the order lines' rate rows, read the code, pause, insert the snapshot of the code it read.
  const refundWrite = db.$transaction(async (tx) => {
    await shareLockOrderTaxRates(tx, w.soDraftGr.id) // the very statement the refund service runs before it reads the identity
    const read = (await tx.salesOrderLine.findFirstOrThrow({ where: { orderId: w.soDraftGr.id }, select: { taxRate: { select: { accountingTaxType: true } } } })).taxRate?.accountingTaxType ?? null
    await new Promise((resolve) => setTimeout(resolve, 900))
    const r = await tx.salesOrderRefund.create({ data: { orderId: w.soDraftGr.id, totalForeign: 10, totalBase: 10, lines: { create: [{ description: 'x', qty: 1, unitPriceBase: 10, totalBase: 10, accountingTaxType: read }] } }, select: { id: true, lines: { select: { id: true } } } })
    created.refunds.push(r.id)
    return { lineId: r.lines[0]!.id, read }
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const applied = applyThroughRace(d, preview.digest)
  const refund = await refundWrite
  await applied
  assert.equal(refund.read, code('A'), 'the refund read GR VAT\'s old code before the apply committed')
  assert.equal((await db.salesOrderRefundLine.findUniqueOrThrow({ where: { id: refund.lineId } })).accountingTaxType, code('D'), 'the refund snapshot committed during the apply was migrated to the new code')
})

// [mutation: the editor lock removed -> the race arm: the apply plans from the pre-edit row and the edit lands unlocked; mutation: the apply's FOR NO KEY UPDATE locks removed -> the arm gets DOCUMENT_CREATED_DURING_APPLY (the post-deactivation backstop) instead of the digest refusal]
test('AN EDITOR changing a rate concurrently with the apply: the apply refuses on the digest (nothing copied from a row being edited); a replaced row is read-only afterwards', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const { lockTaxRateForEdit, TaxRateReplacedError } = await import('../../lib/tax/tax-rate-replaced.ts')
  const { resolveWritableTaxRateId } = await import('../../lib/tax/writable-tax-rate.ts')
  const { createAccountingSyncLogRow } = await import('../../lib/domain/accounting/sync-log-row.ts')
  const { RetiredTaxCodeInPayloadError } = await import('../../lib/tax/retired-tax-code-guard.ts')
  const { db } = d
  const w = await seedWorld(d)
  const preview = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(preview.digest)

  // The editor's shape (updateTaxRate): lock the row first, pause, change CY VAT 19% -> 20% (the rate and its component), commit.
  const edit = db.$transaction(async (tx) => {
    await lockTaxRateForEdit(tx, w.ids.cy, { rate: 0.2 })
    await new Promise((resolve) => setTimeout(resolve, 900))
    await tx.taxRate.update({ where: { id: w.ids.cy }, data: { rate: '0.2000' } })
    await tx.taxRateComponent.updateMany({ where: { taxRateId: w.ids.cy }, data: { rate: '0.2000' } })
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const before = await d.rekey.runTaxRekey({ apply: true, confirm: preview.digest, allowUnposted: true })
  await edit
  assert.deepEqual([before.refusal?.code, before.wrote], ['DIGEST_MISMATCH', false], 'the apply waited for the editor, planned from the edited row and refused: no replacement was built from a row being edited')
  assert.equal((await db.taxRate.count({ where: { name: `${TAG}CY VAT`, active: true } })), 1, 'no replacement exists')

  // The next preview shows 20% against live 19%: PERCENTAGE_DIFFERS, nothing re-keyed for CY VAT.
  const replan = (await d.rekey.runTaxRekey({ apply: false })).plan!
  assert.equal(replan.rows.find((r) => r.imsRateId === w.ids.cy)!.outcome, 'PERCENTAGE_DIFFERS')

  // Put CY VAT back and apply for real.
  await db.taxRate.update({ where: { id: w.ids.cy }, data: { rate: '0.1900' } })
  await db.taxRateComponent.updateMany({ where: { taxRateId: w.ids.cy }, data: { rate: '0.1900' } })
  const p2 = (await d.rekey.runTaxRekey({ apply: false })).plan!
  created.digests.push(p2.digest)
  assert.equal((await d.rekey.runTaxRekey({ apply: true, confirm: p2.digest, allowUnposted: true })).wrote, true)

  // A replaced row is read-only: reactivating it, or changing its code / percentage / components, is refused; switching it off is not.
  for (const edit2 of [{ active: true }, { rate: 0.2 }, { accountingTaxType: 'TAX005' }, { components: [] }]) {
    await assert.rejects(db.$transaction((tx) => lockTaxRateForEdit(tx, w.ids.cy, edit2)), TaxRateReplacedError, JSON.stringify(edit2))
  }
  await db.$transaction((tx) => lockTaxRateForEdit(tx, w.ids.cy, { active: false }))

  // Even if something bypassed the editor and reactivated BE VAT's old row, it neither counts as a carrier of its old code nor is used by a writer.
  const newBe = (await db.taxRate.findFirstOrThrow({ where: { name: `${TAG}BE VAT`, active: true, NOT: { id: w.ids.be } } })).id
  await db.taxRate.update({ where: { id: w.ids.be }, data: { active: true } })
  await assert.rejects(
    createAccountingSyncLogRow(db as never, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: w.soDraftCy.id, payload: { lines: [{ taxType: code('OLD1'), taxRateId: w.ids.be }] } as never }),
    (e: unknown) => e instanceof RetiredTaxCodeInPayloadError && e.reason === 'retired_tax_code',
    'the reactivated retired row does not make its old code legitimate',
  )
  assert.equal(await resolveWritableTaxRateId(db, w.ids.be), newBe, 'a writer resolves the reactivated retired row to its replacement')
})

// [mutation: the report-type comparison removed -> the apply re-keys CY VAT to a live type that files to another box]
test('REPORT TYPE against a real stored list: a live type that files to another VAT-return box than IMS assigns is not re-keyed', { skip }, async () => {
  const d = await loadDeps()
  await precondition(d)
  const w = await seedWorld(d)
  const rows = LIVE().map((r) => (r.name === `${TAG}CY VAT` ? { ...r, reportTaxType: 'OUTPUT' } : r))
  await seedXero(d, rows)
  const plan = (await d.rekey.runTaxRekey({ apply: false })).plan!
  const cy = plan.rows.find((r) => r.imsRateId === w.ids.cy)!
  assert.deepEqual([cy.outcome, cy.reportType], ['REPORT_TYPE_DIFFERS', { expected: 'ECOUTPUTSERVICES', live: 'OUTPUT' }])
  assert.equal(plan.rows.find((r) => r.imsRateId === w.ids.gr)!.outcome, 'REKEY', 'control: the others still re-key')
})
