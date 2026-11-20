import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { normalizeImageRefs, type ProductContentSnapshot } from '../lib/domain/product-content/snapshot.ts'
import { extractWcContent } from '../lib/connectors/woocommerce/sync/product-content.ts'
import { contentValueHash } from '../lib/domain/product-content/snapshot.ts'
import { producerDisposition } from '../lib/security/producer-disposition.ts'
import { PRODUCER_CUTOFF_ENV } from '../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'

/**
 * PRODUCT CONTENT SYNC REVIEW FIXES (no network, no database: the Mintsoft request and the link row are doubles).
 *  a  success-false-as-sent   updateMintsoftProductContent records an HTTP 200 `Success: false` body as sent
 *  b  variation-singular-image extractWcContent ignores a variation's singular `image`
 *  c  summary-hides-shadow    a send with already-recorded shadows names no shadowed field and the run counters miss it
 *  d  blind-state-save        the link state is written without checking it is still the one this run read
 */

const LIVE_CONTEXT = { env: { [OUTBOUND_GRANT_ENV.mintsoft]: 'https://api.example.test|89', [PRODUCER_CUTOFF_ENV.mintsoft]: '2026-01-01T00:00:00Z' }, now: new Date('2026-06-01T12:00:00Z') }
void producerDisposition

let nextResponse: { data: unknown; status: number; error?: string } = { data: null, status: 200 }
mock.module('@/lib/connectors/mintsoft/api/client', { namedExports: { mintsoftRequest: async () => nextResponse } })

type LinkRow = { id: string; contentSyncState: unknown }
const links = new Map<string, LinkRow>()
let concurrentWriter: ((id: string) => void) | null = null
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsProductLink: {
        updateMany: async ({ where, data }: { where: { id: string; contentSyncState: { equals: unknown } }; data: { contentSyncState: unknown } }) => {
          concurrentWriter?.(where.id)
          const row = links.get(where.id)
          const expected = where.contentSyncState.equals
          const matches = row && JSON.stringify(row.contentSyncState ?? null) === JSON.stringify(typeof expected === 'object' && expected !== null && 'toString' in expected && String(expected).includes('DbNull') ? null : expected)
          if (!row || !matches) return { count: 0 }
          row.contentSyncState = data.contentSyncState
          return { count: 1 }
        },
        findUnique: async ({ where }: { where: { id: string } }) => links.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: { contentSyncState: unknown } }) => { links.get(where.id)!.contentSyncState = data.contentSyncState },
      },
    },
  },
})

const loadApi = () => import('../lib/connectors/mintsoft/api/product-content.ts')
const loadSync = () => import('../lib/connectors/mintsoft/sync/product-content-sync.ts')

const CONTENT: ProductContentSnapshot = {
  longDescription: 'A long description',
  shortDescription: 'A short description',
  images: normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/p.jpg' }]),
}
const IMAGE_UPDATE = { externalProductId: '168', sku: 'SKU-1', imageUrl: 'https://shop.example.test/p.jpg' }

test('a: an HTTP 200 whose body says Success:false is a rejection, not a send; a body without Success stays accepted', async () => {
  const { updateMintsoftProductContent } = await loadApi()
  nextResponse = { data: { Success: false, Message: 'Product not found' }, status: 200 }
  await assert.rejects(() => updateMintsoftProductContent(IMAGE_UPDATE), /rejected the content update: Product not found/)
  nextResponse = { data: { Success: true }, status: 200 }
  assert.deepEqual(await updateMintsoftProductContent(IMAGE_UPDATE), { sent: true })
  nextResponse = { data: null, status: 200 }
  assert.deepEqual(await updateMintsoftProductContent(IMAGE_UPDATE), { sent: true })
})

test('b: a wc/v3 variation carries its picture as a singular `image`; the list form still wins when both exist', () => {
  const fromSingular = extractWcContent({ description: 'v', image: { id: 31, src: 'https://shop.example.test/red.jpg' } })
  assert.equal(fromSingular.images.length, 1)
  assert.equal(fromSingular.images[0]!.url, 'https://shop.example.test/red.jpg')
  assert.equal(extractWcContent({ description: 'v', image: { id: 0, src: '' } }).images.length, 0, 'an empty picture slot is no picture')
  assert.equal(extractWcContent({ images: [{ id: 5, src: 'https://shop.example.test/a.jpg' }], image: { id: 6, src: 'https://shop.example.test/b.jpg' } }).images[0]!.url, 'https://shop.example.test/a.jpg')
})

test('c: a send names the fields still held back even when their shadow was already recorded, so the run counters can count them', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const sent: unknown[] = []
  const connector = { async updateProductContent(update: unknown) { sent.push(update); return { sent: true as const } } }
  // The two descriptions were recorded as shadows on an earlier run; only the picture changed now.
  const state = { pushed: {}, shadowed: { description: contentValueHash(CONTENT.longDescription!), shortDescription: contentValueHash(CONTENT.shortDescription!) } }
  const result = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-c', externalProductId: '168', contentSyncState: state }, content: CONTENT, connector,
    context: LIVE_CONTEXT, saveState: async () => {},
  })
  assert.equal(result.kind, 'sent')
  assert.deepEqual(result.shadowedFields.slice().sort(), ['description', 'shortDescription'])
  assert.match(result.reason, /NOT sent \(recorded only\): description, short description/)
})

test('d: the state save is compare-and-swap; when another run moved the state the sent fields lose their hash and are offered again', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const connector = { async updateProductContent() { return { sent: true as const } } }
  const imageHash = contentValueHash('https://shop.example.test/p.jpg')
  const first = { pushed: {}, shadowed: {} }
  // Control: nothing moved the state, so the save lands with the sent hash.
  links.set('link-d1', { id: 'link-d1', contentSyncState: first })
  await syncMintsoftProductContent({ product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-d1', externalProductId: '168', contentSyncState: first }, content: CONTENT, connector, context: LIVE_CONTEXT })
  assert.equal((links.get('link-d1')!.contentSyncState as { pushed: Record<string, string> }).pushed.imageUrl, imageHash)
  // Race: a second run saved a different picture hash between this run's read and its save.
  links.set('link-d2', { id: 'link-d2', contentSyncState: first })
  concurrentWriter = (id) => { concurrentWriter = null; links.get(id)!.contentSyncState = { pushed: { imageUrl: 'hash-of-what-the-other-run-sent' }, shadowed: {} } }
  await syncMintsoftProductContent({ product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-d2', externalProductId: '168', contentSyncState: first }, content: CONTENT, connector, context: LIVE_CONTEXT })
  const after = links.get('link-d2')!.contentSyncState as { pushed: Record<string, string> }
  assert.equal(after.pushed.imageUrl, undefined, 'no hash is trusted for a field two runs both sent: the next run sends the current value again')
})

test('d2: when both runs sent the SAME value the other run\'s hash is kept (no redundant re-send), and the fallback write is conditional', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const connector = { async updateProductContent() { return { sent: true as const } } }
  const imageHash = contentValueHash('https://shop.example.test/p.jpg')
  const first = { pushed: {}, shadowed: {} }
  links.set('link-d3', { id: 'link-d3', contentSyncState: first })
  concurrentWriter = (id) => { concurrentWriter = null; links.get(id)!.contentSyncState = { pushed: { imageUrl: imageHash }, shadowed: {} } }
  await syncMintsoftProductContent({ product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-d3', externalProductId: '168', contentSyncState: first }, content: { ...CONTENT, longDescription: '', shortDescription: '' }, connector, context: LIVE_CONTEXT })
  const after = links.get('link-d3')!.contentSyncState as { pushed: Record<string, string> }
  assert.equal(after.pushed.imageUrl, imageHash, 'the same value the other run sent keeps its hash')
})

const REFUSED_AT = new Date('2026-06-01T12:00:00Z')
function refusingHarness() {
  const calls: unknown[] = []
  const saves: Array<{ refused: Record<string, { hash: string; count: number; at: string }>; pushed: Record<string, string> }> = []
  return {
    calls,
    saves,
    connector: { async updateProductContent(update: unknown) { calls.push(update); const { MintsoftContentRefusedError } = await loadApi(); throw new MintsoftContentRefusedError('Mintsoft rejected the content update: bad image') } },
    saveState: async (_id: string, state: unknown) => { saves.push(JSON.parse(JSON.stringify(state))) },
  }
}
const imageOnly: ProductContentSnapshot = { longDescription: '', shortDescription: '', images: CONTENT.images }

test('f: a Success:false answer is RECORDED against the value, backs off, stops at five refusals and names the field for a discrepancy; it is not re-POSTed every run', async () => {
  const { syncMintsoftProductContent, CONTENT_REFUSAL_MAX_ATTEMPTS, CONTENT_REFUSAL_BACKOFF_MINUTES } = await loadSync()
  const h = refusingHarness()
  let state: unknown = null
  let now = REFUSED_AT
  const run = async () => {
    const line = await syncMintsoftProductContent({ product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-f', externalProductId: '168', contentSyncState: state }, content: imageOnly, connector: h.connector, context: LIVE_CONTEXT, saveState: h.saveState, now })
    state = h.saves.at(-1) ?? state
    return line
  }
  const first = await run()
  assert.equal(first.kind, 'refused')
  assert.equal(h.calls.length, 1)
  assert.equal(h.saves.at(-1)!.refused.imageUrl!.count, 1, 'the refusal is in the saved state')
  assert.equal(h.saves.at(-1)!.refused.imageUrl!.hash, contentValueHash('https://shop.example.test/p.jpg'))
  assert.deepEqual(h.saves.at(-1)!.pushed, {}, 'a refused value is never recorded as accepted')
  // Straight away and 29 minutes later: waiting, no POST.
  assert.equal((await run()).kind, 'refused_wait')
  now = new Date(REFUSED_AT.getTime() + 29 * 60_000)
  assert.equal((await run()).kind, 'refused_wait')
  assert.equal(h.calls.length, 1, 'no request while the back-off holds')
  // Each refusal waits longer, up to the cap.
  for (let attempt = 1; attempt < CONTENT_REFUSAL_MAX_ATTEMPTS; attempt += 1) {
    now = new Date(Date.parse(h.saves.at(-1)!.refused.imageUrl!.at) + CONTENT_REFUSAL_BACKOFF_MINUTES[attempt - 1]! * 60_000)
    const line = await run()
    assert.equal(line.kind, 'refused')
    assert.equal(h.saves.at(-1)!.refused.imageUrl!.count, attempt + 1)
    if (attempt + 1 === CONTENT_REFUSAL_MAX_ATTEMPTS) assert.deepEqual(line.capReachedFields, ['imageUrl'], 'the cap is reached: the caller raises the discrepancy')
    else assert.deepEqual(line.capReachedFields, [])
  }
  assert.equal(h.calls.length, CONTENT_REFUSAL_MAX_ATTEMPTS)
  now = new Date(now.getTime() + 24 * 3_600_000)
  const capped = await run()
  assert.equal(capped.kind, 'refused_wait')
  assert.deepEqual(capped.capReachedFields, ['imageUrl'], 'the cap keeps naming the field every run')
  assert.equal(h.calls.length, CONTENT_REFUSAL_MAX_ATTEMPTS, 'inside the re-offer interval it is not sent again (the re-offer itself is tested in mintsoft-content-refusal-followups)')
  // A CHANGED value starts again at once, and the old refusal record is dropped.
  const changed = await syncMintsoftProductContent({ product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-f', externalProductId: '168', contentSyncState: state }, content: { ...imageOnly, images: normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/other.jpg' }]) }, connector: { async updateProductContent() { return { sent: true as const } } }, context: LIVE_CONTEXT, saveState: h.saveState, now })
  assert.equal(changed.kind, 'sent')
  assert.equal(changed.refusalCleared, true)
  assert.deepEqual(h.saves.at(-1)!.refused, {})
})

test('g: a transport failure (not an answered refusal) is not counted and still throws', async () => {
  const { syncMintsoftProductContent } = await loadSync()
  const saves: unknown[] = []
  await assert.rejects(syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: { id: 'link-g', externalProductId: '168', contentSyncState: null }, content: imageOnly,
    connector: { async updateProductContent() { throw new Error('socket hang up') } }, context: LIVE_CONTEXT, saveState: async (_i: string, state: unknown) => { saves.push(state) },
  }), /socket hang up/)
  assert.deepEqual(saves, [], 'nothing is recorded for an unanswered request')
})

test('e: many variations are stored with ONE read and a write only for a changed one (was a read and a write each)', async () => {
  const { applyIncomingProductContentBatch } = await import('../lib/domain/product-content/store.ts')
  const rows: Array<Record<string, unknown>> = [{ productId: 'same', shortDescription: null, longDescription: 'unchanged', images: [] }]
  let reads = 0
  let writes = 0
  const client = {
    productContent: {
      findMany: async ({ where }: { where: { productId: { in: string[] } } }) => { reads += 1; return rows.filter((row) => where.productId.in.includes(row.productId as string)) },
      findUnique: async () => { throw new Error('the batch must not read one product at a time') },
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => { writes += 1; rows.push({ ...create, ...update }); return {} },
    },
  }
  const snap = (longDescription: string) => ({ shortDescription: null, longDescription, images: [] })
  const items = [{ productId: 'same', incoming: snap('unchanged') }, ...Array.from({ length: 4 }, (_, i) => ({ productId: `new-${i}`, incoming: snap(`text ${i}`) }))]
  const results = await applyIncomingProductContentBatch(client as never, items)
  assert.equal(reads, 1)
  assert.equal(writes, 4, 'the unchanged product costs no write')
  assert.deepEqual(results.map((r) => r.changed.length > 0), [false, true, true, true, true])
})
