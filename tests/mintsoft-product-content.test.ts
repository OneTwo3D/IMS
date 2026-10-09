import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeImageRefs, type ProductContentSnapshot } from '../lib/domain/product-content/snapshot.ts'
import { buildMintsoftProductContentRequest, MINTSOFT_CONTENT_WIRE } from '../lib/connectors/mintsoft/api/product-content.ts'
import {
  changedContentFields,
  describeContentOutcome,
  describeContentRun,
  projectContentForMintsoft,
  readContentSyncState,
  syncMintsoftProductContent,
  type ContentSyncState,
} from '../lib/connectors/mintsoft/sync/product-content-sync.ts'
import { producerDisposition } from '../lib/security/producer-disposition.ts'
import { PRODUCER_CUTOFF_ENV } from '../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'
import { ownershipRowFor } from '../lib/security/writer-ownership-map.ts'
import type { WmsProductContentResult, WmsProductContentUpdate } from '../lib/connectors/wms/types.ts'

/**
 * OUTBOUND PRODUCT CONTENT TO MINTSOFT: SHADOW WHEN NOT THE LIVE WRITER, ONLY CHANGED FIELDS, NEVER EMPTY.
 *
 * No network and no database: the connector is a recorder and the state store is a recorder. Every arm prints its
 * precondition. Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  m6  skip-disposition  syncMintsoftProductContent treats every disposition as LIVE
 *  m7  ignore-state      changedContentFields ignores what was last accepted (sends everything every run)
 *  m8  project-empty     projectContentForMintsoft lets an empty value into the projection
 *  m9  held-as-sent      a hold refusal is recorded as accepted
 *  m10 builder-allows-empty  buildMintsoftProductContentRequest stops refusing blank values
 *  m11 unverified-sent   an unverified wire field is sent when the disposition is LIVE
 *  m12 meta-in-body      the content body also carries the product name
 *  m13 shadow-not-recorded  a shadow does not update the shadow state (it is re-recorded every run)
 */

const GRANT = 'https://api.example.test|89'
const LIVE_ENV = { [OUTBOUND_GRANT_ENV.mintsoft]: GRANT, [PRODUCER_CUTOFF_ENV.mintsoft]: '2026-01-01T00:00:00Z' }
const NOW = new Date('2026-06-01T12:00:00Z')
const SHADOW_CONTEXT = { env: {}, now: NOW }
const LIVE_CONTEXT = { env: LIVE_ENV, now: NOW }
const ALL_VERIFIED = { description: { verified: true }, shortDescription: { verified: true }, imageUrl: { verified: true } }

const CONTENT: ProductContentSnapshot = {
  longDescription: 'A long description',
  shortDescription: 'A short description',
  images: normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/p.jpg' }]),
}

function harness(result: WmsProductContentResult = { sent: true }) {
  const calls: WmsProductContentUpdate[] = []
  const saves: ContentSyncState[] = []
  return {
    calls,
    saves,
    connector: { async updateProductContent(update: WmsProductContentUpdate) { calls.push(update); return result } },
    saveState: async (_id: string, state: ContentSyncState) => { saves.push(JSON.parse(JSON.stringify(state))) },
  }
}

const LINK = (state: unknown = null) => ({ id: 'link-1', externalProductId: '168', contentSyncState: state })

test('the ownership map has the product.content row, and the environment alone decides: no grant = SHADOW, grant + cutoff = LIVE', () => {
  const row = ownershipRowFor('mintsoft', 'product.content')
  const held = producerDisposition('mintsoft', 'product.content', undefined, SHADOW_CONTEXT)
  const live = producerDisposition('mintsoft', 'product.content', undefined, LIVE_CONTEXT)
  console.log(`precondition: row owners=${JSON.stringify(row?.owners)} held=${held} live=${live}`)
  assert.ok(row, 'mintsoft/product.content is declared in the writer-ownership map')
  assert.equal(row.owners.P1, 'woo-mintsoft-plugin')
  assert.equal(row.owners.P2, 'IMS')
  assert.equal(held, 'SHADOW')
  assert.equal(live, 'LIVE')
})

test('SHADOW: the connector is never called, a shadow is recorded, and a repeat run records nothing new', async () => {
  const h = harness()
  const first = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(), content: CONTENT, connector: h.connector, context: SHADOW_CONTEXT,
    saveState: h.saveState, wireContract: ALL_VERIFIED,
  })
  console.log(`precondition: changed fields=3 disposition=SHADOW; kind=${first.kind} connector calls=${h.calls.length} saves=${h.saves.length}`)
  assert.equal(first.kind, 'shadow')
  assert.deepEqual([...first.fields].sort(), ['description', 'imageUrl', 'shortDescription'])
  assert.equal(h.calls.length, 0, 'a shadow never reaches the connector')
  assert.equal(h.saves.length, 1)
  assert.deepEqual(h.saves[0]!.pushed, {}, 'a shadow is not recorded as pushed')
  assert.equal(Object.keys(h.saves[0]!.shadowed).length, 3)
  assert.match(first.reason, /NOT sent/)
  assert.match(first.reason, /the outbound-write grant for this destination is not set/)

  const second = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(h.saves[0]), content: CONTENT, connector: h.connector, context: SHADOW_CONTEXT,
    saveState: h.saveState, wireContract: ALL_VERIFIED,
  })
  assert.equal(second.kind, 'shadow_repeat', 'the same shadow is not recorded again')
  assert.equal(h.saves.length, 1, 'and nothing is saved for it')
  assert.equal(h.calls.length, 0)
})

test('LIVE: only the CHANGED fields are sent, and an accepted value is not sent again (idempotent)', async () => {
  const h = harness()
  const run = (content: ProductContentSnapshot, state: unknown) => syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(state), content, connector: h.connector, context: LIVE_CONTEXT,
    saveState: h.saveState, wireContract: ALL_VERIFIED,
  })
  const first = await run(CONTENT, null)
  assert.equal(first.kind, 'sent')
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0], {
    externalProductId: '168', sku: 'SKU-1',
    description: 'A long description', shortDescription: 'A short description', imageUrl: 'https://shop.example.test/p.jpg',
  })
  const accepted = h.saves[0]!

  const again = await run(CONTENT, accepted)
  console.log(`precondition: all 3 fields accepted; rerun kind=${again.kind} total calls=${h.calls.length}`)
  assert.equal(again.kind, 'unchanged')
  assert.equal(h.calls.length, 1, 'an unchanged run makes no call')

  const edited = await run({ ...CONTENT, shortDescription: 'A newer short description' }, accepted)
  assert.equal(edited.kind, 'sent')
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1], { externalProductId: '168', sku: 'SKU-1', shortDescription: 'A newer short description' },
    'only the field that changed is in the update')
})

test('LIVE with the real wire contract: an UNVERIFIED field name is a shadow, the verified picture is sent', async () => {
  const h = harness()
  const result = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(), content: CONTENT, connector: h.connector, context: LIVE_CONTEXT, saveState: h.saveState,
  })
  console.log(`precondition: wire verified=${JSON.stringify(Object.fromEntries(Object.entries(MINTSOFT_CONTENT_WIRE).map(([k, v]) => [k, v.verified])))}; sent=${JSON.stringify(h.calls)}`)
  assert.equal(MINTSOFT_CONTENT_WIRE.imageUrl.verified, true)
  assert.equal(MINTSOFT_CONTENT_WIRE.description.verified, false)
  assert.equal(result.kind, 'sent')
  assert.deepEqual(h.calls, [{ externalProductId: '168', sku: 'SKU-1', imageUrl: 'https://shop.example.test/p.jpg' }])
  assert.deepEqual(Object.keys(h.saves[0]!.shadowed).sort(), ['description', 'shortDescription'])
  assert.match(result.reason, /not verified yet/)
})

test('HELD: when the outbound-write hold refuses, the fields stay unaccepted and are offered again', async () => {
  const h = harness({ sent: false, held: true, message: 'refusal (Mintsoft): nothing was sent.' })
  const result = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(), content: CONTENT, connector: h.connector, context: LIVE_CONTEXT,
    saveState: h.saveState, wireContract: ALL_VERIFIED,
  })
  console.log(`precondition: disposition LIVE, hold refuses; kind=${result.kind} calls=${h.calls.length} saves=${h.saves.length}`)
  assert.equal(h.calls.length, 1, 'the request was attempted')
  assert.equal(result.kind, 'held')
  assert.equal(h.saves.length, 0, 'nothing is recorded as accepted')
  assert.match(result.reason, /refused the request before it left IMS/)
})

test('NEVER EMPTY: blank content is not in the projection, plans no change and sends nothing', async () => {
  const blanks: ProductContentSnapshot = { longDescription: '', shortDescription: '   ', images: [] }
  const projection = projectContentForMintsoft(blanks)
  const h = harness()
  const result = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: LINK(), content: blanks, connector: h.connector, context: LIVE_CONTEXT,
    saveState: h.saveState, wireContract: ALL_VERIFIED,
  })
  console.log(`precondition: 3 blank fields; projection keys=${Object.keys(projection).length} kind=${result.kind} calls=${h.calls.length}`)
  assert.deepEqual(projection, {})
  assert.equal(result.kind, 'no_content')
  assert.equal(h.calls.length, 0)
  assert.equal(projectContentForMintsoft(null).description, undefined)
  // Content that was accepted and is later EMPTY in the hub is not a change either.
  const accepted = readContentSyncState({ pushed: { description: 'x' } })
  assert.deepEqual(changedContentFields({}, accepted), [])
})

test('NEVER EMPTY at the wire: the request builder refuses a blank value outright', () => {
  for (const blank of ['', '   ']) {
    assert.throws(
      () => buildMintsoftProductContentRequest({ externalProductId: '168', sku: 'S', description: blank }),
      /never erased by an empty value/,
    )
  }
  assert.throws(() => buildMintsoftProductContentRequest({ externalProductId: '168', sku: 'S' }), /at least one content field/)
  console.log('precondition: builder refused 2 blank values and an update with no fields')
})

test('the wire body carries ID, SKU and the changed content fields ONLY: product meta is not in it', () => {
  const request = buildMintsoftProductContentRequest({
    externalProductId: '168', sku: 'SKU-1', description: 'D', shortDescription: 'S', imageUrl: 'https://shop.example.test/p.jpg',
  })
  const body = JSON.parse(request.body) as Record<string, unknown>
  console.log(`precondition: body keys=${Object.keys(body).join(',')} ${request.method} ${request.path}`)
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/api/Product')
  assert.deepEqual(Object.keys(body).sort(), ['Description', 'ID', 'ImageURL', 'SKU', 'ShortDescription'])
  assert.equal(body.ID, 168)
  for (const meta of ['Name', 'EAN', 'Weight', 'Height', 'Width', 'Depth', 'CustomsDescription', 'CommodityCode', 'CountryOfManufacture']) {
    assert.equal(meta in body, false, `${meta} must not be in a content update`)
  }
})

test('no Mintsoft link yet: nothing is written, and the text says why', async () => {
  const h = harness()
  const result = await syncMintsoftProductContent({
    product: { id: 'p1', sku: 'SKU-1' }, link: null, content: CONTENT, connector: h.connector, context: LIVE_CONTEXT, saveState: h.saveState,
  })
  console.log(`precondition: link=null; kind=${result.kind}`)
  assert.equal(result.kind, 'no_link')
  assert.equal(h.calls.length, 0)
})

test('operator text: "not sent" is claimed only where no request left IMS; the run summary is built from the counters', () => {
  assert.match(describeContentOutcome('shadow', ['description']), /NOT sent \(recorded only\)/)
  assert.match(describeContentOutcome('held', ['description']), /refused the request before it left IMS/)
  assert.doesNotMatch(describeContentOutcome('sent', ['description']), /NOT sent/)
  for (const kind of ['sent', 'shadow', 'held', 'unchanged', 'no_link', 'no_content', 'shadow_repeat'] as const) {
    assert.doesNotMatch(describeContentOutcome(kind, ['description']), /clear|erase|delet/i, `${kind} must not describe erasing anything`)
  }
  assert.equal(describeContentRun(undefined), 'Content: nothing to send.')
  assert.equal(
    describeContentRun({ sent: 1, shadowed: 2, held: 1, errors: 1 }),
    'Content: 1 field sent, 2 products recorded but NOT sent (IMS is not the live writer yet), 1 product NOT sent (refused by the outbound-write hold), 1 failed.',
  )
})
