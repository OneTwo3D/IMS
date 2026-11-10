import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import type { EuVatRegimeInput } from '../../lib/domain/accounting/eu-vat-regime'

/**
 * THE EU VAT REGIME STAMP AGAINST A REAL DATABASE (committing, with its own cleanup): decided once, written once, never re-derived.
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/eu-vat-regime-stamp.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const stamp = await import('../../lib/domain/accounting/eu-vat-regime-stamp')
  return { db, ...stamp }
}

async function seedOrder(db: Awaited<ReturnType<typeof setup>>['db']): Promise<string> {
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `EUVAT-${randomUUID().slice(0, 8)}`, status: 'DRAFT', currency: 'EUR', fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'), totalForeign: new Prisma.Decimal('119'), subtotalBase: new Prisma.Decimal('100'), taxBase: new Prisma.Decimal('19'), totalBase: new Prisma.Decimal('119'),
    },
    select: { id: true },
  })
  return order.id
}

function input(goods: string, over: Partial<EuVatRegimeInput> = {}): EuVatRegimeInput {
  return {
    mode: 'decide', pluginFx: { state: 'absent' }, pluginFxConflict: false,
    shippingCountry: 'DE', billingCountry: 'DE', currency: 'EUR', goodsLines: [{ total: goods, voucher: 'no' }],
    rates: [{ wooRateId: 216, tax: '19.00', mapping: { state: 'mapped', imsRateId: 'r', name: 'DE VAT', active: true, countryCode: 'DE', rate: '0.19', reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' } }],
    orderTax: '19.00', vatExempt: 'no', vatRecord: { state: 'absent' }, eas: { state: 'absent' },
    thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T00:00:00.000Z', source: 'same currency' },
    accounts: { ioss: '821', ddp: '232' }, pluginVatAccount: null, overThresholdDutyFee: false, ...over,
  }
}

const NOW = new Date('2026-11-01T10:00:00.000Z')

test('a scheme decision is written once: regime, account, marker and basis', { skip }, async () => {
  const { db, stampEuVatRegime, readEuVatRegimeStamp } = await setup()
  const id = await seedOrder(db)
  try {
    assert.equal(await readEuVatRegimeStamp(db, id), null)
    const outcome = await db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('100.00'), NOW))
    assert.equal(outcome.kind, 'stamped')
    assert.deepEqual(outcome.kind === 'stamped' && outcome.stamp, { regime: 'IOSS', vatAccount: '821', stampedAt: NOW })
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true, euVatRegimeBasis: true } })
    assert.equal(row.euVatRegime, 'IOSS')
    assert.equal(row.euVatLineAccount, '821')
    assert.deepEqual(row.euVatRegimeStampedAt, NOW)
    const basis = row.euVatRegimeBasis as { version: number; outcome: string; scheme: { convertedValue: string; vatTotal: string }; warnings: unknown[] }
    assert.equal(basis.version, 1)
    assert.equal(basis.outcome, 'SCHEME')
    assert.equal(basis.scheme.convertedValue, '100.00')
    assert.equal(basis.scheme.vatTotal, '19')
    assert.deepEqual(await readEuVatRegimeStamp(db, id), { regime: 'IOSS', vatAccount: '821', stampedAt: NOW })
  } finally {
    await db.salesOrder.delete({ where: { id } })
  }
})

test('a stamped order is never re-derived: a later rate that would choose DDP changes nothing, and the facts are not even gathered', { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const id = await seedOrder(db)
  try {
    await db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('149.00'), NOW))
    let gathered = 0
    const later = await db.$transaction((tx) => stampEuVatRegime(tx, id, () => { gathered += 1; return input('151.00') }, new Date('2026-11-09T00:00:00.000Z')))
    assert.equal(gathered, 0)
    assert.equal(later.kind, 'already_stamped')
    assert.deepEqual(later.kind === 'already_stamped' && later.stamp, { regime: 'IOSS', vatAccount: '821', stampedAt: NOW })
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true } })
    assert.deepEqual([row.euVatRegime, row.euVatLineAccount, row.euVatRegimeStampedAt], ['IOSS', '821', NOW])
  } finally {
    await db.salesOrder.delete({ where: { id } })
  }
})

test('DDP is stamped on its own account; a decision outside the scheme stamps the marker with no regime and no account', { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const ddp = await seedOrder(db)
  const skipped = await seedOrder(db)
  try {
    const a = await db.$transaction((tx) => stampEuVatRegime(tx, ddp, () => input('200.00'), NOW))
    assert.deepEqual(a.kind === 'stamped' && a.stamp, { regime: 'DDP', vatAccount: '232', stampedAt: NOW })
    const b = await db.$transaction((tx) => stampEuVatRegime(tx, skipped, () => input('0', { shippingCountry: 'US', billingCountry: 'US', rates: [], orderTax: '0' }), NOW))
    assert.equal(b.kind, 'stamped')
    assert.equal(b.kind === 'stamped' && b.skipReason, 'no_scheme_vat')
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: skipped }, select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true, euVatRegimeBasis: true } })
    assert.deepEqual([row.euVatRegime, row.euVatLineAccount, row.euVatRegimeStampedAt], [null, null, NOW])
    assert.equal((row.euVatRegimeBasis as { outcome: string }).outcome, 'SKIP')
  } finally {
    await db.salesOrder.deleteMany({ where: { id: { in: [ddp, skipped] } } })
  }
})

test('a refusal stamps nothing, and the order is decided afresh once what it lacked is supplied', { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const id = await seedOrder(db)
  try {
    const refused = await db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('100.00', { thresholdFx: { state: 'unavailable', reason: 'no rate' } }), NOW))
    assert.equal(refused.kind, 'refused')
    assert.equal(refused.kind === 'refused' && refused.code, 'threshold_value_unavailable')
    const untouched = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true, euVatRegimeBasis: true } })
    assert.deepEqual([untouched.euVatRegime, untouched.euVatLineAccount, untouched.euVatRegimeStampedAt, untouched.euVatRegimeBasis], [null, null, null, null])
    const ok = await db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('100.00'), NOW))
    assert.equal(ok.kind, 'stamped')
  } finally {
    await db.salesOrder.delete({ where: { id } })
  }
})

test('an unknown order is reported, not created', { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const outcome = await db.$transaction((tx) => stampEuVatRegime(tx, 'does-not-exist', () => input('100.00'), NOW))
  assert.deepEqual(outcome, { kind: 'order_not_found' })
})

test('two builders racing: one stamps, the other reads the winner, and the row holds the first decision', { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const id = await seedOrder(db)
  try {
    const [a, b] = await Promise.all([
      db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('100.00'), new Date('2026-11-01T10:00:00.000Z'))),
      db.$transaction((tx) => stampEuVatRegime(tx, id, () => input('200.00'), new Date('2026-11-01T10:00:01.000Z'))),
    ])
    const kinds = [a.kind, b.kind].sort()
    assert.deepEqual(kinds, ['already_stamped', 'stamped'])
    const winner = a.kind === 'stamped' ? a : b
    const loser = a.kind === 'stamped' ? b : a
    assert.equal(winner.kind === 'stamped' && loser.kind === 'already_stamped' && loser.stamp.regime, winner.kind === 'stamped' ? winner.stamp.regime : null)
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { euVatRegime: true, euVatRegimeStampedAt: true } })
    assert.equal(row.euVatRegime, winner.kind === 'stamped' ? winner.stamp.regime : null)
    assert.deepEqual(row.euVatRegimeStampedAt, winner.kind === 'stamped' ? winner.stamp.stampedAt : null)
  } finally {
    await db.salesOrder.delete({ where: { id } })
  }
})

test('the database refuses a regime without an account and a marker', { skip }, async () => {
  const { db } = await setup()
  const id = await seedOrder(db)
  try {
    await assert.rejects(() => db.$executeRaw`UPDATE "sales_orders" SET "eu_vat_regime" = 'IOSS'::"EuVatRegime" WHERE id = ${id}`, /sales_orders_eu_vat_regime_stamp_shape/)
    await assert.rejects(() => db.$executeRaw`UPDATE "sales_orders" SET "eu_vat_regime" = 'DDP'::"EuVatRegime", "eu_vat_line_account" = '232' WHERE id = ${id}`, /sales_orders_eu_vat_regime_stamp_shape/)
    await db.$executeRaw`UPDATE "sales_orders" SET "eu_vat_regime" = 'DDP'::"EuVatRegime", "eu_vat_line_account" = '232', "eu_vat_regime_stamped_at" = now() WHERE id = ${id}`
  } finally {
    await db.salesOrder.delete({ where: { id } })
  }
})

test("adopt mode stamps the plugin's decision with its conversion record in the basis; a missing account refuses and stamps nothing", { skip }, async () => {
  const { db, stampEuVatRegime } = await setup()
  const adopted = await seedOrder(db)
  const bare = await seedOrder(db)
  try {
    const fx = { state: 'present' as const, rate: '1.1500', pair: 'GBP>EUR', thresholdValue: '149.50' }
    const a = await db.$transaction((tx) => stampEuVatRegime(tx, adopted, () => input('100.00', { mode: 'adopt_plugin', pluginVatAccount: '232', pluginFx: fx }), NOW))
    assert.deepEqual(a.kind === 'stamped' && a.stamp, { regime: 'DDP', vatAccount: '232', stampedAt: NOW })
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: adopted }, select: { euVatRegimeBasis: true } })
    const basis = row.euVatRegimeBasis as { scheme: { source: string; pluginFx: unknown } }
    assert.equal(basis.scheme.source, 'plugin')
    assert.deepEqual(basis.scheme.pluginFx, { recorded: true, rate: '1.1500', pair: 'GBP>EUR', thresholdValue: '149.50' })
    const b = await db.$transaction((tx) => stampEuVatRegime(tx, bare, () => input('100.00', { mode: 'adopt_plugin', pluginVatAccount: null }), NOW))
    assert.equal(b.kind === 'refused' && b.code, 'plugin_account_missing')
    const untouched = await db.salesOrder.findUniqueOrThrow({ where: { id: bare }, select: { euVatRegimeStampedAt: true } })
    assert.equal(untouched.euVatRegimeStampedAt, null)
  } finally {
    await db.salesOrder.deleteMany({ where: { id: { in: [adopted, bare] } } })
  }
})
