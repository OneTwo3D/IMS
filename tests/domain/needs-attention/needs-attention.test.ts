import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { ROLES } from '@/lib/permissions'
import {
  buildNeedsAttentionView,
  categoriesForRole,
  NEEDS_ATTENTION_CATEGORIES,
} from '@/lib/domain/needs-attention/categories'
import { countsFromSnapshot, createNeedsAttentionLoader, type InboxSummarySlice } from '@/lib/domain/needs-attention/counts'
import {
  ANNOUNCE_SPECS,
  announceNeedsAttention,
  type AnnounceDeps,
} from '@/lib/domain/needs-attention/announce'
import { createTtlCache } from '@/lib/domain/needs-attention/ttl-cache'
import type { SourceDeps } from '@/lib/domain/needs-attention/sources'

// ---- fakes -------------------------------------------------------------------------------------

type Rows = {
  push: string[]
  parks: string[]
  failed: string[]
  reviews: string[]
  discrepancies: string[]
}

type Notif = { userId: string; title: string; message: string; actionUrl: string }

function makeDb(rows: Rows, announcements = new Set<string>(), calls = { counts: 0 }) {
  const notifications: Notif[] = []
  let lock: Promise<void> = Promise.resolve()
  const failures = { notificationInsert: 0 }
  // The fake does not evaluate the real WHERE; it honours only the id filters the announcer adds.
  const list = (ids: string[]) => async (args: { where?: { AND?: Array<{ id?: { in?: string[]; gt?: string } }> }; take?: number }) => {
    const idFilter = args.where?.AND?.[1]?.id
    let out = [...ids].sort()
    if (idFilter?.in) out = out.filter((id) => idFilter.in!.includes(id))
    if (idFilter?.gt !== undefined) out = out.filter((id) => id > idFilter.gt!)
    return (args.take === undefined ? out : out.slice(0, args.take)).map((id) => ({ id }))
  }
  const count = (ids: string[]) => async () => { calls.counts += 1; return ids.length }
  const key = (category: string, sourceId: string) => `${category}|${sourceId}`
  const announcementApi = (store: Set<string>) => ({
    async findMany({ where, take }: { where: { category: string; sourceId: { in?: string[]; gt?: string } }; take?: number }) {
      let ids = [...store].filter((k) => k.startsWith(`${where.category}|`)).map((k) => k.slice(where.category.length + 1)).sort()
      if (where.sourceId.in) ids = ids.filter((id) => where.sourceId.in!.includes(id))
      if (where.sourceId.gt !== undefined) ids = ids.filter((id) => id > where.sourceId.gt!)
      return (take === undefined ? ids : ids.slice(0, take)).map((sourceId) => ({ sourceId }))
    },
    async deleteMany({ where }: { where: { category: string; sourceId: { in: string[] } } }) {
      let n = 0
      for (const id of where.sourceId.in) if (store.delete(key(where.category, id))) n += 1
      return { count: n }
    },
    async createManyAndReturn({ data }: { data: Array<{ category: string; sourceId: string }> }) {
      const inserted: Array<{ sourceId: string }> = []
      for (const row of data) {
        const k = key(row.category, row.sourceId)
        if (!store.has(k)) { store.add(k); inserted.push({ sourceId: row.sourceId }) }
      }
      return inserted
    },
  })
  const users = [
    { id: 'admin', role: 'ADMIN' },
    { id: 'manager', role: 'MANAGER' },
    { id: 'wh', role: 'WAREHOUSE' },
    { id: 'ro', role: 'READONLY' },
    { id: 'sup', role: 'SUPPLIER' },
  ]
  async function run<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const staged = new Set(announcements)
    const stagedNotifications: Notif[] = []
    const tx = {
      needsAttentionAnnouncement: announcementApi(staged),
      user: { async findMany() { return users } },
      notification: {
        async createMany({ data }: { data: Notif[] }) {
          if (failures.notificationInsert > 0) { failures.notificationInsert -= 1; throw new Error('insert failed') }
          stagedNotifications.push(...data)
          return { count: data.length }
        },
      },
    }
    const result = await fn(tx)
    announcements.clear()
    for (const k of staged) announcements.add(k)
    notifications.push(...stagedNotifications)
    return result
  }
  return {
    announcements,
    notifications,
    failures,
    calls,
    db: {
      wmsOrderPushLink: { count: count(rows.push), findMany: list(rows.push) },
      shoppingSyncLog: { findMany: list(rows.parks) },
      accountingSyncLog: { count: count(rows.failed), findMany: list(rows.failed) },
      wmsInboundReceiptEvent: { count: count(rows.reviews), findMany: list(rows.reviews) },
      wmsStockDiscrepancy: { count: count(rows.discrepancies), findMany: list(rows.discrepancies) },
      needsAttentionAnnouncement: announcementApi(announcements),
      // Interactive transaction with rollback semantics (writes land only if the callback resolves),
      // serialised to model the lock a unique-key insert takes.
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const turn = lock
        let release!: () => void
        lock = new Promise<void>((resolve) => { release = resolve })
        await turn
        try { return await run(fn) } finally { release() }
      },
    },
  }
}

const emptyRows = (): Rows => ({ push: [], parks: [], failed: [], reviews: [], discrepancies: [] })

function announceHarness(rows: Rows, connector: string | null = 'xero') {
  const fake = makeDb(rows)
  const deps = {
    db: fake.db,
    activeAccountingConnector: async () => connector,
    activeWmsConnector: async () => 'wms-a',
  } as unknown as AnnounceDeps
  return { deps, sent: fake.notifications, announcements: fake.announcements, fake }
}

// ---- count loader ------------------------------------------------------------------------------

test('countsFromSnapshot maps every category and never double-counts the inbox total', () => {
  const counts = countsFromSnapshot({
    inbox: { total: 20, wmsPushDeadLetters: 3, stuckDispatches: 2, refundSyncParks: 4, wmsOperatorTasksOpen: 1 },
    nonInbox: { failedAccounting: 5, receiptReviews: 6, stockDiscrepancies: 7 },
  })
  assert.deepEqual(counts, {
    wmsPushBlocked: 3,
    dispatchDeadLetters: 2,
    refundParks: 4,
    operatorTasks: 1,
    otherExceptions: 10, // 20 - (3 + 2 + 4 + 1)
    failedAccounting: 5,
    receiptReviews: 6,
    stockDiscrepancies: 7,
  })
})

test('countsFromSnapshot clamps a negative remainder to zero and tolerates no inbox', () => {
  assert.equal(
    countsFromSnapshot({
      inbox: { total: 1, wmsPushDeadLetters: 3, stuckDispatches: 0, refundSyncParks: 0, wmsOperatorTasksOpen: 0 },
      nonInbox: { failedAccounting: 0, receiptReviews: 0, stockDiscrepancies: 0 },
    }).otherExceptions,
    0,
  )
  const none = countsFromSnapshot({ inbox: null, nonInbox: { failedAccounting: 2, receiptReviews: 0, stockDiscrepancies: 0 } })
  assert.equal(none.wmsPushBlocked, 0)
  assert.equal(none.failedAccounting, 2)
})

const INBOX: InboxSummarySlice = { total: 9, wmsPushDeadLetters: 3, stuckDispatches: 0, refundSyncParks: 2, wmsOperatorTasksOpen: 0 }

test('loader: counts per category come from the real sources (failed accounting is active-connector scoped)', async () => {
  const fake = makeDb({ ...emptyRows(), failed: ['a', 'b'], reviews: ['r'], discrepancies: ['d1', 'd2', 'd3'] })
  const loader = createNeedsAttentionLoader({
    sources: { db: fake.db, activeAccountingConnector: async () => 'xero', activeWmsConnector: async () => 'wms-a' } as unknown as SourceDeps,
    ttlMs: 60_000,
  })
  const view = await loader.loadView('ADMIN', async () => INBOX)
  const byKey = Object.fromEntries(view.rows.map((r) => [r.key, r.count]))
  assert.equal(byKey.failedAccounting, 2)
  assert.equal(byKey.receiptReviews, 1)
  assert.equal(byKey.stockDiscrepancies, 3)
  assert.equal(byKey.wmsPushBlocked, 3)
  assert.equal(byKey.otherExceptions, 4)
  assert.equal(view.total, 2 + 1 + 3 + 9)
})

test('loader: no active accounting connector means no failed-accounting count', async () => {
  const fake = makeDb({ ...emptyRows(), failed: ['a'] })
  const loader = createNeedsAttentionLoader({
    sources: { db: fake.db, activeAccountingConnector: async () => null, activeWmsConnector: async () => 'wms-a' } as unknown as SourceDeps,
    ttlMs: 60_000,
  })
  const view = await loader.loadView('ADMIN', async () => ({ ...INBOX, total: 0, wmsPushDeadLetters: 0, refundSyncParks: 0 }))
  assert.equal(view.rows.some((r) => r.key === 'failedAccounting'), false)
})

test('loader: counts are cached within the TTL (one query set for many page loads) and refreshed after it', async () => {
  const fake = makeDb({ ...emptyRows(), failed: ['a'] })
  let clock = 1_000
  let inboxLoads = 0
  const loader = createNeedsAttentionLoader({
    sources: { db: fake.db, activeAccountingConnector: async () => 'xero', activeWmsConnector: async () => 'wms-a' } as unknown as SourceDeps,
    ttlMs: 60_000,
    now: () => clock,
  })
  const loadInbox = async () => { inboxLoads += 1; return INBOX }
  await Promise.all([loader.loadView('ADMIN', loadInbox), loader.loadView('MANAGER', loadInbox), loader.loadView('ADMIN', loadInbox)])
  await loader.loadView('ADMIN', loadInbox)
  assert.equal(inboxLoads, 1)
  assert.equal(fake.calls.counts, 3, 'three non-inbox counts, once')
  clock += 61_000
  await loader.loadView('ADMIN', loadInbox)
  assert.equal(inboxLoads, 2)
  assert.equal(fake.calls.counts, 6)
})

test('ttl cache: a failed load is not cached', async () => {
  let n = 0
  const cache = createTtlCache(async () => { n += 1; if (n === 1) throw new Error('boom'); return n }, 60_000)
  await assert.rejects(() => cache.get())
  assert.equal(await cache.get(), 2)
})

// ---- permission filtering ----------------------------------------------------------------------

test('permissions: a role sees only categories it may act on, and the total covers only those', () => {
  const counts = { wmsPushBlocked: 1, dispatchDeadLetters: 1, refundParks: 1, operatorTasks: 1, otherExceptions: 1, failedAccounting: 1, receiptReviews: 1, stockDiscrepancies: 1 }
  const admin = buildNeedsAttentionView(counts, 'ADMIN')
  assert.equal(admin.rows.length, 8)
  assert.equal(admin.total, 8)

  const manager = buildNeedsAttentionView(counts, 'MANAGER')
  assert.equal(manager.rows.some((r) => r.key === 'receiptReviews'), false, 'receipt approval is admin-only')
  assert.equal(manager.total, 7)

  for (const role of ['WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    assert.deepEqual(buildNeedsAttentionView(counts, role), { rows: [], total: 0 }, role)
  }
})

test('permissions: every role resolves, and zero-count categories are omitted', () => {
  for (const role of ROLES) assert.ok(Array.isArray(categoriesForRole(role)))
  assert.deepEqual(buildNeedsAttentionView({ failedAccounting: 0 }, 'ADMIN'), { rows: [], total: 0 })
})

test('permissions: a role without sync never triggers the inbox summary', async () => {
  const fake = makeDb(emptyRows())
  const loader = createNeedsAttentionLoader({
    sources: { db: fake.db, activeAccountingConnector: async () => 'xero', activeWmsConnector: async () => 'wms-a' } as unknown as SourceDeps,
    ttlMs: 60_000,
  })
  let inboxLoads = 0
  const view = await loader.loadView('WAREHOUSE', async () => { inboxLoads += 1; return INBOX })
  assert.equal(inboxLoads, 0)
  assert.equal(fake.calls.counts, 0, 'and none of the other counts run either')
  assert.deepEqual(view, { rows: [], total: 0 })
})

// ---- notification dedupe -----------------------------------------------------------------------

test('announce: first sight notifies once per category; an unchanged set notifies nothing', async () => {
  const { deps, sent } = announceHarness({ ...emptyRows(), push: ['p1', 'p2'], parks: ['k1'] })
  const first = await announceNeedsAttention(deps)
  assert.deepEqual(first.announced.sort(), ['refundParks', 'wmsPushBlocked'])
  assert.equal(new Set(sent.map((n) => n.title)).size, 2)
  assert.equal(sent.filter((n) => n.userId === 'admin' && n.title === 'Warehouse order push blocked').length, 1, 'one notification for two new rows')

  const before = sent.length
  const second = await announceNeedsAttention(deps)
  assert.deepEqual(second.announced, [])
  assert.equal(sent.length, before, 'the same items never notify twice')
})

test('announce: a NEW item notifies, naming only the new one; old items stay quiet', async () => {
  const rows = { ...emptyRows(), failed: ['f1'] }
  const { deps, sent } = announceHarness(rows)
  await announceNeedsAttention(deps)
  sent.length = 0
  rows.failed.push('f2')
  const result = await announceNeedsAttention(deps)
  assert.deepEqual(result.announced, ['failedAccounting'])
  const adminMsg = sent.filter((n) => n.userId === 'admin')
  assert.equal(adminMsg.length, 1)
  assert.match(adminMsg[0].message, /^1 accounting sync row failed/)
})

test('announce: a cleared item is forgotten, so the same item failing again is announced again', async () => {
  const rows = { ...emptyRows(), reviews: ['e1'] }
  const { deps, sent } = announceHarness(rows)
  await announceNeedsAttention(deps)
  rows.reviews.length = 0
  await announceNeedsAttention(deps) // clears the stored set
  sent.length = 0
  rows.reviews.push('e1')
  const result = await announceNeedsAttention(deps)
  assert.deepEqual(result.announced, ['receiptReviews'])
  assert.ok(sent.length > 0)
})

test('announce: recipients are limited to roles holding the category permission', async () => {
  const { deps, sent } = announceHarness({ ...emptyRows(), reviews: ['e1'], push: ['p1'] })
  await announceNeedsAttention(deps)
  assert.deepEqual(sent.filter((n) => n.title === 'Warehouse receipt paused for review').map((n) => n.userId), ['admin'])
  assert.deepEqual(sent.filter((n) => n.title === 'Warehouse order push blocked').map((n) => n.userId).sort(), ['admin', 'manager'])
})

test('announce: no storm under concurrent passes', async () => {
  const { deps, sent } = announceHarness({ ...emptyRows(), discrepancies: ['d1'], push: ['p1'] })
  await Promise.all([announceNeedsAttention(deps), announceNeedsAttention(deps), announceNeedsAttention(deps)])
  assert.equal(sent.filter((n) => n.userId === 'admin' && n.title === 'Stock discrepancy opened').length, 1)
  assert.equal(sent.filter((n) => n.userId === 'admin' && n.title === 'Warehouse order push blocked').length, 1)
})

test('announce: a failure after the claim rolls the claim back and the next pass retries', async () => {
  const { deps, sent, announcements, fake } = announceHarness({ ...emptyRows(), push: ['p1'] })
  fake.failures.notificationInsert = 1
  const first = await announceNeedsAttention(deps)
  assert.deepEqual(first.failed, ['wmsPushBlocked'])
  assert.equal(sent.length, 0)
  assert.equal(announcements.size, 0, 'nothing was marked announced')
  const second = await announceNeedsAttention(deps)
  assert.deepEqual(second.announced, ['wmsPushBlocked'])
  assert.deepEqual(sent.map((n) => n.userId).sort(), ['admin', 'manager'])
})

test('announce: a partial insert failure writes no recipient and the retry reaches every recipient', async () => {
  const { deps, sent, fake } = announceHarness({ ...emptyRows(), parks: ['k1'] })
  fake.failures.notificationInsert = 1
  await announceNeedsAttention(deps)
  assert.equal(sent.length, 0, 'no recipient is marked notified by a failed attempt')
  await announceNeedsAttention(deps)
  assert.deepEqual(sent.map((n) => n.userId).sort(), ['admin', 'manager'])
})

test('announce: with no eligible recipient nothing is claimed, so rows are announced once someone exists', async () => {
  const rows = { ...emptyRows(), reviews: ['e1'] }
  const { deps, sent, announcements, fake } = announceHarness(rows)
  const realDb = fake.db as unknown as { $transaction: (fn: (tx: { user: unknown }) => Promise<unknown>) => Promise<unknown> }
  const original = realDb.$transaction.bind(realDb)
  let empty = true
  realDb.$transaction = (fn) => original((tx) => fn(empty ? { ...(tx as object), user: { findMany: async () => [] } } as { user: unknown } : tx))
  await announceNeedsAttention(deps)
  assert.equal(announcements.size, 0)
  empty = false
  const result = await announceNeedsAttention(deps)
  assert.deepEqual(result.announced, ['receiptReviews'])
  assert.deepEqual(sent.map((n) => n.userId), ['admin'])
})

test('announce: every row is announced over successive passes in batches of 200', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `a${String(i).padStart(4, '0')}`)
  const rows = { ...emptyRows(), failed: [...ids] }
  const { deps, sent } = announceHarness(rows)
  await announceNeedsAttention(deps)
  assert.match(sent.find((n) => n.userId === 'admin')!.message, /^200\+ accounting sync rows failed/)
  sent.length = 0
  await announceNeedsAttention(deps)
  assert.match(sent.find((n) => n.userId === 'admin')!.message, /^50 accounting sync rows failed/)
  sent.length = 0
  await announceNeedsAttention(deps)
  assert.equal(sent.length, 0, 'nothing left unannounced')
})

test('announce: 5,001 open items already announced do not block a new failure (no cap)', async () => {
  const ids = Array.from({ length: 5001 }, (_, i) => `a${String(i).padStart(5, '0')}`)
  const rows = { ...emptyRows(), failed: [...ids] }
  const { deps, sent, announcements } = announceHarness(rows)
  for (let i = 0; i < 27; i += 1) await announceNeedsAttention(deps) // 5,001 rows / 200 per pass
  assert.equal(announcements.size, 5001)
  sent.length = 0
  rows.failed.push('zzzzz-new')
  const result = await announceNeedsAttention(deps)
  assert.deepEqual(result.announced, ['failedAccounting'])
  const adminMsg = sent.filter((n) => n.userId === 'admin')
  assert.equal(adminMsg.length, 1)
  assert.match(adminMsg[0].message, /^1 accounting sync row failed/)
  assert.equal(announcements.size, 5002)
})

test('announce: dispatch dead-letters are not re-announced (the sweep already bells them)', () => {
  assert.equal(ANNOUNCE_SPECS.some((s) => (s.key as string) === 'dispatchDeadLetters'), false)
  assert.deepEqual(ANNOUNCE_SPECS.map((s) => s.key).sort(), ['failedAccounting', 'receiptReviews', 'refundParks', 'stockDiscrepancies', 'wmsPushBlocked'])
})

// ---- links -------------------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..')

function routeFile(pathname: string): string {
  return path.join(ROOT, 'app/(dashboard)', pathname, 'page.tsx')
}

test('dashboard card links point at existing routes, and anchors at existing section ids', () => {
  const exceptionsSource = [
    'app/(dashboard)/sync/exceptions/exceptions-client.tsx',
    'app/(dashboard)/sync/exceptions/wms-operator-tasks-section.tsx',
    'app/(dashboard)/sync/exceptions/gift-card-lines-section.tsx',
  ].map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n')

  const hrefs = [...NEEDS_ATTENTION_CATEGORIES.map((c) => c.href), ...ANNOUNCE_SPECS.map((s) => s.actionUrl)]
  for (const href of hrefs) {
    const [pathname, anchor] = href.split('#')
    assert.ok(existsSync(routeFile(pathname)), `${href}: no page at ${routeFile(pathname)}`)
    if (anchor) assert.ok(exceptionsSource.includes(`id="${anchor}"`), `${href}: no element with id="${anchor}"`)
  }
})
