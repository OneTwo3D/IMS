import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import type { XeroSupplierPrepayment, XeroSupplierPrepaymentRead } from '@/lib/connectors/xero/prepayments'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'
import * as fixtures from './po-landed-fixtures'

/**
 * PURCHASE FX STEP 2, REVIEW FOLLOW-UPS (#1142 review, MED-1..MED-7 and the cheap LOWs). Real PostgreSQL, the REAL receipt action, book-in, alignment and
 * on-demand read; only the Xero prepayment read and the Xero contact read are replaced by the fakes below. Nothing here reaches Xero, Mintsoft or WooCommerce.
 *
 * THE BARRIERS. The concurrent arms do not rely on timing: a separate connection holds the order's `purchase_orders` row lock, the arms are started,
 * and `waitBlocked` asserts from `pg_blocking_pids` (the lock manager's own answer) that every one of them is really WAITING for that row before it is
 * released. Without that assertion the arms would only be ordinary sequencing.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const TENANT = 'tenant-purchfx-fu'

const ledger: { calls: string[]; answer: (reference: string) => XeroSupplierPrepaymentRead } = {
  calls: [],
  answer: () => ({ ok: true, tenantId: TENANT, prepayments: [] }),
}
mock.module('@/lib/connectors/xero/prepayments', {
  namedExports: {
    XERO_PREPAYMENTS_PAGE_SIZE: 100,
    XERO_PREPAYMENT_READ_TIMEOUT_MS: 20_000,
    readXeroSupplierPrepaymentsByReference: async (reference: string) => {
      ledger.calls.push(reference)
      return ledger.answer(reference)
    },
  },
})
const contactLedger: { calls: number; answer: () => { success: true; contactId: string | null; tenantId?: string } | { success: false; error: string } } = {
  calls: 0,
  answer: () => ({ success: true, contactId: null }),
}
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: {
    findXeroContactReadOnly: async () => { contactLedger.calls += 1; return contactLedger.answer() },
    storeContactId: async (contactId: string, tenantId: string, ref: { supplierId: string }) => {
      const { db } = await import('@/lib/db')
      await db.supplier.update({ where: { id: ref.supplierId }, data: { accountingContactId: contactId, accountingContactProvenance: `xero:${tenantId}` } })
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, alignUp, receive } = fixtures

const SWITCH = 'purchase_event_fx_rates_enabled'
const PO_RATE = '1.25'
const UNIT_FOREIGN = '6.25'
const HOUR = 3_600_000

async function setSetting(key: string, value: string | null): Promise<void> {
  const { db } = await import('@/lib/db')
  if (value === null) await db.setting.deleteMany({ where: { key } })
  else await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function withSwitch<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  await setSetting(SWITCH, on ? 'true' : 'false')
  try {
    return await fn()
  } finally {
    await setSetting(SWITCH, 'false')
  }
}

const createdCurrencies: string[] = []
async function freshCurrency(): Promise<string> {
  const { db } = await import('@/lib/db')
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (;;) {
    const code = `Q${letters[Math.floor(Math.random() * 26)]}${letters[Math.floor(Math.random() * 26)]}`
    if (await db.currency.findUnique({ where: { code } })) continue
    await db.currency.create({ data: { code, name: `purchfx ${code}`, symbol: code } })
    createdCurrencies.push(code)
    return code
  }
}

async function addRate(currency: string, rate: string, fetchedAt: Date): Promise<void> {
  const { db } = await import('@/lib/db')
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: currency, rate, fetchedAt, source: 'aelia' } })
}

type ForeignPo = Awaited<ReturnType<typeof seedPo>> & { currency: string; contactId: string; reference: string }

/** A PO_SENT order made foreign at PO_RATE, its supplier linked to a Xero contact of TENANT, and a table rate of 1.4 in force (a minute ago). */
async function seedForeignPo(label: string, qtys: number[], options: { reuse?: ForeignPo; link?: boolean; currency?: string } = {}): Promise<ForeignPo> {
  const { db } = await import('@/lib/db')
  const po = await seedPo(`fu-${label}`, qtys, 'PO_SENT', options.reuse)
  const currency = options.currency ?? await freshCurrency()
  if (!options.currency) {
    await addRate(currency, PO_RATE, new Date(Date.now() - 86_400_000))
    await addRate(currency, '1.4', new Date(Date.now() - 60_000))
  }
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { reference: true, supplierId: true, subtotalBase: true, totalBase: true, lines: { select: { id: true, totalBase: true } } } })
  await db.purchaseOrder.update({
    where: { id: po.poId },
    data: { currency, fxRateToBase: PO_RATE, subtotalForeign: row.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: row.totalBase.mul(PO_RATE).toFixed(4) },
  })
  for (const line of row.lines) {
    await db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: UNIT_FOREIGN, totalForeign: line.totalBase.mul(PO_RATE).toFixed(4) } })
  }
  const contactId = `contact-${uid()}`
  if (options.link !== false) {
    await db.supplier.update({ where: { id: row.supplierId }, data: { accountingContactId: contactId, accountingContactProvenance: `xero:${TENANT}` } })
  }
  return { ...po, currency, contactId, reference: row.reference }
}

function prepaymentFor(po: ForeignPo, overrides: Partial<XeroSupplierPrepayment> = {}): XeroSupplierPrepayment {
  return {
    prepaymentId: `pp-${uid()}`, status: 'AUTHORISED', reference: po.reference, contactId: po.contactId, currencyCode: po.currency,
    currencyRate: new Prisma.Decimal('1.6'), total: new Prisma.Decimal('100'), date: '2026-11-20',
    ...overrides,
  }
}

function answerWith(map: Array<[ForeignPo, XeroSupplierPrepayment[]]>): void {
  ledger.answer = (reference) => ({ ok: true, tenantId: TENANT, prepayments: map.find(([po]) => po.reference === reference)?.[1] ?? [] })
}

async function layersOf(po: { lines: Array<{ poLineId: string }> }) {
  const { db } = await import('@/lib/db')
  const rows = await db.costLayer.findMany({ where: { poLineId: { in: po.lines.map((l) => l.poLineId) } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { unitCostBase: true, fxRateToBase: true, receivedQty: true } })
  return rows.map((l) => ({ unit: l.unitCostBase.toString(), rate: l.fxRateToBase?.toString() ?? null, qty: Number(l.receivedQty) }))
}

async function receiptsOf(po: { poId: string }) {
  const { db } = await import('@/lib/db')
  const rows = await db.purchaseReceipt.findMany({ where: { poId: po.poId }, orderBy: { createdAt: 'asc' }, select: { fxRateToBase: true, fxRateSource: true } })
  return rows.map((r) => ({ rate: r.fxRateToBase?.toString() ?? null, source: r.fxRateSource }))
}

async function lockOf(po: { poId: string }) {
  const { db } = await import('@/lib/db')
  return db.purchaseOrderFxLock.findUnique({ where: { poId: po.poId } })
}

async function stampOf(po: { poId: string }): Promise<Date | null> {
  const { db } = await import('@/lib/db')
  return (await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { fxNoPrepaymentCheckedAt: true } })).fxNoPrepaymentCheckedAt
}

async function activitiesOf(po: { poId: string }, action: string) {
  const { db } = await import('@/lib/db')
  return db.activityLog.findMany({ where: { entityType: 'PURCHASE_ORDER', entityId: po.poId, action }, select: { level: true, description: true } })
}

/** The barrier: a second connection holds the order's row lock until `release`. */
async function holdPoLock(poId: string): Promise<{ pid: number; release: () => Promise<void> }> {
  const { db } = await import('@/lib/db')
  const held = Promise.withResolvers<number>()
  const release = Promise.withResolvers<void>()
  const holder = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    held.resolve(pid)
    await release.promise
  }, { timeout: 60_000, maxWait: 10_000 })
  const settled = holder.then(() => undefined, (error: unknown) => error as unknown)
  const pid = await Promise.race([held.promise, settled.then((error) => { throw error ?? new Error('the lock holder ended before it held the row') })])
  return { pid, release: async () => { release.resolve(); await settled } }
}

/**
 * Proof the window was entered: at least `n` other backends are WAITING on a lock held (directly, or queued behind a waiter that waits for it: Postgres
 * lists a second FOR UPDATE waiter as blocked by the first) by the holder `pid`. `wait_event_type = 'Lock'` is the lock manager's own answer, in this
 * database only, and nothing else in this one-file process waits on a lock.
 */
async function waitBlocked(pid: number, n: number): Promise<number> {
  const { db } = await import('@/lib/db')
  const deadline = Date.now() + 20_000
  let blocked = 0
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> ${pid} AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`
    blocked = Number(rows[0]?.n ?? 0)
    if (blocked >= n) return blocked
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`expected ${n} backends waiting on the row lock held by ${pid}, saw ${blocked}`)
}

async function ageLock(po: { poId: string }, ms: number): Promise<void> {
  const { db } = await import('@/lib/db')
  await db.purchaseOrderFxLock.update({ where: { poId: po.poId }, data: { readAt: new Date(Date.now() - ms) } })
}

test.before(async () => {
  if (!RUN) return
  // The switch reads off until the last step is installed (the interlock); these arms exercise the built steps with it on.
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(true)
  loadEnv()
  await enableStockReceiptPosting()
  await setSetting('xero_realised_fx_gain_loss_account', '4900')
  await setSetting('xero_purchase_price_variance_account', '5050')
  await setSetting(SWITCH, 'false')
})

test.after(async () => {
  if (!RUN || createdCurrencies.length === 0) return
  const { db } = await import('@/lib/db')
  await db.fxRate.deleteMany({ where: { toCurrency: { in: createdCurrencies } } })
  await db.currency.deleteMany({ where: { code: { in: createdCurrencies } } })
})

test.beforeEach(async () => {
  ledger.calls = []
  ledger.answer = () => ({ ok: true, tenantId: TENANT, prepayments: [] })
  contactLedger.calls = 0
  contactLedger.answer = () => ({ success: true, contactId: null })
  if (RUN) {
    const { clearPurchaseFxRefusalMemoryForTests } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
    await clearPurchaseFxRefusalMemoryForTests()
    await setSetting('xero_sync_enabled', 'true')
  }
})

async function onDemand(poId: string) {
  const { readPurchaseOrderXeroPrepayment } = await import('@/app/actions/purchase-orders')
  return readPurchaseOrderXeroPrepayment(poId)
}

// ─── MED-1: a stale unused lock is re-read before the first receipt ─────────────────────────────────────────────

test('MED-1: an unused lock whose prepayment was replaced in Xero is re-read before the first receipt and replaced (voided A, new B: B is used)', SKIP, async () => {
  const po = await seedForeignPo('med1', [8])
  const a = prepaymentFor(po)
  answerWith([[po, [a]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    assert.equal((await lockOf(po))?.xeroPrepaymentId, a.prepaymentId)
    await ageLock(po, HOUR) // older than the freshness window: the first receipt must ask again
    const b = prepaymentFor(po, { currencyRate: new Prisma.Decimal('1.7') })
    answerWith([[po, [b]]])
    ledger.calls = []
    const first = await receive(po, po.lines[0]!, 4)
    assert.equal(first.success, true, first.error)
    assert.equal(ledger.calls.length, 1, 'the unused lock was re-read once')
    const lock = await lockOf(po)
    assert.equal(lock?.xeroPrepaymentId, b.prepaymentId)
    assert.equal(lock?.rateToBase.toString(), '1.7')
    assert.ok(lock?.firstUsedAt)
    assert.deepEqual(await receiptsOf(po), [{ rate: '1.7', source: 'XERO_PREPAYMENT' }])
    // The lock is now used: a second receipt asks nothing, whatever Xero says.
    answerWith([[po, [prepaymentFor(po, { currencyRate: new Prisma.Decimal('1.9') })]]])
    ledger.calls = []
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    assert.equal(ledger.calls.length, 0)
  })
  assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.7', '1.7'])
  assert.equal((await activitiesOf(po, 'xero_prepayment_rate_locked')).length >= 2, true, 'the on-demand lock and the re-read replacement are both in the activity log')
})

test('MED-1: an unused lock whose prepayment was voided in Xero is removed before the first receipt, which falls back to the table rate', SKIP, async () => {
  const po = await seedForeignPo('med1-void', [4])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    await ageLock(po, HOUR)
    answerWith([[po, []]])
    const received = await receive(po, po.lines[0]!, 4)
    assert.equal(received.success, true, received.error)
    assert.equal(await lockOf(po), null, 'the stale lock is gone')
    assert.deepEqual(await receiptsOf(po), [{ rate: '1.4', source: 'FX_TABLE' }])
    assert.equal((await activitiesOf(po, 'xero_prepayment_rate_lock_removed')).length, 1)
  })
})

test('MED-1: a lock read a moment ago is not read again; an unreadable Xero refuses the first receipt and keeps the lock', SKIP, async () => {
  const po = await seedForeignPo('med1-fresh', [8])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    ledger.calls = []
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    assert.equal(ledger.calls.length, 0, 'fresh lock: no re-read')
  })
  const stale = await seedForeignPo('med1-down', [4])
  answerWith([[stale, [prepaymentFor(stale)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(stale.poId)).success, true)
    await ageLock(stale, HOUR)
    ledger.answer = () => ({ ok: false, error: 'HTTP 503' })
    const refused = await receive(stale, stale.lines[0]!, 4)
    assert.equal(refused.success, false)
    assert.match(refused.error ?? '', /Could not read the Xero supplier prepayment/)
    assert.ok(await lockOf(stale), 'the lock is kept')
    assert.deepEqual(await layersOf(stale), [])
  })
})

test('MED-1 + LOW-1 CONCURRENT: two parallel first receipts of an order with a stale unused lock both wait on the order lock, then both value the goods at the re-read prepayment; one lock row, no unique violation', SKIP, async () => {
  const po = await seedForeignPo('med1-par', [8])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    await ageLock(po, HOUR)
    const b = prepaymentFor(po, { currencyRate: new Prisma.Decimal('1.7') })
    answerWith([[po, [b]]])
    const holder = await holdPoLock(po.poId)
    let results: Array<{ success: boolean; error?: string }>
    try {
      const inFlight = [receive(po, po.lines[0]!, 4), receive(po, po.lines[0]!, 4)]
      for (const p of inFlight) p.catch(() => {})
      assert.equal(await waitBlocked(holder.pid, 2) >= 2, true, 'both receipts really wait for the order lock')
      await holder.release()
      results = await Promise.all(inFlight)
    } finally {
      await holder.release()
    }
    assert.deepEqual(results.map((r) => r.success), [true, true], JSON.stringify(results))
    const db = (await import('@/lib/db')).db
    assert.equal(await db.purchaseOrderFxLock.count({ where: { poId: po.poId } }), 1)
    assert.equal((await lockOf(po))?.xeroPrepaymentId, b.prepaymentId)
    assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.7', '1.7'])
    assert.deepEqual(await receiptsOf(po), [{ rate: '1.7', source: 'XERO_PREPAYMENT' }, { rate: '1.7', source: 'XERO_PREPAYMENT' }])
  })
})

test('RACE: the on-demand read and a receipt of the same order both wait on the order lock; whichever runs first, the receipt is valued at the lock that stands (never a replaced one)', SKIP, async () => {
  const po = await seedForeignPo('race', [8])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    await ageLock(po, HOUR)
    const b = prepaymentFor(po, { currencyRate: new Prisma.Decimal('1.7') })
    answerWith([[po, [b]]])
    const holder = await holdPoLock(po.poId)
    let outcomes: [Awaited<ReturnType<typeof onDemand>>, Awaited<ReturnType<typeof receive>>]
    try {
      const read = onDemand(po.poId)
      const receipt = receive(po, po.lines[0]!, 4)
      read.catch(() => {})
      receipt.catch(() => {})
      assert.equal(await waitBlocked(holder.pid, 2) >= 2, true, 'the read and the receipt really wait for the order lock')
      await holder.release()
      outcomes = [await read, await receipt]
    } finally {
      await holder.release()
    }
    assert.equal(outcomes[0].success, true, outcomes[0].error)
    assert.equal(outcomes[1].success, true, outcomes[1].error)
    const lock = await lockOf(po)
    assert.ok(lock?.firstUsedAt)
    assert.equal(lock?.rateToBase.toString(), '1.7')
    assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.7'], 'the layer carries exactly the rate of the lock that stands')
  })
})

test('RACE (LOW-1): with NO lock yet, the on-demand create and a receipt\'s lazy lock both wait on the order lock and neither hits a unique violation', SKIP, async () => {
  const po = await seedForeignPo('race-create', [8])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    const holder = await holdPoLock(po.poId)
    let outcomes: [Awaited<ReturnType<typeof onDemand>>, Awaited<ReturnType<typeof receive>>]
    try {
      const read = onDemand(po.poId)
      const receipt = receive(po, po.lines[0]!, 4)
      read.catch(() => {})
      receipt.catch(() => {})
      assert.equal(await waitBlocked(holder.pid, 2) >= 2, true)
      await holder.release()
      outcomes = [await read, await receipt]
    } finally {
      await holder.release()
    }
    assert.equal(outcomes[0].success, true, outcomes[0].error)
    assert.equal(outcomes[1].success, true, outcomes[1].error)
    const { db } = await import('@/lib/db')
    assert.equal(await db.purchaseOrderFxLock.count({ where: { poId: po.poId } }), 1)
    assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.6'])
  })
})

// ─── MED-2: "no prepayment" is cached; align pre-reads only candidates with capacity ────────────────────────────

test('MED-A: a manual receipt always asks Xero; an automatic one relies on a "no prepayment" answer only while it is at most 15 minutes old', SKIP, async () => {
  const po = await seedForeignPo('meda', [12])
  await withSwitch(true, async () => {
    assert.equal((await receive(po, po.lines[0]!, 3)).success, true)
    assert.equal(ledger.calls.length, 1)
    assert.ok(await stampOf(po), 'the order carries the "no prepayment" stamp')
    assert.equal((await receive(po, po.lines[0]!, 3)).success, true)
    assert.equal(ledger.calls.length, 2, 'a manual receipt asks again, whatever the stamp')
    const { preparePurchaseReceiptFx } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
    const fresh = await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })
    assert.equal(ledger.calls.length, 2, 'an automatic receipt trusts a fresh stamp')
    assert.equal(fresh.get(po.poId)?.kind, 'no_prepayment')
    const { db } = await import('@/lib/db')
    await db.$executeRaw`UPDATE purchase_orders SET fx_no_prepayment_checked_at = ${new Date(Date.now() - 16 * 60_000)} WHERE id = ${po.poId}`
    answerWith([[po, [prepaymentFor(po)]]])
    const stale = await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })
    assert.equal(ledger.calls.length, 3, 'a stamp older than 15 minutes is read again before a fallback receipt')
    assert.equal(stale.get(po.poId)?.kind, 'locked', 'the prepayment recorded since is found')
    assert.equal(await stampOf(po), null, 'a found prepayment clears the stamp')
  })
})

test('MED-B: one sweep memo asks about an order once; a refused answer is remembered for automatic receipts and never for a manual one', SKIP, async () => {
  const po = await seedForeignPo('medb', [6])
  const { preparePurchaseReceiptFx, newPurchaseFxSweepMemo } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
  await withSwitch(true, async () => {
    answerWith([[po, [prepaymentFor(po), prepaymentFor(po)]]])
    const memo = newPurchaseFxSweepMemo()
    for (let i = 0; i < 5; i += 1) assert.equal((await preparePurchaseReceiptFx([po.poId], { collectRefusals: true, memo })).get(po.poId)?.kind, 'refused')
    assert.equal(ledger.calls.length, 1, 'five products in one sweep: one read')
    assert.equal((await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })).get(po.poId)?.kind, 'refused')
    assert.equal(ledger.calls.length, 1, 'the next sweep remembers the refusal')
    await assert.rejects(preparePurchaseReceiptFx([po.poId], { cache: 'manual' }))
    assert.equal(ledger.calls.length, 2, 'a manual receipt always asks')
  })
})

test('MED-2: the on-demand read refreshes the cache at once (a prepayment recorded after a fallback receipt is found by "Read from Xero", inside the TTL)', SKIP, async () => {
  const po = await seedForeignPo('med2-refresh', [8])
  await withSwitch(true, async () => {
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true) // fallback, stamps the cache
    answerWith([[po, [prepaymentFor(po)]]])
    const read = await onDemand(po.poId)
    assert.equal(read.success, true, read.error)
    assert.equal(await stampOf(po), null)
    assert.ok(await lockOf(po))
  })
})

test('MED-2: align-up asks Xero only about orders with capacity left (an ASN line with nothing left to expect is not pre-read)', SKIP, async () => {
  const full = await seedForeignPo('med2-full', [6])
  const open = await seedForeignPo('med2-open', [6], { reuse: full })
  await addAsn(full, full.lines[0]!, { expectedQty: 6, viaSnapshot: 6, createdAt: new Date(Date.now() - 3 * 86_400_000) })
  await addAsn(open, open.lines[0]!, { expectedQty: 6 })
  answerWith([[full, [prepaymentFor(full), prepaymentFor(full)]], [open, [prepaymentFor(open)]]])
  const aligned = await withSwitch(true, () => alignUp(open, open.lines[0]!, { delta: 6, imsQty: 0 }))
  assert.equal(aligned.applied, true, aligned.reason)
  assert.deepEqual(ledger.calls, [open.reference], 'the order with no capacity was never asked about')
  assert.deepEqual((await layersOf(open)).map((l) => l.rate), ['1.6'])
})

// ─── MED-3: per-order refusal in the align ──────────────────────────────────────────────────────────────────────

test('MED-3: one order\'s ambiguous prepayment refuses the alignment ONLY if that order is a real candidate; otherwise the other order absorbs it', SKIP, async () => {
  // Arm 1: the ambiguous order is the older ASN and has room: it IS a candidate, so the alignment is refused for it, stock unchanged.
  const bad = await seedForeignPo('med3-bad', [6])
  const good = await seedForeignPo('med3-good', [6], { reuse: bad })
  await addAsn(bad, bad.lines[0]!, { expectedQty: 6, createdAt: new Date(Date.now() - 3 * 86_400_000) })
  await addAsn(good, good.lines[0]!, { expectedQty: 6 })
  answerWith([[bad, [prepaymentFor(bad), prepaymentFor(bad)]], [good, [prepaymentFor(good)]]])
  const refused = await withSwitch(true, () => alignUp(good, good.lines[0]!, { delta: 6, imsQty: 0 }))
  assert.equal(refused.applied, false)
  assert.match(refused.reason, /2 Xero supplier prepayments carry the reference/)
  assert.deepEqual(await layersOf(bad), [])
  assert.deepEqual(await layersOf(good), [])

  // Arm 2: the ambiguous order has NO room (nothing left to expect): not a candidate, so it costs the other order nothing.
  const full = await seedForeignPo('med3-full', [6])
  const room = await seedForeignPo('med3-room', [6], { reuse: full })
  const { db } = await import('@/lib/db')
  await db.purchaseOrderLine.update({ where: { id: full.lines[0]!.poLineId }, data: { qtyReceived: 6 } })
  await addAsn(full, full.lines[0]!, { expectedQty: 6, viaSnapshot: 6, createdAt: new Date(Date.now() - 3 * 86_400_000) })
  await addAsn(room, room.lines[0]!, { expectedQty: 6 })
  answerWith([[full, [prepaymentFor(full), prepaymentFor(full)]], [room, [prepaymentFor(room)]]])
  const applied = await withSwitch(true, () => alignUp(room, room.lines[0]!, { delta: 6, imsQty: 0 }))
  assert.equal(applied.applied, true, applied.reason)
  assert.deepEqual((await layersOf(room)).map((l) => l.rate), ['1.6'])
})

// ─── MED-4: transient refusals wait without counting; real ambiguity counts ─────────────────────────────────────

async function bookInEvent(asn: fixtures.SeededAsn, line: fixtures.SeededLine, expectedQty: number, bookedQty: number) {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: { connector: 'mintsoft', externalEventId: `${uid()}-evt`, externalAsnId: asn.externalAsnId, payload: { asnId: asn.externalAsnId } }, // wms-connector-boundary-ok: test fixture row
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({ externalAsnId: asn.externalAsnId, externalLineId: asn.externalAsnLineId, sourceLineId: line.poLineId, sku: line.sku, expectedQty, bookedQty })
  return {
    eventId: event.id,
    run: () => processBookedInEvent(event.id, { fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }) }),
    row: () => db.wmsInboundReceiptEvent.findUniqueOrThrow({ where: { id: event.id }, select: { processingStatus: true, processingAttempts: true, deadLetteredAt: true, nextRetryAt: true, lastError: true } }),
  }
}

test('MED-4: a book-in refused only because Xero cannot be read (or a table rate is missing) WAITS: ten tries never spend the retry ladder or dead-letter; it books in once Xero answers', SKIP, async () => {
  const po = await seedForeignPo('med4', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const event = await bookInEvent(asn, po.lines[0]!, 5, 5)
  await withSwitch(true, async () => {
    ledger.answer = () => ({ ok: false, error: 'HTTP 429 (day budget spent)' })
    let result: Awaited<ReturnType<typeof event.run>> | undefined
    for (let i = 0; i < 10; i += 1) {
      result = await event.run()
      assert.equal(result.status, 'failed')
    }
    assert.equal((result as { transientFxRefusal?: boolean }).transientFxRefusal, true)
    const row = await event.row()
    assert.equal(row.processingAttempts, 0, 'not one attempt was counted')
    assert.equal(row.deadLetteredAt, null)
    assert.equal(row.processingStatus, 'FAILED_RETRY')
    assert.ok(row.nextRetryAt && row.nextRetryAt.getTime() > Date.now() + 20 * 60_000, 'waits about 30 minutes, like a login refusal')
    assert.match(row.lastError ?? '', /Could not read the Xero supplier prepayment/)
    assert.deepEqual(await layersOf(po), [])
    // Xero answers: the same event books in (once the remembered refusal has lapsed).
    const { clearPurchaseFxRefusalMemoryForTests } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
    await clearPurchaseFxRefusalMemoryForTests()
    answerWith([[po, [prepaymentFor(po)]]])
    assert.equal((await event.run()).status, 'processed')
    assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.6'])
  })
  // MED-C: a currency the exchange-rate feed has NEVER held does not resolve by waiting: it counts.
  const noRate = await seedForeignPo('med4-norate', [5])
  const { db } = await import('@/lib/db')
  await db.fxRate.deleteMany({ where: { toCurrency: noRate.currency } })
  const asn2 = await addAsn(noRate, noRate.lines[0]!, { expectedQty: 5 })
  const event2 = await bookInEvent(asn2, noRate.lines[0]!, 5, 5)
  await withSwitch(true, async () => {
    for (let i = 0; i < 2; i += 1) assert.equal((await event2.run()).status, 'failed')
    const row = await event2.row()
    assert.equal(row.processingAttempts, 2, 'a currency the feed never carried is a counted failure')
    assert.match(row.lastError ?? '', /never held/)
  })
})

test('MED-C: an episode of waits on the purchase rate is capped: the 11th wait counts as a failure with a durable WARNING', SKIP, async () => {
  const po = await seedForeignPo('medc', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const event = await bookInEvent(asn, po.lines[0]!, 5, 5)
  const { clearPurchaseFxRefusalMemoryForTests } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
  await withSwitch(true, async () => {
    ledger.answer = () => ({ ok: false, error: 'HTTP 503' })
    for (let i = 0; i < 10; i += 1) {
      await clearPurchaseFxRefusalMemoryForTests()
      assert.equal((await event.run()).status, 'failed')
    }
    assert.equal((await event.row()).processingAttempts, 0, 'ten waits are free')
    await clearPurchaseFxRefusalMemoryForTests()
    assert.equal((await event.run()).status, 'failed')
    assert.equal((await event.row()).processingAttempts, 1, 'the eleventh counts')
    const { db } = await import('@/lib/db')
    const warnings = await db.activityLog.findMany({ where: { action: 'mintsoft_booked_in_fx_wait_capped', entityId: event.eventId } })
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.level, 'WARNING')
    // Step 3b, MED-6: the capped WARNING is written once per episode, not on every counted retry after it.
    await clearPurchaseFxRefusalMemoryForTests()
    assert.equal((await event.run()).status, 'failed')
    assert.equal((await event.row()).processingAttempts, 2, 'still counting')
    assert.equal(await db.activityLog.count({ where: { action: 'mintsoft_booked_in_fx_wait_capped', entityId: event.eventId } }), 1, 'throttled: no second WARNING')
    // ...and the episode ends once the event gets past the exchange-rate step.
    await clearPurchaseFxRefusalMemoryForTests()
    answerWith([[po, [prepaymentFor(po)]]])
    assert.equal((await event.run()).status, 'processed')
    const done = await db.wmsInboundReceiptEvent.findUniqueOrThrow({ where: { id: event.eventId }, select: { fxWaitCount: true, fxWaitStartedAt: true } })
    assert.deepEqual(done, { fxWaitCount: 0, fxWaitStartedAt: null }, 'the episode is reset')
  })
})

test('MED-6: a failure for another reason ends the episode of waits on the purchase rate', SKIP, async () => {
  const po = await seedForeignPo('med6', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const event = await bookInEvent(asn, po.lines[0]!, 5, 5)
  const { clearPurchaseFxRefusalMemoryForTests } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
  const { db } = await import('@/lib/db')
  await withSwitch(true, async () => {
    ledger.answer = () => ({ ok: false, error: 'HTTP 503' })
    for (let i = 0; i < 3; i += 1) {
      await clearPurchaseFxRefusalMemoryForTests()
      assert.equal((await event.run()).status, 'failed')
    }
    assert.equal((await db.wmsInboundReceiptEvent.findUniqueOrThrow({ where: { id: event.eventId } })).fxWaitCount, 3)
    await clearPurchaseFxRefusalMemoryForTests()
    answerWith([[po, [prepaymentFor(po), prepaymentFor(po)]]]) // real ambiguity: a counted failure, not a wait
    assert.equal((await event.run()).status, 'failed')
    const row = await db.wmsInboundReceiptEvent.findUniqueOrThrow({ where: { id: event.eventId }, select: { fxWaitCount: true, fxWaitStartedAt: true, processingAttempts: true } })
    assert.equal(row.processingAttempts, 1)
    assert.deepEqual({ count: row.fxWaitCount, startedAt: row.fxWaitStartedAt }, { count: 0, startedAt: null }, 'the episode is over: a later wait starts a new one')
  })
})

test('MED-5: the remembered refusal is on the order (every process sees it) and yields to a newer lock', SKIP, async () => {
  const po = await seedForeignPo('med5', [5])
  const { preparePurchaseReceiptFx, clearPurchaseFxRefusalMemoryForTests } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
  const { db } = await import('@/lib/db')
  await clearPurchaseFxRefusalMemoryForTests()
  await withSwitch(true, async () => {
    ledger.answer = () => ({ ok: false, error: 'HTTP 503' })
    const first = await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })
    assert.equal(first.get(po.poId)?.kind, 'refused')
    const stored = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { fxPrepaymentRefusedAt: true, fxPrepaymentRefusedTransient: true } })
    assert.ok(stored.fxPrepaymentRefusedAt, 'remembered in the database, not in process memory')
    assert.equal(stored.fxPrepaymentRefusedTransient, true)
    ledger.calls = []
    answerWith([[po, [prepaymentFor(po)]]])
    assert.equal((await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })).get(po.poId)?.kind, 'refused', 'inside the window: not asked again')
    assert.equal(ledger.calls.length, 0)
    // An operator reads the prepayment (a newer lock): the remembered refusal no longer stands.
    await onDemand(po.poId)
    assert.equal((await preparePurchaseReceiptFx([po.poId], { collectRefusals: true })).get(po.poId)?.kind, 'locked')
    const cleared = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { fxPrepaymentRefusedAt: true } })
    assert.equal(cleared.fxPrepaymentRefusedAt, null, 'and it is forgotten')
  })
})

test('MED-4: REAL ambiguity (two prepayments for one order) still counts toward the ladder', SKIP, async () => {
  const po = await seedForeignPo('med4-amb', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const event = await bookInEvent(asn, po.lines[0]!, 5, 5)
  answerWith([[po, [prepaymentFor(po), prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await event.run()).status, 'failed')
  })
  const row = await event.row()
  assert.equal(row.processingAttempts, 3, 'ambiguity is a counted failure')
  assert.match(row.lastError ?? '', /2 Xero supplier prepayments/)
  assert.deepEqual(await layersOf(po), [])
})

// ─── MED-5: the table-rate fallback is reported ─────────────────────────────────────────────────────────────────

test('MED-5: a receipt that falls back to the table rate while Xero sync is on returns a warning and writes a WARNING activity entry; with Xero sync off it does neither', SKIP, async () => {
  const po = await seedForeignPo('med5', [8])
  const received = await withSwitch(true, () => receive(po, po.lines[0]!, 4))
  assert.equal(received.success, true, received.error)
  assert.equal(received.warnings?.some((w) => /exchange-rate table rate/.test(w) && w.includes(po.reference)), true, JSON.stringify(received.warnings))
  const entries = await activitiesOf(po, 'purchase_receipt_fx_table_rate')
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.level, 'WARNING')
  assert.match(entries[0]!.description, /LATER receipts only/)

  const quiet = await seedForeignPo('med5-off', [4])
  await setSetting('xero_sync_enabled', 'false')
  const okReceipt = await withSwitch(true, () => receive(quiet, quiet.lines[0]!, 4))
  assert.equal(okReceipt.success, true, okReceipt.error)
  assert.equal(okReceipt.warnings, undefined)
  assert.equal((await activitiesOf(quiet, 'purchase_receipt_fx_table_rate')).length, 0)
  // A receipt at a prepayment rate carries no such warning.
  await setSetting('xero_sync_enabled', 'true')
  const paid = await seedForeignPo('med5-paid', [4])
  answerWith([[paid, [prepaymentFor(paid)]]])
  const okPaid = await withSwitch(true, () => receive(paid, paid.lines[0]!, 4))
  assert.equal(okPaid.warnings, undefined)
})

test('MED-5: the WMS book-in and align-up that fall back to the table rate write the activity entry', SKIP, async () => {
  const po = await seedForeignPo('med5-wms', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const event = await bookInEvent(asn, po.lines[0]!, 5, 5)
  assert.equal((await withSwitch(true, () => event.run())).status, 'processed')
  assert.equal((await activitiesOf(po, 'purchase_receipt_fx_table_rate')).length, 1)
  const aligned = await seedForeignPo('med5-align', [6])
  await addAsn(aligned, aligned.lines[0]!, { expectedQty: 6 })
  assert.equal((await withSwitch(true, () => alignUp(aligned, aligned.lines[0]!, { delta: 6, imsQty: 0 }))).applied, true)
  assert.equal((await activitiesOf(aligned, 'purchase_receipt_fx_table_rate')).length, 1)
})

// ─── MED-6: the supplier contact link ───────────────────────────────────────────────────────────────────────────

test('MED-6: an unlinked supplier is confirmed through the read-only Xero contact lookup when it is the contact the prepayment was paid to, and the link is stored; otherwise the receipt is refused with the right remedy', SKIP, async () => {
  const { db } = await import('@/lib/db')
  // Confirmed: the lookup returns the prepayment's own contact.
  const po = await seedForeignPo('med6-ok', [4], { link: false })
  answerWith([[po, [prepaymentFor(po)]]])
  contactLedger.answer = () => ({ success: true, contactId: po.contactId, tenantId: TENANT })
  const ok = await withSwitch(true, () => receive(po, po.lines[0]!, 4))
  assert.equal(ok.success, true, ok.error)
  assert.equal(contactLedger.calls, 1)
  assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.6'])
  const supplier = await db.supplier.findFirstOrThrow({ where: { purchaseOrders: { some: { id: po.poId } } }, select: { accountingContactId: true, accountingContactProvenance: true } })
  assert.equal(supplier.accountingContactId, po.contactId)
  assert.equal(supplier.accountingContactProvenance, `xero:${TENANT}`)

  // A DIFFERENT contact: refused as a contact mismatch, nothing stored.
  const other = await seedForeignPo('med6-other', [4], { link: false })
  answerWith([[other, [prepaymentFor(other)]]])
  contactLedger.answer = () => ({ success: true, contactId: 'someone-else', tenantId: TENANT })
  const mismatch = await withSwitch(true, () => receive(other, other.lines[0]!, 4))
  assert.equal(mismatch.success, false)
  assert.match(mismatch.error ?? '', /different contact/)
  assert.deepEqual(await layersOf(other), [])

  // NO contact found: refused with the corrected remedy (no screen sets the link).
  const none = await seedForeignPo('med6-none', [4], { link: false })
  answerWith([[none, [prepaymentFor(none)]]])
  contactLedger.answer = () => ({ success: true, contactId: null })
  const missing = await withSwitch(true, () => receive(none, none.lines[0]!, 4))
  assert.equal(missing.success, false)
  assert.match(missing.error ?? '', /not linked to a Xero contact of this organisation/)
  assert.match(missing.error ?? '', /make the Xero contact's name \(or email\) exactly/)
  assert.doesNotMatch(missing.error ?? '', /or set the contact/)

  // The contact read FAILS: a transient refusal, never read as "no contact".
  const down = await seedForeignPo('med6-down', [4], { link: false })
  answerWith([[down, [prepaymentFor(down)]]])
  contactLedger.answer = () => ({ success: false, error: 'HTTP 503' })
  const failed = await withSwitch(true, () => receive(down, down.lines[0]!, 4))
  assert.equal(failed.success, false)
  assert.match(failed.error ?? '', /supplier's Xero contact could not be read/)
})

// ─── MED-7: a prepayment recorded after earlier receipts applies to LATER receipts only ─────────────────────────

test('MED-7: earlier receipts keep the table rate, later ones take the prepayment rate; the card shows the rate of every receipt and "N receipts at the table rate"', SKIP, async () => {
  const po = await seedForeignPo('med7', [12])
  await withSwitch(true, async () => {
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    // The owner records the prepayment now; "Read from Xero" locks it for the LATER receipts.
    answerWith([[po, [prepaymentFor(po)]]])
    const read = await onDemand(po.poId)
    assert.equal(read.success, true, read.error)
    assert.equal(read.result?.status === 'locked' ? read.result.earlierTableRateReceipts : -1, 2)
    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    const { getPurchaseOrderFxView } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
    const view = await getPurchaseOrderFxView(po.poId)
    assert.deepEqual(view.receipts.map((r) => [r.rateToBase, r.source]), [['1.4', 'FX_TABLE'], ['1.4', 'FX_TABLE'], ['1.6', 'XERO_PREPAYMENT']])
    assert.equal(view.tableRateReceiptCount, 2)
    assert.equal(view.prepaymentReceiptCount, 1)
    assert.equal(view.lock?.used, true)
  })
  // Nothing was revalued: the first two layers still carry the table rate.
  assert.deepEqual((await layersOf(po)).map((l) => l.rate), ['1.4', '1.4', '1.6'])
  const logged = await activitiesOf(po, 'xero_prepayment_rate_locked')
  assert.equal(logged.some((a) => /2 earlier receipt\(s\) keep the exchange-rate table rate/.test(a.description)), true)
})

// ─── LOW-8 / LOW-9 / LOW-11 ─────────────────────────────────────────────────────────────────────────────────────

test('LOW-8: a refusal before the receipt starts is activity-logged; a retry with the idempotency token of a receipt that already committed asks Xero nothing and reports success', SKIP, async () => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedForeignPo('low8', [8])
  answerWith([[po, [prepaymentFor(po), prepaymentFor(po)]]])
  const refused = await withSwitch(true, () => receive(po, po.lines[0]!, 4))
  assert.equal(refused.success, false)
  assert.equal((await activitiesOf(po, 'purchase_receipt_fx_refused')).length, 1)

  const ok = await seedForeignPo('low8-ok', [8])
  answerWith([[ok, [prepaymentFor(ok)]]])
  const token = `tok-${uid()}`
  const lines = [{ poLineId: ok.lines[0]!.poLineId, qtyReceived: 4, warehouseId: ok.warehouseId }]
  await withSwitch(true, async () => {
    assert.equal((await receivePurchaseOrder(ok.poId, lines, undefined, { idempotencyToken: token })).success, true)
    ledger.calls = []
    ledger.answer = () => ({ ok: false, error: 'HTTP 503' })
    const retry = await receivePurchaseOrder(ok.poId, lines, undefined, { idempotencyToken: token })
    assert.equal(retry.success, true, retry.error)
    assert.equal(ledger.calls.length, 0, 'the retry of a committed receipt reads nothing from Xero')
  })
  assert.equal((await receiptsOf(ok)).length, 1, 'and books nothing twice')
})

test('LOW-11: the lock is marked used only when goods are laid at its rate, not when a valuation is merely computed', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { resolveReceiptFxValuation, markPurchaseFxLockUsed } = await import('@/lib/domain/purchasing/purchase-receipt-fx')
  const po = await seedForeignPo('low11', [4])
  answerWith([[po, [prepaymentFor(po)]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.poId} FOR UPDATE`
      const valuation = await resolveReceiptFxValuation(tx, { poId: po.poId, at: new Date(), checks: new Map() })
      assert.ok(valuation?.lockId)
      assert.equal((await tx.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.poId } })).firstUsedAt, null, 'computing a valuation uses nothing up')
      await markPurchaseFxLockUsed(tx, valuation, new Date('2026-11-26T10:00:00Z'))
      await markPurchaseFxLockUsed(tx, valuation, new Date('2026-11-27T10:00:00Z')) // idempotent: the first instant stands
      await markPurchaseFxLockUsed(tx, null, new Date())
    })
  })
  assert.equal((await lockOf(po))?.firstUsedAt?.toISOString(), '2026-11-26T10:00:00.000Z')
})

// [mutation: drop the total check; warn within the rounding tolerance; warn on every re-read of the same prepayment; let the warning change the lock]
test('LOW-2: a prepayment whose total is not the order\'s totalForeign is locked all the same, with ONE WARNING activity; a rounding difference and a re-read of the same prepayment warn nothing', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedForeignPo('low2', [4])
  const total = (await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { totalForeign: true } })).totalForeign
  const exact = prepaymentFor(po, { total: new Prisma.Decimal(total).plus('0.005') })
  answerWith([[po, [exact]]])
  await withSwitch(true, async () => {
    assert.equal((await onDemand(po.poId)).success, true)
    assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 0, 'within the rounding tolerance')
    // Replaced in Xero by a deposit of half the order: locked from it (same rate rule), and warned once.
    const deposit = prepaymentFor(po, { total: new Prisma.Decimal(total).div(2).toDecimalPlaces(2) })
    answerWith([[po, [deposit]]])
    assert.equal((await onDemand(po.poId)).success, true)
    const lock = await lockOf(po)
    assert.equal(lock?.xeroPrepaymentId, deposit.prepaymentId)
    assert.equal(lock?.rateToBase.toString(), '1.6', 'the warning changes nothing')
    const warned = await activitiesOf(po, 'xero_prepayment_total_mismatch')
    assert.equal(warned.length, 1)
    assert.equal(warned[0]!.level, 'WARNING')
    assert.match(warned[0]!.description, new RegExp(`${deposit.prepaymentId}.*but the order says`))
    // A re-read of the same prepayment (and the receipt it values) warns nothing more.
    assert.equal((await onDemand(po.poId)).success, true)
    const received = await receive(po, po.lines[0]!, 4)
    assert.equal(received.success, true, received.error)
    assert.deepEqual(await receiptsOf(po), [{ rate: '1.6', source: 'XERO_PREPAYMENT' }])
    assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 1)
  })
})

// [mutation: skip the warning on the create branch; skip it when only the total of the same prepayment changes]
test('#1173 LOW-2: the FIRST lock of a fresh order with a mismatch writes exactly one WARNING; the same prepayment id with a changed total warns again', SKIP, async () => {
  const po = await seedForeignPo('low2-first', [4])
  const first = prepaymentFor(po, { total: new Prisma.Decimal('1') })
  answerWith([[po, [first]]])
  await withSwitch(true, async () => {
    assert.equal(await lockOf(po), null)
    assert.equal((await onDemand(po.poId)).success, true)
    assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 1, 'the create branch warns once')
    answerWith([[po, [{ ...first, total: new Prisma.Decimal('2') }]]])
    assert.equal((await onDemand(po.poId)).success, true)
    assert.equal((await lockOf(po))?.prepaymentTotal.toString(), '2')
    assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 2, 'same id, changed total: warned again')
  })
})

// [mutation: compare the prepayment with totalForeign (gross of self-accounted VAT)]
test('#1173 MED-1: a reverse-charge supplier whose prepayment is the NET payable (no self-accounted VAT) is not warned; one paying the gross is', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedForeignPo('rc', [4])
  const rate = await db.taxRate.create({ data: { name: `rc-${uid()}`, rate: '0.2', usedFor: 'PURCHASE', reverseCharge: true, reportingCategory: 'REVERSE_CHARGE' } })
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { supplierId: true, subtotalForeign: true, lines: { select: { id: true, totalForeign: true } } } })
  await db.purchaseOrderLine.updateMany({ where: { poId: po.poId }, data: { taxRateId: rate.id } })
  await db.supplier.update({ where: { id: row.supplierId }, data: { taxRateId: rate.id } })
  await db.freightCostLine.create({ data: { poId: po.poId, description: 'freight', amountForeign: '10', amountBase: '10', vatable: true } })
  const net = new Prisma.Decimal(row.subtotalForeign).plus(10)
  const vat = row.lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.totalForeign).mul('0.2')), new Prisma.Decimal(0)).plus(2)
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { taxRatePercent: '0.2', taxForeign: vat, directFreightForeign: '10', totalForeign: net.plus(vat) } })
  try {
    answerWith([[po, [prepaymentFor(po, { total: net })]]])
    await withSwitch(true, async () => {
      assert.equal((await onDemand(po.poId)).success, true)
      assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 0, 'the net payable is what the supplier is paid')
      answerWith([[po, [prepaymentFor(po, { total: net.plus(vat) })]]])
      assert.equal((await onDemand(po.poId)).success, true)
      assert.equal((await activitiesOf(po, 'xero_prepayment_total_mismatch')).length, 1, 'the gross (with self-accounted VAT) is not')
    })
  } finally {
    await db.supplier.update({ where: { id: row.supplierId }, data: { taxRateId: null } })
  }
})

test('OFF: everything above is inert while the switch is off (no Xero read, no stamp, no lock, no warning)', SKIP, async () => {
  const po = await seedForeignPo('off', [4])
  answerWith([[po, [prepaymentFor(po)]]])
  const received = await receive(po, po.lines[0]!, 4)
  assert.equal(received.success, true)
  assert.equal(received.warnings, undefined)
  assert.equal(ledger.calls.length, 0)
  assert.equal(contactLedger.calls, 0)
  assert.equal(await stampOf(po), null)
  assert.equal(await lockOf(po), null)
  assert.deepEqual(await receiptsOf(po), [{ rate: null, source: null }])
})
