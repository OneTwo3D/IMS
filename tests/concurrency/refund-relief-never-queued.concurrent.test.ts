import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { backendPid } from '../helpers/lock-wait-observer.ts'

/**
 * o3d-fj4m — A REFUND WHOSE ALLOCATION REVERSAL WAS NEVER QUEUED MUST NOT BE COUNTED AS RELIEF BY THE
 * NEXT REFUND. PROVED ON A REAL DATABASE THROUGH THE REAL `createRefund` / `retryRefundAccounting`.
 *
 * THE BEAD'S SEQUENCE, AND WHERE IT IS REACHABLE. Staging writes `SalesOrderRefund.allocatedReliefAmount`
 * (what the refund's UNEARNED_REV_REVERSAL WILL raise) in its own transaction, BEFORE the hand-off enqueues
 * that journal. When the pinned enqueue is refused, nothing is written and `accountingRetryRequired` stays
 * set, so the next refund is blocked by scjz.22 ("a previous refund has unresolved accounting") - the
 * bead's step 4 does not happen through `createRefund` of a NEW refund. It happens through TWO other doors,
 * both found while reproducing it, and both are exercised here:
 *
 *   A  A REPLAY. WooCommerce redelivers the SAME refund id. The replay returns `accountingSyncs: []`, the
 *      hand-off queues only the (idempotent) credit note, settles, and `clearRefundAccountingRetryState`
 *      then wipes `accountingRetryRequired` AND `accountingRetrySyncs` - the only record of the reversal
 *      that was never queued - while `allocatedReliefAmount` stands. Refund #2 then reads the absent
 *      journal as "retention took it" and counts it as relief.
 *   B  A HAND-OFF SETTLED BY "THIS POSTING WILL NEVER EXIST" (the connector's sync switched off between
 *      staging and the hand-off, the one no-op the obligation ledger may settle with). The flag clears
 *      legitimately and no journal is ever written, but `allocatedReliefAmount` still says it was.
 *
 * THE NUMBERS. An order of 4 units, A2 debited £40 (£10 a unit). Refund #1 returns 1 unit: relief £10.
 * Refund #2 returns the other 3 units in full.
 *   - #1's reversal exists nowhere, so the open Allocated Inventory balance is the whole £40: #2 must
 *     credit £40.
 *   - On trunk #2 counts #1's absent £10 as relief and credits £30: £10 stays in Allocated Inventory.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (`npm run test:concurrency`).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }

const ACCOUNT_SETTINGS: Array<[string, string]> = [
  ['xero_sales_account', '4000'],
  ['xero_shipping_account', '4010'],
  ['xero_cogs_account', '5000'],
  ['xero_inventory_account', '1200'],
  ['xero_allocated_inventory_account', '1210'],
  ['xero_unearned_revenue_account', '2100'],
  ['xero_accounts_receivable_account', '1100'],
]
const ALLOCATED_ACCOUNT = '1210'

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-fj4m concurrency test requires a Postgres DATABASE_URL')
  }
}

let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() {
  depsPromise ??= loadDepsOnce()
  return depsPromise
}
async function loadDepsOnce() {
  loadEnv()
  // The action is 'use server' and imports next/cache; outside a request that import is inert only if
  // it is replaced. Authorisation is bypassed by the action's own INTERNAL capability for createRefund;
  // retryRefundAccounting asks requirePermission, which is replaced with a pass.
  // The reservation release that follows a refund re-allocates the order (autoAllocateOrder), rewriting the
  // fixture's pinned allocation rows - which this test is NOT about. Replaced, so the order stays as seeded.
  mock.module('../../lib/domain/sales/post-refund-release.ts', { namedExports: { releaseReservationsAfterRefund: async () => undefined } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
  const realAuth = await import('../../lib/auth/server.ts')
  mock.module('../../lib/auth/server.ts', {
    namedExports: {
      ...realAuth,
      requirePermission: async () => ({ user: { id: 'o3d-fj4m-test' } }),
      requireFreshPermission: async () => ({ user: { id: 'o3d-fj4m-test' } }),
      freshAuthFailureResult: () => null,
    },
  })
  const [{ db }, actions, bypass] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../app/actions/sales.ts'),
    import('../../lib/internal-action-bypass.ts'),
  ])
  return { db, createRefund: actions.createRefund, retryRefundAccounting: actions.retryRefundAccounting, bypass: bypass.INTERNAL_ACTION_BYPASS }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>
type Db = Deps['db']

/** Xero active, sync ON, every account the staging reads configured. Returns what to put back. */
async function configureXero(db: Db): Promise<() => Promise<void>> {
  const entries: Array<[string, string]> = [
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
    ['xero_sync_enabled', 'true'],
    ...ACCOUNT_SETTINGS,
  ]
  const before = new Map((await db.setting.findMany({ where: { key: { in: entries.map(([k]) => k) } } })).map((row) => [row.key, row.value]))
  for (const [key, value] of entries) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  return async () => {
    for (const [key] of entries) {
      const previous = before.get(key)
      if (previous === undefined) await db.setting.deleteMany({ where: { key } })
      else await db.setting.update({ where: { key }, data: { value: previous } })
    }
  }
}

async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

type Fixture = Awaited<ReturnType<typeof seed>>

async function seed(db: Db, suffix: string) {
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const product = await db.product.create({ data: { sku: `FJ4M-${suffix}`, name: `fj4m ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `FJ${suffix.slice(0, 8)}`, name: `fj4m ${suffix}` }, select: { id: true } })
  const taxRate = await db.taxRate.create({
    data: { name: `FJ4M-ZERO-${suffix.slice(0, 6)}`, rate: new Prisma.Decimal('0'), accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: false },
    select: { id: true },
  })
  const batchRef = `A2-FJ4M-${suffix}`
  const a2Log = await db.accountingSyncLog.create({
    data: {
      connector: 'xero',
      type: 'DAILY_BATCH_INVENTORY_ALLOC',
      status: 'SYNCED',
      referenceType: 'DailyBatch',
      referenceId: batchRef,
      payload: { lines: [{ accountCode: ALLOCATED_ACCOUNT, debit: 40 }, { accountCode: '1200', credit: 40 }] },
      syncedAt: new Date(),
    },
    select: { id: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `FJ4M-${suffix.slice(0, 8)}`,
      status: 'ALLOCATED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      pricesIncludeVat: false,
      taxRatePercent: new Prisma.Decimal('0'),
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: new Prisma.Decimal('100'),
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: batchRef,
      allocationBatchAmount: new Prisma.Decimal('40'),
      allocationBatchSyncLogId: a2Log.id,
      allocationBatchConnector: 'xero',
      allocationBatchAccountCode: ALLOCATED_ACCOUNT,
      allocationBatchPasses: [{ amount: '40', syncLogId: a2Log.id, connector: 'xero', accountCode: ALLOCATED_ACCOUNT, batchRef, at: null }],
      lines: {
        create: [{
          productId: product.id,
          description: 'fj4m line',
          qty: new Prisma.Decimal('4'),
          unitPriceForeign: new Prisma.Decimal('25'),
          unitPriceBase: new Prisma.Decimal('25'),
          taxForeign: new Prisma.Decimal('0'),
          taxBase: new Prisma.Decimal('0'),
          totalForeign: new Prisma.Decimal('100'),
          totalBase: new Prisma.Decimal('100'),
          taxRateId: taxRate.id,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.orderAllocation.create({
    data: {
      orderId: order.id,
      lineId,
      productId: product.id,
      warehouseId: warehouse.id,
      qty: new Prisma.Decimal('4'),
      costLayerSnapshot: [{ costLayerId: `fj4m-layer-${suffix}`, qty: 4, unitCostBase: 10, source: 'allocation' }],
      allocationBatchAmount: new Prisma.Decimal('40'),
    },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: warehouse.id, quantity: new Prisma.Decimal('4'), reservedQty: new Prisma.Decimal('4') },
  })
  return { productId: product.id, warehouseId: warehouse.id, orderId: order.id, lineId, a2LogId: a2Log.id, batchRef, taxRateId: taxRate.id }
}

async function cleanup(db: Db, fx: Fixture | undefined) {
  if (!fx) return
  const refunds = await db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })
  const refundIds = refunds.map((r) => r.id)
  await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: { in: refundIds } }, { id: fx.a2LogId }] } }).catch(() => {})
  await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: refundIds } } }).catch(() => {})
  await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: fx.orderId } } }).catch(() => {})
  await db.stockMovement.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
  await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
  await db.warehouse.deleteMany({ where: { id: fx.warehouseId } }).catch(() => {})
  await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
  await db.taxRate.delete({ where: { id: fx.taxRateId } }).catch(() => {})
}

const wooRefundId = () => 3_000_000 + Math.floor(Math.random() * 6_000_000)

async function refund(deps: Deps, fx: Fixture, params: { units: number; externalRefundId: number; full?: boolean }) {
  return deps.createRefund(
    fx.orderId,
    [{ lineId: fx.lineId, productId: fx.productId, description: 'fj4m line', qty: params.units, totalBase: params.units * 25, lineKind: 'sale' }],
    'o3d-fj4m',
    undefined,
    { internalBypassToken: deps.bypass, externalRefundId: params.externalRefundId },
  )
}

/**
 * Between STAGING's commit and the HAND-OFF: flip one setting in the same transaction that writes
 * the staged syncs onto the refund. The trigger fires inside the staging transaction, so the change
 * becomes visible exactly when the staging does - after the chart was read, before the enqueue. A
 * deterministic interleaving with no sleep; dropped in `t.after`.
 */
async function armFlipAtStaging(db: Db, params: { externalRefundId: number; settingKey: string; toValue: string; tag: string }): Promise<() => Promise<void>> {
  const fn = `fj4m_flip_${params.tag}`
  const trg = `fj4m_flip_trg_${params.tag}`
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW."externalRefundId" = ${Number(params.externalRefundId)} AND OLD.accounting_retry_syncs IS NULL AND NEW.accounting_retry_syncs IS NOT NULL THEN
        UPDATE settings SET value = '${params.toValue.replace(/'/g, '')}' WHERE key = '${params.settingKey.replace(/'/g, '')}';
      END IF;
      RETURN NEW;
    END $f$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER ${trg} AFTER UPDATE ON sales_order_refunds FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON sales_order_refunds`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`)
  }
}

async function refundRow(db: Db, orderId: string, externalRefundId: number) {
  const row = await db.salesOrderRefund.findFirst({
    where: { orderId, externalRefundId },
    select: {
      id: true,
      accountingRetryRequired: true,
      accountingRetrySyncs: true,
      allocatedReliefAmount: true,
      allocationBasisUnresolved: true,
    },
  })
  assert.ok(row, `refund ${externalRefundId} must exist`)
  return row
}

async function reversalRows(db: Db, refundId: string) {
  return db.accountingSyncLog.findMany({
    where: { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refundId },
    select: { id: true, status: true, connector: true, payload: true },
  })
}

/** The CR Allocated Inventory a queued UNEARNED_REV_REVERSAL carries. */
function allocatedCredit(payload: unknown): number {
  const lines = (payload as { lines?: Array<{ accountCode?: string; credit?: number }> } | null)?.lines ?? []
  return lines.filter((l) => l.accountCode === ALLOCATED_ACCOUNT).reduce((sum, l) => sum + (l.credit ?? 0), 0)
}

/** Refund #2's own allocation credit, as it queued it (or null: it was refused, or withheld). */
async function creditOf(db: Db, refundId: string): Promise<number | null> {
  const rows = await reversalRows(db, refundId)
  if (rows.length === 0) return null
  return allocatedCredit(rows[0].payload)
}


/** One scratch order + its cleanup, wired to the test's own `t.after`. */
async function rig(t: { after: (fn: () => Promise<void>) => void }) {
  const deps = await loadDeps()
  const { db } = deps
  const restore = await configureXero(db)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const disarm: Array<() => Promise<void>> = []
  const seeded: { fx?: Fixture } = {}
  t.after(async () => {
    for (const d of disarm) await d().catch(() => {})
    await cleanup(db, seeded.fx)
    await restore()
  })
  seeded.fx = await seed(db, suffix)
  return { deps, db, fx: seeded.fx, suffix, disarm }
}
type Rig = Awaited<ReturnType<typeof rig>>

/**
 * BEAD STEPS 1-3. Refund #1 stages (relief £10 recorded) and its hand-off is REFUSED: the Xero plugin
 * selection is switched off in the same commit as the staging, so the pinned enqueue answers `refused`
 * and writes nothing. The selection is switched back on afterwards. Returns refund #1's row.
 */
async function stageFirstRefundRefused(r: Rig, label: string) {
  const w1 = wooRefundId()
  r.disarm.push(await armFlipAtStaging(r.db, { externalRefundId: w1, settingKey: INTEGRATION_PLUGIN_SETTING_KEYS.xero, toValue: 'false', tag: `${label}${r.suffix.slice(0, 6)}` }))
  const first = await refund(r.deps, r.fx, { units: 1, externalRefundId: w1 })
  await setSetting(r.db, INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true')
  const row = await refundRow(r.db, r.fx.orderId, w1)
  const rows = await reversalRows(r.db, row.id)
  console.log(`PRECONDITION ${label}: refund#1 success=${first.success} warned=${Boolean(first.warning)} flag=${row.accountingRetryRequired} relief=${row.allocatedReliefAmount} syncsRecorded=${row.accountingRetrySyncs != null} reversalRows=${rows.length}`)
  assert.equal(Number(row.allocatedReliefAmount), 10, 'PRECONDITION: staging recorded £10 of relief on refund #1 (bead step 1)')
  assert.equal(rows.length, 0, 'PRECONDITION: the refused hand-off wrote NO UNEARNED_REV_REVERSAL row (bead step 3)')
  assert.equal(row.accountingRetryRequired, true, 'PRECONDITION: the refusal left the refund flagged as owing accounting')
  assert.notEqual(row.accountingRetrySyncs, null, 'PRECONDITION: the staged reversal is recorded on the refund, waiting for a retry')
  return { w1, id: row.id }
}

/** Refund #2: the remaining three units, in full. Returns what it did, as the DB shows it. */
async function secondRefund(r: Rig, label: string) {
  const w2 = wooRefundId()
  const result = await refund(r.deps, r.fx, { units: 3, externalRefundId: w2, full: true })
  const row = await r.db.salesOrderRefund.findFirst({ where: { orderId: r.fx.orderId, externalRefundId: w2 }, select: { id: true } })
  const credit = row ? await creditOf(r.db, row.id) : null
  if (row) {
    const full = await r.db.salesOrderRefund.findUniqueOrThrow({ where: { id: row.id }, select: { allocatedReliefAmount: true, allocationBasisUnresolved: true, accountingRetryRequired: true, accountingWarning: true } })
    console.log(`${label}: refund#2 row relief=${full.allocatedReliefAmount} flag=${full.accountingRetryRequired} warning=${(full.accountingWarning ?? '').slice(0, 200)} unresolved=${(full.allocationBasisUnresolved ?? '').slice(0, 400)}`)
  }
  console.log(`${label}: refund#2 success=${result.success} error=${(result.error ?? '').slice(0, 90) || null} created=${Boolean(row)} allocationCredit=${credit}`)
  return { result, row, credit, w2 }
}

/** The drain's part: mark a queued reversal SYNCED with the document id the ledger would have given it. */
async function drainReversal(db: Db, refundId: string): Promise<void> {
  const rows = await reversalRows(db, refundId)
  assert.equal(rows.length, 1, 'PRECONDITION: exactly one queued UNEARNED_REV_REVERSAL to drain')
  await db.accountingSyncLog.update({ where: { id: rows[0].id }, data: { status: 'SYNCED', externalTransactionId: `FJ4M-${refundId.slice(-8)}`, syncedAt: new Date() } })
}

test(
  '[o3d-fj4m A1] a WooCommerce REPLAY of a refund whose reversal was refused must not clear the owed flag or the staged record',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    const { w1 } = await stageFirstRefundRefused(r, 'A1')

    // THE DOOR. WooCommerce redelivers refund #1.
    const replay = await refund(r.deps, r.fx, { units: 1, externalRefundId: w1 })
    const after = await refundRow(r.db, r.fx.orderId, w1)
    console.log(`A1 replay: success=${replay.success} flag=${after.accountingRetryRequired} syncsRecorded=${after.accountingRetrySyncs != null} relief=${after.allocatedReliefAmount}`)
    assert.equal(replay.success, true, 'PRECONDITION: the redelivery was accepted as a replay (it is not a new refund)')
    assert.equal(after.accountingRetryRequired, true, 'a replay handed nothing off, so it must not discharge the owed accounting (the flag stays set)')
    assert.notEqual(after.accountingRetrySyncs, null, 'and it must not erase the only record of the reversal that was never queued')
  },
)

test(
  '[o3d-fj4m A2] after a refused reversal and a replay, refund #2 is refused or credits the whole £40, never £30',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    const { w1 } = await stageFirstRefundRefused(r, 'A2')
    await refund(r.deps, r.fx, { units: 1, externalRefundId: w1 }) // the replay

    // BEAD STEP 4. #1's reversal exists nowhere, so the open balance is the whole £40.
    const second = await secondRefund(r, 'A2')
    assert.ok(
      second.row == null || second.credit === 40,
      `refund #2 was created and credited £${second.credit} of Allocated Inventory; refund #1's £10 reversal was never queued, so the open balance is the whole £40`,
    )
  },
)

test(
  '[o3d-fj4m B] a hand-off settled by "this posting will never exist" leaves no relief standing behind it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    // The connector's sync is switched OFF between staging and the hand-off: the obligation ledger settles
    // (nothing will ever post), the flag clears legitimately, and no journal is ever written.
    const w1 = wooRefundId()
    r.disarm.push(await armFlipAtStaging(r.db, { externalRefundId: w1, settingKey: 'xero_sync_enabled', toValue: 'false', tag: `b${r.suffix.slice(0, 6)}` }))
    const first = await refund(r.deps, r.fx, { units: 1, externalRefundId: w1 })
    await setSetting(r.db, 'xero_sync_enabled', 'true')
    const row = await refundRow(r.db, r.fx.orderId, w1)
    const rows = await reversalRows(r.db, row.id)
    console.log(`PRECONDITION B: refund#1 success=${first.success} warned=${Boolean(first.warning)} flag=${row.accountingRetryRequired} relief=${row.allocatedReliefAmount} reversalRows=${rows.length}`)
    assert.equal(first.success, true)
    assert.equal(first.warning, undefined, 'PRECONDITION: the hand-off settled cleanly (the "will never exist" decision, not a refusal)')
    assert.equal(row.accountingRetryRequired, false, 'PRECONDITION: the flag cleared')
    assert.equal(rows.length, 0, 'PRECONDITION: no journal exists for refund #1 and none ever will')

    assert.equal(Number(row.allocatedReliefAmount), 0, 'the relief recorded for a journal that will never exist must not stand: it says £10 was raised')
    const second = await secondRefund(r, 'B')
    assert.equal(second.credit, 40, 'refund #1 raised nothing, so refund #2 credits the whole £40 open balance (on trunk it counts the absent £10 and credits £30)')
  },
)

test(
  '[o3d-fj4m C] (control) a refund whose reversal WAS queued and drained is counted as relief exactly once',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    const w1 = wooRefundId()
    const first = await refund(r.deps, r.fx, { units: 1, externalRefundId: w1 })
    const row = await refundRow(r.db, r.fx.orderId, w1)
    console.log(`PRECONDITION C: refund#1 success=${first.success} warned=${Boolean(first.warning)} flag=${row.accountingRetryRequired} relief=${row.allocatedReliefAmount}`)
    assert.equal(first.warning, undefined, 'PRECONDITION: the hand-off queued everything')
    assert.equal(row.accountingRetryRequired, false, 'PRECONDITION: the flag cleared')
    assert.equal(Number(row.allocatedReliefAmount), 10, 'PRECONDITION: relief stands, because the journal exists')
    await drainReversal(r.db, row.id)

    const second = await secondRefund(r, 'C')
    assert.equal(second.credit, 30, 'refund #1\'s £10 is relief once: open balance 40 - 10 = 30 (twice would be 20, never would be 40)')
  },
)

test(
  '[o3d-fj4m E] the RETRY path is the second discharge: a retry settled by "will never exist" leaves no relief standing either',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    const { id: id1 } = await stageFirstRefundRefused(r, 'E')

    // The operator switches the connector's sync off and retries refund #1: the replayed reversal settles by
    // "this posting will never exist", the flag clears, and no journal is ever written.
    await setSetting(r.db, 'xero_sync_enabled', 'false')
    const retried = await r.deps.retryRefundAccounting(id1)
    await setSetting(r.db, 'xero_sync_enabled', 'true')
    const row = await r.db.salesOrderRefund.findUniqueOrThrow({ where: { id: id1 }, select: { accountingRetryRequired: true, accountingRetrySyncs: true, allocatedReliefAmount: true } })
    const rows = await reversalRows(r.db, id1)
    console.log(`PRECONDITION E: retry success=${retried.success} ${retried.error ?? ''} flag=${row.accountingRetryRequired} relief=${row.allocatedReliefAmount} reversalRows=${rows.length}`)
    assert.equal(retried.success, true, 'PRECONDITION: the retry succeeded')
    assert.equal(row.accountingRetryRequired, false, 'PRECONDITION: the retry cleared the flag')
    assert.equal(rows.length, 0, 'PRECONDITION: no journal exists for refund #1 and none ever will')

    assert.equal(Number(row.allocatedReliefAmount), 0, 'the retry\'s discharge writes the relief down too')
    const second = await secondRefund(r, 'E')
    assert.equal(second.credit, 40, 'refund #1 raised nothing, so refund #2 credits the whole £40')
  },
)

/**
 * THE CRASH GAP (Codex HIGH on #733). Refund #1's reversal was QUEUED (or posted) and the process died before
 * the discharge, so the refund is still flagged. The operator then switches the connector's sync off and
 * retries: the enqueue asks "is posting enabled" BEFORE it looks for the prior journal, so the retry settles
 * the reversal as "will never post" - for a journal that EXISTS. Zeroing the relief there makes refund #2 skip
 * that journal and credit the whole open balance a second time.
 *
 * The crash is modelled by seeding the row the queue would have written onto a refund whose hand-off was
 * refused (so it is flagged with its syncs recorded): same state a crash between the enqueue commit and the
 * discharge leaves. Each arm names the standing of the seeded row and asserts it, and prints the precondition.
 */
async function crashGap(t: Parameters<typeof rig>[0], label: string, seededRows: Array<{ status: 'PENDING' | 'SYNCED' | 'CANCELLED'; externalTransactionId?: string; abandonedBeforeRemoteCall?: boolean; settlementBasis?: string }>) {
  const r = await rig(t)
  const { id: id1 } = await stageFirstRefundRefused(r, label)
  for (const seeded of seededRows) {
    const ledgerStandingMod = await import('../../lib/domain/accounting/ledger-standing.ts')
    const created = await r.db.accountingSyncLog.create({
      data: {
        connector: 'xero',
        type: 'UNEARNED_REV_REVERSAL',
        status: seeded.status,
        referenceType: 'SalesOrderRefund',
        referenceId: id1,
        externalTransactionId: seeded.externalTransactionId ?? null,
        abandonedBeforeRemoteCall: seeded.abandonedBeforeRemoteCall ?? null,
        settlementBasis: seeded.settlementBasis ?? null,
        syncedAt: seeded.status === 'SYNCED' ? new Date() : null,
        payload: { _idempotencyKey: `sales-order-refund:${id1}:unearned-reversal`, lines: [{ accountCode: '1200', debit: 10 }, { accountCode: ALLOCATED_ACCOUNT, credit: 10 }] },
      },
      select: { id: true, status: true, externalTransactionId: true, abandonedBeforeRemoteCall: true, settlementBasis: true },
    })
    console.log(`PRECONDITION ${label}: seeded prior attempt standing=${ledgerStandingMod.ledgerStanding(created)}`)
  }
  // sync OFF, then the retry
  await setSetting(r.db, 'xero_sync_enabled', 'false')
  const retried = await r.deps.retryRefundAccounting(id1)
  await setSetting(r.db, 'xero_sync_enabled', 'true')
  const row = await r.db.salesOrderRefund.findUniqueOrThrow({ where: { id: id1 }, select: { accountingRetryRequired: true, accountingRetrySyncs: true, allocatedReliefAmount: true } })
  console.log(`${label}: retry(sync off) success=${retried.success} flag=${row.accountingRetryRequired} relief=${row.allocatedReliefAmount}`)
  return { r, id1, retried, row }
}

test(
  '[o3d-fj4m F1] crash gap, prior attempt LIVE_WORK: relief KEPT, obligation unresolved, then the remainder only',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { r, id1, retried, row } = await crashGap(t, 'F1', [{ status: 'PENDING' }])
    assert.equal(retried.success, false, 'the retry reports the obligation unresolved')
    assert.equal(row.accountingRetryRequired, true, 'the flag stays')
    assert.equal(Number(row.allocatedReliefAmount), 10, 'the relief stays: the journal exists')
    // With posting back on the retry settles against the real row, and the journal drains.
    const again = await r.deps.retryRefundAccounting(id1)
    assert.equal(again.success, true, `retry with posting enabled settles against the existing row (${again.error ?? ''})`)
    assert.equal((await reversalRows(r.db, id1)).length, 1, 'no second reversal row')
    await drainReversal(r.db, id1)
    const second = await secondRefund(r, 'F1')
    assert.equal(second.credit, 30, 'the remainder only: 40 - 10, never 40 (a second credit of #1\'s £10)')
  },
)

test(
  '[o3d-fj4m F2] crash gap, prior attempt CONFIRMED_POSTED, posting DISABLED: the retry DISCHARGES, relief KEPT, refund #2 credits only the remainder',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { r, retried, row } = await crashGap(t, 'F2', [{ status: 'SYNCED', externalTransactionId: 'FJ4M-JNL-1' }])
    assert.equal(retried.success, true, `the journal posted, so the obligation is met even with posting off (${retried.error ?? ''})`)
    assert.equal(row.accountingRetryRequired, false, 'the flag and the record come down: the refund no longer blocks the order')
    assert.equal(Number(row.allocatedReliefAmount), 10, 'the relief is preserved, never zeroed')
    const second = await secondRefund(r, 'F2')
    assert.equal(second.credit, 30, 'the posted £10 is relief once: 30, never 40, and never blocked')
  },
)

test(
  '[o3d-fj4m F4] crash gap, CONFIRMED_POSTED beside a PROVEN_NOT_POSTED row (mixed): discharges, relief KEPT, #2 credits the 30 remainder',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { r, retried, row } = await crashGap(t, 'F4', [
      { status: 'CANCELLED', abandonedBeforeRemoteCall: true },
      { status: 'SYNCED', externalTransactionId: 'FJ4M-JNL-4' },
    ])
    assert.equal(retried.success, true)
    assert.equal(row.accountingRetryRequired, false)
    assert.equal(Number(row.allocatedReliefAmount), 10)
    // The reader and the discharge agree: the PROVEN_NOT_POSTED attempt is not part of what posted, the amount is
    // proved from the CONFIRMED one, so #2 credits the remainder (never 40, never withheld).
    assert.equal((await secondRefund(r, 'F4')).credit, 30)
  },
)

test(
  '[o3d-fj4m F5] crash gap, prior attempt ASSERTED_POSTED: still unresolved and blocked while posting is off',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { retried, row } = await crashGap(t, 'F5', [{ status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }])
    assert.equal(retried.success, false)
    assert.equal(row.accountingRetryRequired, true)
    assert.equal(Number(row.allocatedReliefAmount), 10)
  },
)

test(
  '[o3d-fj4m F3] (control) crash gap, the only prior attempt is PROVEN_NOT_POSTED: the relief IS written down and #2 credits the whole £40',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { r, row } = await crashGap(t, 'F3', [{ status: 'CANCELLED', abandonedBeforeRemoteCall: true }])
    assert.equal(row.accountingRetryRequired, false, 'nothing could have posted, so the obligation discharges')
    assert.equal(Number(row.allocatedReliefAmount), 0)
    const second = await secondRefund(r, 'F3')
    assert.equal(second.credit, 40)
  },
)

/** How many backends are blocked behind `holderPid` right now. */
async function blockedBehind(db: Db, holderPid: number): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND ${holderPid}::int = ANY (pg_blocking_pids(pid))`
  return Number(rows[0].n)
}
async function waitForBlocked(db: Db, holderPid: number, n: number, describe: string): Promise<void> {
  const deadline = Date.now() + 10_000
  let seen = 0
  while (Date.now() < deadline) {
    seen = await blockedBehind(db, holderPid)
    if (seen >= n) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`PRECONDITION NOT REACHED: expected ${n} backend(s) parked behind the holder (${describe}); saw ${seen}`)
}

test(
  '[o3d-fj4m D] refund #2 parked ahead of refund #1\'s retry is refused; once the retry has drained, #2 counts #1 exactly once',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const r = await rig(t)
    const { id: id1 } = await stageFirstRefundRefused(r, 'D')

    // A holder takes the GLOBAL refund lock - the first statement of both createSalesOrderRefund and
    // retrySalesOrderRefundAccounting - so the two arrive in a known order and queue FIFO behind it. No sleeps:
    // each arrival is OBSERVED parked (pg_blocking_pids) before the next starts.
    const { REFUND_ACCOUNTING_LOCK_KEY } = await import('../../lib/db/advisory-locks.ts')
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    let holderPid = 0
    const holder = r.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_ACCOUNTING_LOCK_KEY})`
      holderPid = await backendPid(tx)
      holding()
      await released
    }, TX)
    await held

    const w2 = wooRefundId()
    const second = refund(r.deps, r.fx, { units: 3, externalRefundId: w2, full: true })
    await waitForBlocked(r.db, holderPid, 1, 'refund #2 on the global refund lock')
    const retry = r.deps.retryRefundAccounting(id1)
    await waitForBlocked(r.db, holderPid, 2, 'refund #1\'s retry queued behind refund #2')
    console.log('PRECONDITION D: two backends parked behind the holder, refund #2 first')
    release()
    await holder
    const secondResult = await second
    const retryResult = await retry
    const row2 = await r.db.salesOrderRefund.findFirst({ where: { orderId: r.fx.orderId, externalRefundId: w2 }, select: { id: true } })
    const row1 = await r.db.salesOrderRefund.findUniqueOrThrow({ where: { id: id1 }, select: { accountingRetryRequired: true, accountingRetrySyncs: true, allocatedReliefAmount: true } })
    const rows1 = await reversalRows(r.db, id1)
    console.log(`D arm 1: refund#2 success=${secondResult.success} created=${Boolean(row2)}; retry success=${retryResult.success} ${retryResult.error ?? ''}; #1 flag=${row1.accountingRetryRequired} relief=${row1.allocatedReliefAmount} reversalRows=${rows1.length}`)
    assert.equal(row2, null, 'refund #2 arrived while #1 still owed its reversal: it is refused, not created on #1\'s unqueued £10')
    assert.equal(retryResult.success, true, 'and #1\'s retry then completes')
    assert.equal(row1.accountingRetryRequired, false, 'which clears #1\'s flag')
    assert.equal(rows1.length, 1, 'having queued the reversal exactly once')

    // ARM 2: the retry has drained. #2 now sees a journal, not a record.
    await drainReversal(r.db, id1)
    const again = await secondRefund(r, 'D arm 2')
    assert.equal(again.credit, 30, 'after the retry drained, refund #1 is relief exactly once: 40 - 10 = 30')
  },
)

test('[o3d-fj4m] disconnect', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async () => {
  const { db } = await loadDeps()
  await db.$disconnect()
})
