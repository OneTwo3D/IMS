import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { normalizeImageRefs, contentValueHash, type ProductContentSnapshot } from '../lib/domain/product-content/snapshot.ts'
import { PRODUCER_CUTOFF_ENV } from '../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'

/**
 * #1074 R1 FOLLOW-UPS (no network: the link row and the Mintsoft call are doubles).
 *  1  cap re-offer       a spent cap re-offers the same value once per CONTENT_REFUSAL_REOFFER_MINUTES, and cannot loop faster
 *  2  operator reset     resetContentRefusals forgets the records so the value is offered at once
 *  3  attribution        a refusal of a multi-field send is charged only to the fields that are refused on their own
 *  4  stale discrepancy  the refused line carries refusalCleared, so the old row resolves
 *  5  CAS fallback       no undercount, no overwrite of a newer value's record, no resurrected refusal, bounded retry
 */

const LIVE_CONTEXT = { env: { [OUTBOUND_GRANT_ENV.mintsoft]: 'https://api.example.test|89', [PRODUCER_CUTOFF_ENV.mintsoft]: '2026-01-01T00:00:00Z' }, now: new Date('2026-06-01T12:00:00Z') }

type LinkRow = { id: string; contentSyncState: unknown }
const links = new Map<string, LinkRow>()
let beforeUpdate: ((id: string) => void) | null = null
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsProductLink: {
        updateMany: async ({ where, data }: { where: { id: string; contentSyncState: { equals: unknown } }; data: { contentSyncState: unknown } }) => {
          beforeUpdate?.(where.id)
          const row = links.get(where.id)
          const expected = where.contentSyncState.equals
          const expectedPlain = typeof expected === 'object' && expected !== null && String(expected).includes('DbNull') ? null : expected
          if (!row || !same(row.contentSyncState, expectedPlain)) return { count: 0 }
          row.contentSyncState = data.contentSyncState
          return { count: 1 }
        },
        findUnique: async ({ where }: { where: { id: string } }) => { const row = links.get(where.id); return row ? { contentSyncState: JSON.parse(JSON.stringify(row.contentSyncState ?? null)) } : null },
        findFirst: async ({ where }: { where: { productId: string } }) => [...links.values()].find((row) => row.id === `link-of-${where.productId}`) ?? null,
      },
    },
  },
})

const loadSync = () => import('../lib/connectors/mintsoft/sync/product-content-sync.ts')
const loadApi = () => import('../lib/connectors/mintsoft/api/product-content.ts')

const IMG = 'https://shop.example.test/p.jpg'
const CONTENT: ProductContentSnapshot = { longDescription: 'A long description', shortDescription: 'A short description', images: normalizeImageRefs([{ id: 1, src: IMG }]) }
const imageOnly: ProductContentSnapshot = { longDescription: '', shortDescription: '', images: CONTENT.images }
const ALL_VERIFIED = { description: { verified: true }, shortDescription: { verified: true }, imageUrl: { verified: true } } as const

async function refusing(calls: unknown[]) {
  const { MintsoftContentRefusedError } = await loadApi()
  return async (update: unknown) => { calls.push(update); throw new MintsoftContentRefusedError('Mintsoft rejected the content update: bad') }
}

test('1: a spent cap re-offers the same value after the interval, not before, and a refusal of the re-offer waits a FULL interval again', async () => {
  const { syncMintsoftProductContent, CONTENT_REFUSAL_REOFFER_MINUTES, CONTENT_REFUSAL_MAX_ATTEMPTS } = await loadSync()
  const calls: unknown[] = []
  const refuse = await refusing(calls)
  const at = new Date('2026-06-01T12:00:00Z')
  let state: unknown = { pushed: {}, shadowed: {}, refused: { imageUrl: { hash: contentValueHash(IMG), count: CONTENT_REFUSAL_MAX_ATTEMPTS, at: at.toISOString() } } }
  const run = (now: Date) => syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'l1', externalProductId: '168', contentSyncState: state }, content: imageOnly,
    connector: { updateProductContent: refuse as never }, context: LIVE_CONTEXT, now,
    saveState: async (_id, next) => { state = JSON.parse(JSON.stringify(next)) },
  })
  const justBefore = new Date(at.getTime() + CONTENT_REFUSAL_REOFFER_MINUTES * 60_000 - 1000)
  assert.equal((await run(justBefore)).kind, 'refused_wait')
  assert.equal(calls.length, 0, 'inside the interval nothing is sent')
  const due = new Date(at.getTime() + CONTENT_REFUSAL_REOFFER_MINUTES * 60_000)
  const line = await run(due)
  assert.equal(line.kind, 'refused')
  assert.equal(calls.length, 1, 'exactly one re-offer')
  assert.deepEqual(line.capReachedFields, ['imageUrl'], 'still capped, the discrepancy stays')
  // The refusal restamped `at`: the next run, a minute later, and every run until a full interval has passed, sends nothing (no fast loop).
  for (const minutes of [1, 60, 24 * 60, CONTENT_REFUSAL_REOFFER_MINUTES - 1]) assert.equal((await run(new Date(due.getTime() + minutes * 60_000))).kind, 'refused_wait')
  assert.equal(calls.length, 1)
  assert.equal((await run(new Date(due.getTime() + CONTENT_REFUSAL_REOFFER_MINUTES * 60_000))).kind, 'refused')
  assert.equal(calls.length, 2)
})

test('1b: a re-offer that Mintsoft accepts clears the cap and records the value as accepted', async () => {
  const { syncMintsoftProductContent, CONTENT_REFUSAL_REOFFER_MINUTES, CONTENT_REFUSAL_MAX_ATTEMPTS } = await loadSync()
  const at = new Date('2026-06-01T12:00:00Z')
  let saved: { refused: Record<string, unknown>; pushed: Record<string, string> } | null = null
  const line = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'l1', externalProductId: '168', contentSyncState: { pushed: {}, shadowed: {}, refused: { imageUrl: { hash: contentValueHash(IMG), count: CONTENT_REFUSAL_MAX_ATTEMPTS, at: at.toISOString() } } } },
    content: imageOnly, connector: { updateProductContent: async () => ({ sent: true as const }) }, context: LIVE_CONTEXT, now: new Date(at.getTime() + CONTENT_REFUSAL_REOFFER_MINUTES * 60_000),
    saveState: async (_id, next) => { saved = JSON.parse(JSON.stringify(next)) },
  })
  assert.equal(line.kind, 'sent')
  assert.equal(line.refusalCleared, true)
  assert.deepEqual(saved!.refused, {})
  assert.equal(saved!.pushed.imageUrl, contentValueHash(IMG))
})

test('2: the operator reset forgets every refusal record (and nothing else), so the capped value is offered at once', async () => {
  const { resetContentRefusals, syncMintsoftProductContent, CONTENT_REFUSAL_MAX_ATTEMPTS } = await loadSync()
  const at = new Date('2026-06-01T12:00:00Z')
  const capped = { hash: contentValueHash(IMG), count: CONTENT_REFUSAL_MAX_ATTEMPTS, at: at.toISOString() }
  links.set('link-of-p2', { id: 'link-of-p2', contentSyncState: { pushed: { description: 'h-d' }, shadowed: { shortDescription: 'h-s' }, refused: { imageUrl: capped } } })
  const calls: unknown[] = []
  const probe = { updateProductContent: async (update: unknown) => { calls.push(update); return { sent: true as const } } }
  const before = await syncMintsoftProductContent({ product: { id: 'p2', sku: 'SKU-2' }, link: { id: 'link-of-p2', externalProductId: '1', contentSyncState: links.get('link-of-p2')!.contentSyncState }, content: imageOnly, connector: probe, context: LIVE_CONTEXT, now: new Date(at.getTime() + 60_000), saveState: async () => {} })
  assert.equal(before.kind, 'refused_wait')
  assert.equal(calls.length, 0)
  assert.deepEqual(await resetContentRefusals('p2'), { linkFound: true, fields: ['imageUrl'] })
  const stored = links.get('link-of-p2')!.contentSyncState as { pushed: unknown; shadowed: unknown; refused: unknown }
  assert.deepEqual(stored.refused, {})
  assert.deepEqual(stored.pushed, { description: 'h-d' })
  assert.deepEqual(stored.shadowed, { shortDescription: 'h-s' })
  const after = await syncMintsoftProductContent({ product: { id: 'p2', sku: 'SKU-2' }, link: { id: 'link-of-p2', externalProductId: '1', contentSyncState: stored }, content: imageOnly, connector: probe, context: LIVE_CONTEXT, now: new Date(at.getTime() + 60_000), saveState: async () => {} })
  assert.equal(after.kind, 'sent')
  assert.equal(calls.length, 1, 'offered again immediately')
  assert.deepEqual(await resetContentRefusals('p2'), { linkFound: true, fields: [] }, 'idempotent')
  assert.deepEqual(await resetContentRefusals('no-such-product'), { linkFound: false, fields: [] })
})

test('3: a refused multi-field send is re-sent per field; only the field Mintsoft refuses on its own is charged, the good one is recorded as accepted', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const { MintsoftContentRefusedError } = await loadApi()
  const calls: Array<Record<string, unknown>> = []
  const connector = {
    async updateProductContent(update: Record<string, unknown>) {
      calls.push(update)
      if ('description' in update) throw new MintsoftContentRefusedError('Mintsoft rejected the content update: description too long')
      return { sent: true as const }
    },
  }
  let saved: { refused: Record<string, { count: number }>; pushed: Record<string, string> } | null = null
  const line = await syncMintsoftProductContent({
    product: { id: 'p3', sku: 'SKU-3' }, link: { id: 'l3', externalProductId: '1', contentSyncState: { pushed: {}, shadowed: {} } },
    content: { ...CONTENT, images: [] }, connector: connector as never, context: LIVE_CONTEXT, wireContract: ALL_VERIFIED, now: new Date('2026-06-01T12:00:00Z'),
    saveState: async (_id, next) => { saved = JSON.parse(JSON.stringify(next)) },
  })
  assert.deepEqual(calls.map((call) => Object.keys(call).filter((key) => key === 'description' || key === 'shortDescription')), [['description', 'shortDescription'], ['description'], ['shortDescription']])
  assert.equal(line.kind, 'refused')
  assert.deepEqual(line.fields, ['description'], 'the line names only the field that was refused')
  assert.deepEqual(Object.keys(saved!.refused), ['description'], 'the good field is not charged')
  assert.equal(saved!.refused.description!.count, 1)
  assert.equal(saved!.pushed.shortDescription, contentValueHash(CONTENT.shortDescription!), 'the good field is recorded as accepted')
  assert.equal(saved!.pushed.description, undefined)
})

test('3b: a non-refusal failure while splitting still saves what was learned, then throws', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const { MintsoftContentRefusedError } = await loadApi()
  let n = 0
  const connector = { async updateProductContent(update: Record<string, unknown>) { n += 1; if (n === 1 || 'description' in update) throw new MintsoftContentRefusedError('no'); throw new Error('network down') } }
  let saved: { refused: Record<string, unknown> } | null = null
  await assert.rejects(() => syncMintsoftProductContent({
    product: { id: 'p3', sku: 'SKU-3' }, link: { id: 'l3', externalProductId: '1', contentSyncState: { pushed: {}, shadowed: {} } },
    content: { ...CONTENT, images: [] }, connector: connector as never, context: LIVE_CONTEXT, wireContract: ALL_VERIFIED,
    saveState: async (_id, next) => { saved = JSON.parse(JSON.stringify(next)) },
  }), /network down/)
  assert.deepEqual(Object.keys(saved!.refused), ['description'])
})

test('4: a capped value that changed and is refused anew still reports refusalCleared, so the stale PRODUCT_CONTENT_REFUSED row resolves', async () => {
  const { syncMintsoftProductContent, CONTENT_REFUSAL_MAX_ATTEMPTS } = await loadSync()
  const calls: unknown[] = []
  const refuse = await refusing(calls)
  const line = await syncMintsoftProductContent({
    product: { id: 'p4', sku: 'SKU-4' },
    link: { id: 'l4', externalProductId: '1', contentSyncState: { pushed: {}, shadowed: {}, refused: { imageUrl: { hash: 'hash-of-the-OLD-value', count: CONTENT_REFUSAL_MAX_ATTEMPTS, at: '2026-05-01T00:00:00.000Z' } } } },
    content: imageOnly, connector: { updateProductContent: refuse as never }, context: LIVE_CONTEXT, now: new Date('2026-06-01T12:00:00Z'), saveState: async () => {},
  })
  assert.equal(line.kind, 'refused')
  assert.equal(line.refusalCleared, true, 'the old cap was dropped this run and the line says so')
  assert.deepEqual(line.capReachedFields, [], 'the new value is at count 1: nothing is capped any more')
})

test('5a: two runs refusing the same value from the same base count 2, not 1', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const calls: unknown[] = []
  const refuse = await refusing(calls)
  const base = { pushed: {}, shadowed: {}, refused: { imageUrl: { hash: contentValueHash(IMG), count: 1, at: '2026-06-01T10:00:00.000Z' } } }
  links.set('l5a', { id: 'l5a', contentSyncState: base })
  // The other run lands first: same value, count 2.
  beforeUpdate = (id) => { beforeUpdate = null; links.get(id)!.contentSyncState = { pushed: {}, shadowed: {}, refused: { imageUrl: { hash: contentValueHash(IMG), count: 2, at: '2026-06-01T11:59:00.000Z' } } } }
  await syncMintsoftProductContent({ product: { id: 'p5', sku: 'SKU-5' }, link: { id: 'l5a', externalProductId: '1', contentSyncState: base }, content: imageOnly, connector: { updateProductContent: refuse as never }, context: LIVE_CONTEXT, now: new Date('2026-06-01T12:00:00Z') })
  assert.equal((links.get('l5a')!.contentSyncState as { refused: { imageUrl: { count: number } } }).refused.imageUrl.count, 3, 'base 1 + the other run + this run')
})

test('5b: a run holding an older value\'s refusal cannot overwrite the record of a newer value', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const refuse = await refusing([])
  const base = { pushed: {}, shadowed: {} }
  links.set('l5b', { id: 'l5b', contentSyncState: base })
  const newer = { hash: 'hash-of-the-NEWER-value', count: 3, at: '2026-06-01T11:59:00.000Z' }
  beforeUpdate = (id) => { beforeUpdate = null; links.get(id)!.contentSyncState = { pushed: {}, shadowed: {}, refused: { imageUrl: newer } } }
  await syncMintsoftProductContent({ product: { id: 'p5', sku: 'SKU-5' }, link: { id: 'l5b', externalProductId: '1', contentSyncState: base }, content: imageOnly, connector: { updateProductContent: refuse as never }, context: LIVE_CONTEXT, now: new Date('2026-06-01T11:00:00Z') })
  assert.deepEqual((links.get('l5b')!.contentSyncState as { refused: { imageUrl: unknown } }).refused.imageUrl, newer)
})

test('5c: an accepted send does not leave the refusal of that value behind in the fallback merge (no resurrected refusal)', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const refusal = { hash: contentValueHash(IMG), count: 2, at: '2026-06-01T10:00:00.000Z' }
  const base = { pushed: {}, shadowed: {}, refused: { imageUrl: refusal } }
  links.set('l5c', { id: 'l5c', contentSyncState: base })
  // Another run touched the row (a shadow for another field), so this run's CAS misses and the merge runs against the fresh state, which still holds the refusal.
  beforeUpdate = (id) => { beforeUpdate = null; links.get(id)!.contentSyncState = { pushed: {}, shadowed: { description: 'h' }, refused: { imageUrl: refusal } } }
  await syncMintsoftProductContent({ product: { id: 'p5', sku: 'SKU-5' }, link: { id: 'l5c', externalProductId: '1', contentSyncState: base }, content: imageOnly, connector: { updateProductContent: async () => ({ sent: true as const }) }, context: { ...LIVE_CONTEXT }, now: new Date('2026-06-01T12:00:00Z') })
  const after = links.get('l5c')!.contentSyncState as { refused: Record<string, unknown>; pushed: Record<string, string> }
  assert.deepEqual(after.refused, {}, 'the accepted value has no refusal record')
  assert.equal(after.pushed.imageUrl, undefined, 'the existing CAS rule: a moved state means no trusted hash, the next run re-sends once')
})

test('5d: the fallback merge retries when a third writer gets in between (bounded), instead of dropping this run\'s state', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const refuse = await refusing([])
  const base = { pushed: {}, shadowed: {} }
  links.set('l5d', { id: 'l5d', contentSyncState: base })
  let writes = 0
  // The first CAS misses (writer A), and so does the first fallback write (writer B moves the row again).
  beforeUpdate = (id) => {
    writes += 1
    if (writes <= 2) links.get(id)!.contentSyncState = { pushed: {}, shadowed: { description: `h${writes}` } }
    else beforeUpdate = null
  }
  await syncMintsoftProductContent({ product: { id: 'p5', sku: 'SKU-5' }, link: { id: 'l5d', externalProductId: '1', contentSyncState: base }, content: imageOnly, connector: { updateProductContent: refuse as never }, context: LIVE_CONTEXT, now: new Date('2026-06-01T12:00:00Z') })
  const after = links.get('l5d')!.contentSyncState as { refused: { imageUrl?: { count: number } } }
  assert.equal(after.refused.imageUrl?.count, 1, 'this run\'s refusal survived the second miss')
})
