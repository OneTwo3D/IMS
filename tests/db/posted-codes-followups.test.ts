import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * POSTED-CODE REFUNDS, THE FOLLOW-UPS, against a real Postgres: a rate the record gives two codes is refused; an old code later mapped to a rate of another percentage is refused by the per-leg check; an unpriceable
 * posted code is refused; reverse charge end to end; the retry fence and the shared building blocks of the credit-note builder, the inbox and the manual park on a remapped order; the walk's id tiebreak and payload arm;
 * an unremapped refund is byte-identical with and without the record; and the retired-code guard still wins after a re-key (pinned, not changed). Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/posted-codes-followups.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { createSalesOrderRefund, fenceRetryPostedTax } = await import('../../lib/domain/sales/refund-service')
  const posted = await import('../../lib/domain/sales/posted-invoice-tax-codes')
  return { db, Prisma, createSalesOrderRefund, fenceRetryPostedTax, posted }
}

async function makeWorld(t: { after: (fn: () => Promise<void>) => void }) {
  const { db, Prisma, createSalesOrderRefund, fenceRetryPostedTax, posted } = await load()
  const sfx = randomUUID().slice(0, 8)
  const D = (v: string) => new Prisma.Decimal(v)
  const orderIds: string[] = []
  const rateIds: string[] = []
  t.after(async () => {
    for (const id of orderIds) {
      await db.activityLog.deleteMany({ where: { entityType: 'SALES_ORDER', entityId: id } }).catch(() => {})
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: id } }).catch(() => {})
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: id } } }).catch(() => {})
      await db.salesOrderRefund.deleteMany({ where: { orderId: id } }).catch(() => {})
      await db.salesOrderLine.deleteMany({ where: { orderId: id } }).catch(() => {})
      await db.salesOrder.delete({ where: { id } }).catch(() => {})
    }
    await db.setting.deleteMany({ where: { key: { in: ['tax_rekey_retired_codes'] } } }).catch(() => {})
    await db.taxRate.deleteMany({ where: { id: { in: rateIds } } }).catch(() => {})
  })
  const mkRate = async (key: string, rate: string, code: string | null, extra: Record<string, unknown> = {}) => {
    const r = await db.taxRate.create({ data: { name: `PF-${key}-${sfx}`, rate, accountingTaxType: code, countryCode: 'ZZ', ...extra } as never, select: { id: true, name: true } })
    rateIds.push(r.id)
    return r
  }
  /** An order of one 100 line per rate (tax at the rate), the first rate its default; an optional posted SYNCED invoice row with the given payload lines. */
  const mkOrder = async (opts: { rates: Array<{ id: string; name: string; pct: string }>; posted?: Record<string, unknown> | null; shipping?: boolean; discount?: boolean; totalBase?: string }) => {
    const first = opts.rates[0]!
    const tax = opts.rates.reduce((s, r) => s + 100 * Number(r.pct), 0)
    const total = 100 * opts.rates.length + tax
    const o = await db.salesOrder.create({
      data: {
        orderNumber: `PF-${randomUUID().slice(0, 8)}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: D('1'), pricesIncludeVat: false, taxRateName: first.name, taxRatePercent: D(first.pct),
        subtotalForeign: D(String(100 * opts.rates.length)), subtotalBase: D(String(100 * opts.rates.length)), taxForeign: D(String(tax)), taxBase: D(String(tax)), totalForeign: D(String(total)), totalBase: D(String(total)),
        accountingInvoiceId: opts.posted === undefined ? undefined : `inv-${randomUUID()}`, accountingInvoiceConnector: opts.posted === undefined ? undefined : 'xero',
        lines: { create: opts.rates.map((r) => ({ description: `goods ${r.id.slice(-4)}`, qty: D('1'), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D(String(100 * Number(r.pct))), taxBase: D(String(100 * Number(r.pct))), totalForeign: D('100'), totalBase: D('100'), taxRateId: r.id })) },
      },
      select: { id: true, accountingInvoiceId: true, lines: { select: { id: true, taxRateId: true } } },
    })
    orderIds.push(o.id)
    if (opts.posted) {
      await db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: o.id, externalTransactionId: o.accountingInvoiceId, syncedAt: new Date(), payload: opts.posted } as never })
    }
    return o
  }
  const postedLine = (rate: { id: string }, code: string) => ({ description: 'l', quantity: 1, unitAmount: 100, taxType: code, taxRateId: rate.id, taxRateBasis: 'sales_line' })
  const refund = (o: { id: string; lines: { id: string; taxRateId: string | null }[] }, rateId: string, extra: Record<string, unknown> = {}) => createSalesOrderRefund(db, {
    orderId: o.id,
    lines: [{ lineId: o.lines.find((l) => l.taxRateId === rateId)!.id, productId: null, description: 'l', qty: 1, totalForeign: 99, totalBase: 99, lineKind: 'sale' }] as never,
    reason: 'pf', creditNotePrefix: `CNPF${sfx}-`, enforcePerTargetBalances: true, deriveSaleLineNetsFromStoredBalance: true, creditNotePostingEnabled: true, ...extra,
  })
  const codesOf = async (orderId: string) => (await db.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, select: { lineKind: true, accountingTaxType: true } })).map((r) => [r.lineKind, r.accountingTaxType])
  return { db, Prisma, D, sfx, createSalesOrderRefund, fenceRetryPostedTax, posted, mkRate, mkOrder, postedLine, refund, codesOf, orderIds }
}

test('[db] a rate the posted record gives two codes is refused; unchanged others still refund', { skip }, async (t) => {
  const w = await makeWorld(t)
  const a = await w.mkRate('A', '0.2', `AOLD-${w.sfx}`)
  const b = await w.mkRate('B', '0.05', `BOLD-${w.sfx}`)
  const o = await w.mkOrder({ rates: [{ ...a, pct: '0.2' }, { ...b, pct: '0.05' }], posted: { lines: [w.postedLine(a, `AOLD-${w.sfx}`), w.postedLine(b, `BOLD-${w.sfx}`), w.postedLine(b, `BOTHER-${w.sfx}`)] } })
  const refused = await w.refund(o, b.id)
  assert.equal(refused.success, false)
  assert.match(refused.success ? '' : refused.error, /two different tax codes/)
  const fine = await w.refund(o, a.id)
  assert.equal(fine.success, true, fine.success ? '' : fine.error)
})

test('[db] an old code later mapped to a rate of another percentage: the per-leg check refuses (no guess at either rate)', { skip }, async (t) => {
  const w = await makeWorld(t)
  const b = await w.mkRate('B', '0.05', `BOLD-${w.sfx}`)
  const c = await w.mkRate('C', '0.2', `COTHER-${w.sfx}`)
  const o = await w.mkOrder({ rates: [{ ...b, pct: '0.05' }], posted: { lines: [w.postedLine(b, `BOLD-${w.sfx}`)] } })
  // Rate B is remapped away and ANOTHER rate (20%) takes its old code.
  await w.db.taxRate.update({ where: { id: b.id }, data: { accountingTaxType: `BNEW-${w.sfx}` } })
  await w.db.taxRate.update({ where: { id: c.id }, data: { accountingTaxType: `BOLD-${w.sfx}` } })
  const r = await w.refund(o, b.id)
  assert.equal(r.success, false, 'the posted code now maps to a 20% rate as well as the 5% it was posted at')
  assert.match(r.success ? '' : r.error, /more than one rate|ambiguous|posts under/i)
})

test('[db] a posted code whose rate row is gone cannot be priced: refused, not read as 0%', { skip }, async (t) => {
  const w = await makeWorld(t)
  const a = await w.mkRate('A', '0.2', `AOLD-${w.sfx}`)
  const ghost = await w.mkRate('G', '0.05', `GOLD-${w.sfx}`)
  const o = await w.mkOrder({ rates: [{ ...a, pct: '0.2' }], posted: { lines: [{ ...w.postedLine(ghost, `GOLD-${w.sfx}`) }, w.postedLine(a, `AOLD-${w.sfx}`)] } })
  // The line now points at the ghost's code in the record only; remove the ghost rate so its posted code has no rate to price from.
  await w.db.salesOrderLine.updateMany({ where: { orderId: o.id }, data: { taxRateId: ghost.id } })
  await w.db.taxRate.update({ where: { id: ghost.id }, data: { accountingTaxType: `GNEW-${w.sfx}` } })
  const rec = await w.posted.readPostedInvoiceRecord(w.db, o.id, o.accountingInvoiceId)
  assert.ok(rec.codes, 'the record reads')
  // Drop the pair that prices the code (as when the bound rate is deleted), leaving the code unmapped anywhere.
  const stripped = { ...rec.codes!, ratesByCode: new Map() }
  const index = w.posted.withPostedCodeRates(new Map(), stripped)
  assert.equal(index.get(`GOLD-${w.sfx}`), undefined, 'no rate prices the posted code')
  const { priceSnapshottedTaxIdentity } = await import('../../lib/domain/sales/refund-posted-tax-identity')
  const priced = priceSnapshottedTaxIdentity({ accountingTaxType: `GOLD-${w.sfx}`, rateByTaxType: index, label: 'refund line' })
  assert.equal(priced.ok, false, 'an unpriceable posted code is refused, never priced at 0%')
})

test('[db] reverse charge end to end: goods on the posted swap code after the RC rate is remapped, flagged reverse-charged', { skip }, async (t) => {
  const w = await makeWorld(t)
  const swap = `RCSWAP-${w.sfx}`
  const zero = await w.mkRate('Z', '0', swap)
  const rc = await w.mkRate('RC', '0.2', `RCOLD-${w.sfx}`, { reverseCharge: true })
  const o = await w.mkOrder({ rates: [{ ...rc, pct: '0' }], posted: { lines: [w.postedLine(rc, swap)] } })
  await w.db.taxRate.update({ where: { id: rc.id }, data: { accountingTaxType: `RCNEW-${w.sfx}` } })
  const r = await w.refund(o, rc.id, { accountingSettings: { reverseChargeSalesTaxType: swap } as never })
  assert.equal(r.success, true, r.success ? '' : r.error)
  const row = await w.db.salesOrderRefundLine.findFirst({ where: { refund: { orderId: o.id } }, select: { accountingTaxType: true, reverseCharge: true } })
  assert.equal(row?.accountingTaxType, swap)
  assert.equal(row?.reverseCharge, true)
  void zero
})

test('[db] the retry fence prices a snapshotted posted code on a remapped order, and the credit-note building blocks (resolver, identity) read the posted code', { skip }, async (t) => {
  const w = await makeWorld(t)
  const b = await w.mkRate('B', '0.05', `BOLD-${w.sfx}`)
  const o = await w.mkOrder({ rates: [{ ...b, pct: '0.05' }], posted: { lines: [w.postedLine(b, `BOLD-${w.sfx}`)], shippingTaxType: `BOLD-${w.sfx}`, shippingTaxRateId: b.id, shippingTaxRateBasis: 'plain' } })
  await w.db.taxRate.update({ where: { id: b.id }, data: { accountingTaxType: `BNEW-${w.sfx}` } })
  const r = await w.refund(o, b.id)
  assert.equal(r.success, true, r.success ? '' : r.error)
  const rows = await w.db.salesOrderRefundLine.findMany({ where: { refund: { orderId: o.id } }, select: { id: true, salesOrderLineId: true, productId: true, description: true, qty: true, unitPriceForeign: true, unitPriceBase: true, totalForeign: true, totalBase: true, lineKind: true, accountingTaxType: true, reverseCharge: true } })
  assert.deepEqual(rows.map((x) => x.accountingTaxType), [`BOLD-${w.sfx}`], 'the snapshot is the posted code')
  const full = await w.db.salesOrder.findUniqueOrThrow({ where: { id: o.id }, select: { currency: true, taxForeign: true, shippingForeign: true, discountAmount: true, taxRateName: true, accountingInvoiceId: true, shoppingLinks: { select: { connector: true } }, lines: { select: { id: true, totalForeign: true, taxForeign: true, taxRateId: true, taxRate: { select: { accountingTaxType: true, reverseCharge: true } } } } } })
  const created = rows.map((x) => ({ id: x.id, lineId: x.salesOrderLineId, productId: x.productId, description: x.description, qty: Number(x.qty), unitPriceForeign: Number(x.unitPriceForeign), unitPriceBase: Number(x.unitPriceBase), totalForeign: Number(x.totalForeign), totalBase: Number(x.totalBase), lineKind: x.lineKind as 'sale', accountingTaxType: x.accountingTaxType, reverseCharge: x.reverseCharge }))
  assert.equal(await w.fenceRetryPostedTax(w.db as never, o.id, full as never, created, false, null), null, 'the retry fence passes: the posted code is priced at the rate it was posted at')
  // The shared building blocks the credit-note builder, the inbox and the manual park read.
  const rec = await w.posted.readPostedInvoiceTaxCodes(w.db, o.id, o.accountingInvoiceId)
  const { creditNoteLineTaxTypeResolver, resolvePostedRefundTaxIdentity, buildTaxTypeRateIndex } = await import('../../lib/domain/sales/refund-posted-tax-identity')
  const resolve = creditNoteLineTaxTypeResolver({ orderLines: full.lines, orderDefaultTaxType: `BNEW-${w.sfx}`, postedTaxTypeByLineId: w.posted.postedTaxTypeByLineId(full.lines, rec), shippingTaxType: w.posted.postedShippingTaxType(rec), headerDiscountTaxType: w.posted.postedHeaderDiscountTaxType(rec) })
  assert.equal(resolve({ lineId: o.lines[0]!.id }), `BOLD-${w.sfx}`)
  assert.equal(resolve({ lineKind: 'shipping' }), `BOLD-${w.sfx}`, 'a no-snapshot shipping line takes the posted shipping code')
  assert.equal(resolve({ lineKind: 'sale' }), `BNEW-${w.sfx}`, 'any other line takes the current default, not the shipping code')
  const identity = resolvePostedRefundTaxIdentity({ kind: 'sale', lineTaxRate: full.lines[0]!.taxRate, postedTaxType: w.posted.postedLineTaxType(rec, b.id), chargedLine: { currency: 'GBP', netForeign: 100, taxForeign: 5 }, orderDefaultTaxType: `BNEW-${w.sfx}`, rateByTaxType: w.posted.withPostedCodeRates(buildTaxTypeRateIndex([{ accountingTaxType: `BNEW-${w.sfx}`, rate: '0.05' }]), rec), label: 'l' })
  assert.ok(identity.ok && identity.accountingTaxType === `BOLD-${w.sfx}`, 'the inbox / manual park identity is the posted code, priced at its rate')
})

test('[db] the walk: a payload-arm update row wins the same-createdAt tiebreak by id, and the other order flips it', { skip }, async (t) => {
  const w = await makeWorld(t)
  const b = await w.mkRate('B', '0.05', `BCUR-${w.sfx}`)
  const o = await w.mkOrder({ rates: [{ ...b, pct: '0.05' }], posted: { lines: [w.postedLine(b, 'V1')] } })
  const at = new Date('2026-11-01T10:00:00Z')
  const rowFor = (id: string, code: string, extra: Record<string, unknown>) => w.db.accountingSyncLog.create({ data: { id, connector: 'xero', referenceType: 'SalesOrder', referenceId: o.id, status: 'SYNCED', syncedAt: at, createdAt: at, payload: { accountingInvoiceId: o.accountingInvoiceId, lines: [w.postedLine(b, code)] }, ...extra } as never })
  await w.db.accountingSyncLog.updateMany({ where: { referenceId: o.id }, data: { createdAt: at } })
  const codeOf = async () => (await w.posted.readPostedInvoiceTaxCodes(w.db, o.id, o.accountingInvoiceId))?.lineCodeByRateId.get(b.id)
  // Same createdAt: the update names the document only in its payload (no external id); its id sorts AFTER the create's, so it is the newest.
  await rowFor(`zz-${w.sfx}`, 'V2', { type: 'SALES_INVOICE_UPDATE' })
  assert.equal(await codeOf(), 'V2')
  // Flip: an update whose id sorts BEFORE the create's loses the tiebreak, so the create (V1) is the newest.
  await w.db.accountingSyncLog.delete({ where: { id: `zz-${w.sfx}` } })
  await rowFor(`00-${w.sfx}`, 'V3', { type: 'SALES_INVOICE_UPDATE' })
  assert.equal(await codeOf(), 'V1')
})

test('[db] an unremapped refund is byte-identical with and without the posted record', { skip }, async (t) => {
  const w = await makeWorld(t)
  const a = await w.mkRate('A', '0.2', `ACUR-${w.sfx}`)
  const b = await w.mkRate('B', '0.05', `BCUR-${w.sfx}`)
  const rates = [{ ...a, pct: '0.2' }, { ...b, pct: '0.05' }]
  const withRecord = await w.mkOrder({ rates, posted: { lines: [w.postedLine(a, `ACUR-${w.sfx}`), w.postedLine(b, `BCUR-${w.sfx}`)] } })
  const without = await w.mkOrder({ rates })
  const withRefund = await w.refund(withRecord, b.id)
  const withoutRefund = await w.refund(without, b.id)
  assert.equal(withRefund.success, true, withRefund.success ? '' : withRefund.error)
  assert.equal(withoutRefund.success, true, withoutRefund.success ? '' : withoutRefund.error)
  const shape = async (orderId: string) => JSON.stringify((await w.db.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, orderBy: { description: 'asc' }, select: { description: true, qty: true, totalForeign: true, totalBase: true, lineKind: true, accountingTaxType: true, reverseCharge: true, postedTaxRate: true, discountTaxRateId: true } })).map((r) => ({ ...r, description: r.description.replace(/\w{4}$/, 'xxxx') })))
  assert.equal(await shape(withRecord.id), await shape(without.id), 'the same refund lines, codes and rates')
})

test('[db] after a tax re-key the retired-code guard still wins over a posted code (pinned, not changed): the credit note carrying the retired posted code is refused; a plain remap is not', { skip }, async (t) => {
  const w = await makeWorld(t)
  const { retiredTaxCodesInPayload } = await import('../../lib/tax/retired-tax-code-guard')
  const rate = await w.mkRate('K', '0.2', 'TAX002')
  const creditNote = (code: string) => ({ lines: [{ taxType: code, taxRateId: rate.id, taxRateBasis: 'sales_line' }] })
  // A plain in-place remap retires nothing: the credit note on the old (posted) code is not looked at by the guard.
  assert.deepEqual(await w.db.$transaction((tx) => retiredTaxCodesInPayload(tx, { type: 'CREDIT_NOTE', payload: creditNote('TAX001') })), [])
  // A re-key retired TAX001 (the rate now carries TAX002): the same posted code on a credit note is refused, whatever the invoice was posted with.
  await w.db.setting.upsert({ where: { key: 'tax_rekey_retired_codes' }, create: { key: 'tax_rekey_retired_codes', value: JSON.stringify({ TAX001: { rateId: rate.id, newCode: 'TAX002', at: new Date().toISOString() } }) }, update: { value: JSON.stringify({ TAX001: { rateId: rate.id, newCode: 'TAX002', at: new Date().toISOString() } }) } })
  const findings = await w.db.$transaction((tx) => retiredTaxCodesInPayload(tx, { type: 'CREDIT_NOTE', payload: creditNote('TAX001') }))
  assert.deepEqual(findings.map((f) => [f.code, f.reason]), [['TAX001', 'retired_tax_code']])
})
