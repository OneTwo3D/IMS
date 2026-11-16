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
  ANNOUNCED_KEY_PREFIX,
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

function makeDb(rows: Rows, settings = new Map<string, string>(), calls = { counts: 0 }) {
  const list = (ids: string[]) => async (args: { take: number }) => ids.slice(0, args.take).map((id) => ({ id }))
  const count = (ids: string[]) => async () => { calls.counts += 1; return ids.length }
  return {
    settings,
    calls,
    db: {
      wmsOrderPushLink: { count: count(rows.push), findMany: list(rows.push) },
      shoppingSyncLog: { findMany: list(rows.parks) },
      accountingSyncLog: { count: count(rows.failed), findMany: list(rows.failed) },
      wmsInboundReceiptEvent: { count: count(rows.reviews), findMany: list(rows.reviews) },
      wmsStockDiscrepancy: { count: count(rows.discrepancies), findMany: list(rows.discrepancies) },
      setting: {
        async findUnique({ where }: { where: { key: string } }) {
          const value = settings.get(where.key)
          return value === undefined ? null : { value }
        },
        async createMany({ data }: { data: Array<{ key: string; value: string }> }) {
          let count = 0
          for (const row of data) if (!settings.has(row.key)) { settings.set(row.key, row.value); count += 1 }
          return { count }
        },
        async updateMany({ where, data }: { where: { key: string; value: string }; data: { value: string } }) {
          if (settings.get(where.key) !== where.value) return { count: 0 }
          settings.set(where.key, data.value)
          return { count: 1 }
        },
      },
      user: {
        async findMany() {
          return [
            { id: 'admin', role: 'ADMIN' },
            { id: 'manager', role: 'MANAGER' },
            { id: 'wh', role: 'WAREHOUSE' },
            { id: 'ro', role: 'READONLY' },
            { id: 'sup', role: 'SUPPLIER' },
          ]
        },
      },
    },
  }
}

const emptyRows = (): Rows => ({ push: [], parks: [], failed: [], reviews: [], discrepancies: [] })

function announceHarness(rows: Rows, connector: string | null = 'xero') {
  const fake = makeDb(rows)
  const sent: Array<{ userId: string; title: string; message: string; actionUrl: string }> = []
  const deps = {
    db: fake.db,
    activeAccountingConnector: async () => connector,
    activeWmsConnector: async () => 'wms-a',
    notify: async (params) => { sent.push(params); return true },
  } as AnnounceDeps
  return { deps, sent, settings: fake.settings }
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
  const titles = new Set(sent.map((n) => n.title))
  assert.equal(titles.size, 2)
  const pushToAdmin = sent.filter((n) => n.userId === 'admin' && n.title === 'Warehouse order push blocked')
  assert.equal(pushToAdmin.length, 1, 'one notification for two new rows, not two')

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
  assert.match(adminMsg[0].message, /2 open/)
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
  const reviewRecipients = sent.filter((n) => n.title === 'Warehouse receipt paused for review').map((n) => n.userId)
  assert.deepEqual(reviewRecipients, ['admin'])
  const pushRecipients = sent.filter((n) => n.title === 'Warehouse order push blocked').map((n) => n.userId).sort()
  assert.deepEqual(pushRecipients, ['admin', 'manager'])
})

test('announce: two concurrent passes cannot both announce the same rows', async () => {
  const { deps, sent } = announceHarness({ ...emptyRows(), discrepancies: ['d1'] })
  await Promise.all([announceNeedsAttention(deps), announceNeedsAttention(deps)])
  const forAdmin = sent.filter((n) => n.userId === 'admin' && n.title === 'Stock discrepancy opened')
  assert.equal(forAdmin.length, 1)
})

test('announce: when nobody could be told, the claim is released and the next run retries', async () => {
  const rows = { ...emptyRows(), push: ['p1'] }
  const fake = makeDb(rows)
  let deliver = false
  const sent: string[] = []
  const deps = {
    db: fake.db,
    activeAccountingConnector: async () => 'xero',
    activeWmsConnector: async () => 'wms-a',
    notify: async (p: { userId: string }) => { if (deliver) sent.push(p.userId); return deliver },
  } as unknown as AnnounceDeps
  const first = await announceNeedsAttention(deps)
  assert.deepEqual(first.announced, [])
  deliver = true
  const second = await announceNeedsAttention(deps)
  assert.deepEqual(second.announced, ['wmsPushBlocked'])
  assert.ok(sent.length > 0)
})

test('announce: dispatch dead-letters are not re-announced (the sweep already bells them)', () => {
  assert.equal(ANNOUNCE_SPECS.some((s) => (s.key as string) === 'dispatchDeadLetters'), false)
  assert.deepEqual(ANNOUNCE_SPECS.map((s) => s.key).sort(), ['failedAccounting', 'receiptReviews', 'refundParks', 'stockDiscrepancies', 'wmsPushBlocked'])
  assert.ok(ANNOUNCED_KEY_PREFIX.length > 0)
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
