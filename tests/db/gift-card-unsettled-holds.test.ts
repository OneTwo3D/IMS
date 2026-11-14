import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE GIFT-CARD SECTION OF SYNC > EXCEPTIONS AGAINST A REAL DATABASE: the filter is applied in the database BEFORE the page is cut, so unrelated refusals cannot hide an answerable order; every matching order is
 * reachable by paging; and the count (heading and inbox badge) is the true total. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/gift-card-unsettled-holds.test.ts would have been skipped')
}

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }), requireFreshPermission: async () => ({ user: { id: 'u1' } }), freshAuthFailureResult: () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })

async function hold(db: Awaited<ReturnType<typeof setup>>['db'], tag: string, marker: Prisma.InputJsonObject, at: Date) {
  const { HELD_SALES_INVOICE_RECORD_KIND, MISSING_INVOICE_NUMBER_QUEUE_REASON } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const id = randomUUID()
  await db.shoppingSyncLog.create({
    data: {
      connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: `gcp-${tag}-${id}`, externalId: `gcp-${tag}-${id}`, recordKind: HELD_SALES_INVOICE_RECORD_KIND, createdAt: at,
      payload: { reason: MISSING_INVOICE_NUMBER_QUEUE_REASON, connector: 'woocommerce', externalOrderId: `gcp-${tag}-${id}`, externalOrderNumber: tag, salesOrderId: `gcp-${tag}-${id}`, orderNumber: tag, metaKey: 'k', accountingPayload: { _euVatTreatment: marker } },
    },
  })
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const actions = await import('@/app/actions/gift-card-line-resolution')
  return { db, ...actions }
}

const clean = (db: Awaited<ReturnType<typeof setup>>['db']) => db.shoppingSyncLog.deleteMany({ where: { externalId: { startsWith: 'gcp-' } } })

test('60 unrelated refusals older than 3 gift-card ones do not hide them; the count is right', { skip }, async (t) => {
  const { db, listGiftCardLinesToResolve } = await setup()
  t.after(() => clean(db))
  const { giftCardUnsettledHoldWhere } = await import('@/lib/connectors/woocommerce/sync/gift-card-line-resolution')
  const before = await db.shoppingSyncLog.count({ where: giftCardUnsettledHoldWhere() })
  for (let i = 0; i < 60; i += 1) await hold(db, `other${i}`, { applied: false, reason: 'treatment_refused', refusal: 'a rate is unmapped' }, new Date('2020-01-01T00:00:00Z'))
  await hold(db, 'untreated', { applied: false, reason: 'store_credit' }, new Date('2020-01-02T00:00:00Z'))
  for (let i = 0; i < 3; i += 1) await hold(db, `gift${i}`, { applied: false, reason: 'treatment_refused', refusal: 'gift card flag', giftCardLineIds: [7], giftCardUnsettled: true }, new Date('2026-11-14T00:00:00Z'))
  const page = await listGiftCardLinesToResolve(0)
  assert.equal(page.total, before + 3)
  assert.equal(page.rows.length, before + 3)
  assert.equal(page.rows.filter((row) => row.orderNumber.startsWith('gift')).length, 3)
  assert.equal(page.rows.some((row) => row.orderNumber.startsWith('other')), false)
})

test('55 gift-card holds are reached in two pages and the count says 55', { skip }, async (t) => {
  const { db, listGiftCardLinesToResolve } = await setup()
  const GIFT_CARD_PAGE_SIZE = 50
  t.after(() => clean(db))
  const { giftCardUnsettledHoldWhere } = await import('@/lib/connectors/woocommerce/sync/gift-card-line-resolution')
  const before = await db.shoppingSyncLog.count({ where: giftCardUnsettledHoldWhere() })
  assert.equal(before, 0, 'the database holds no other gift-card holds')
  for (let i = 0; i < 55; i += 1) await hold(db, `pg${String(i).padStart(2, '0')}`, { applied: false, reason: 'treatment_refused', refusal: 'gift card flag', giftCardLineIds: [1], giftCardUnsettled: true }, new Date(Date.UTC(2026, 10, 1, 0, 0, i)))
  const first = await listGiftCardLinesToResolve(0)
  const second = await listGiftCardLinesToResolve(1)
  const third = await listGiftCardLinesToResolve(2)
  assert.deepEqual([first.total, first.rows.length, second.total, second.rows.length, third.rows.length], [55, GIFT_CARD_PAGE_SIZE, 55, 55 - GIFT_CARD_PAGE_SIZE, 0])
  const seen = new Set([...first.rows, ...second.rows].map((row) => row.orderNumber))
  assert.equal(seen.size, 55, 'every order once')
})

test('an answer is read only under the store it was given for, and a rebind to another store deletes the old store’s answers', { skip }, async (t) => {
  const { db } = await setup()
  const { loadGiftCardLineResolutions } = await import('@/lib/connectors/woocommerce/sync/gift-card-line-resolution')
  const order = `gcp-store-${randomUUID()}`
  t.after(() => db.euVatGiftCardLineResolution.deleteMany({ where: { externalOrderId: order } }))
  const row = (storeIdentity: string, isGiftCard: boolean) => ({ connector: 'woocommerce', storeIdentity, externalOrderId: order, externalLineItemId: 5, isGiftCard, resolvedByUserId: 'u1' })
  await db.euVatGiftCardLineResolution.createMany({ data: [row('https://a.example', true), row('https://b.example', false)] })
  assert.deepEqual([...await loadGiftCardLineResolutions(db, 'https://a.example', order)], [[5, true]])
  assert.deepEqual([...await loadGiftCardLineResolutions(db, 'https://b.example', order)], [[5, false]])
  assert.equal((await loadGiftCardLineResolutions(db, 'https://c.example', order)).size, 0)
  assert.equal((await loadGiftCardLineResolutions(db, null, order)).size, 0, 'no known store: no answer')
  // The rebind's deletion (app/actions/wc-sync.ts): every answer of a store other than the one now configured.
  await db.euVatGiftCardLineResolution.deleteMany({ where: { NOT: { storeIdentity: 'https://b.example' }, externalOrderId: order } })
  assert.equal((await loadGiftCardLineResolutions(db, 'https://a.example', order)).size, 0)
  assert.equal((await loadGiftCardLineResolutions(db, 'https://b.example', order)).size, 1)
})
