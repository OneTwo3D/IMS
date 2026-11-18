import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The claim taken around each Mintsoft customs clear, against a real PostgreSQL (scratch database): a clear planned from a marker is
 * sent only while that same marker is current and the IMS field is still empty, and a refill that races the request waits for it.
 * Also the once-only record and settlement of a clear Mintsoft cannot perform.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  const sync = await import('@/lib/connectors/mintsoft/sync/product-sync')
  return { db, sync }
}

/** A product whose hsCode was emptied: returns it with the marker the planner would have read. */
async function clearedProduct(db: Awaited<ReturnType<typeof load>>['db'], extra: Record<string, unknown> = {}) {
  const product = await db.product.create({ data: { sku: `CLM-${randomUUID()}`, name: 'Claim probe', hsCode: '85011099', countryOfOrigin: 'CN', ...extra } })
  await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
  const markers = await db.productCustomsClear.findMany({ where: { productId: product.id } })
  return { product, markers }
}

test('the clear is sent while the planned marker is current and the field is empty', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    let sent = 0
    const result = await claim('commodityCode', async () => { sent += 1; return 'ok' })
    assert.deepEqual(result, { claimed: true, value: 'ok' })
    assert.equal(sent, 1)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a refill between planning and sending skips the clear', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    await db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } })
    let sent = 0
    const result = await claim('commodityCode', async () => { sent += 1 })
    assert.equal(result.claimed, false)
    assert.equal(sent, 0)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('an empty -> refill -> empty cycle replaces the marker, so the clear planned from the old one is skipped', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const planned = sync.plannedClearMarkers(markers)
    await db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
    const claim = sync.buildCustomsClearClaim(product.id, planned)
    let sent = 0
    const result = await claim('commodityCode', async () => { sent += 1 })
    assert.equal(result.claimed, false)
    assert.match((result as { reason: string }).reason, /replaced/)
    assert.equal(sent, 0)
    // planned afresh from the new marker, it goes
    const fresh = await db.productCustomsClear.findMany({ where: { productId: product.id } })
    const again = await sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(fresh))('commodityCode', async () => 'sent')
    assert.equal(again.claimed, true)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a refill racing the request waits for it and lands after', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const claiming = claim('commodityCode', async () => { entered(); await gate; order.push('sent') })
    await inside
    const refill = db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } }).then(() => { order.push('refilled') })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(order, [], 'the refill must be blocked on the marker lock while the request is in flight')
    release()
    await Promise.all([claiming, refill])
    assert.deepEqual(order, ['sent', 'refilled'])
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a clear Mintsoft cannot perform is recorded once, settles a description marker, and keeps the origin marker', { skip }, async () => {
  const { db, sync } = await load()
  const product = await db.product.create({ data: { sku: `CLU-${randomUUID()}`, name: 'Unsupported probe', customsDescription: 'Motor', countryOfOrigin: 'CN' } })
  try {
    await db.product.update({ where: { id: product.id }, data: { customsDescription: null, countryOfOrigin: null } })
    const markers = await db.productCustomsClear.findMany({ where: { productId: product.id } })
    assert.deepEqual(markers.map((m) => m.field).sort(), ['countryOfOrigin', 'customsDescription'])
    const candidate = { id: product.id, sku: product.sku, customsClears: markers }
    for (let run = 0; run < 2; run += 1) {
      await sync.settleUnsupportedCustomsClears(candidate, '42', ['customsDescription', 'countryOfManufacture'])
    }
    const events = await db.wmsMutationEvent.findMany({ where: { entityId: product.id } })
    assert.equal(events.length, 2, 'one event per field, however often it is seen')
    assert.ok(events.every((e) => e.error === sync.MINTSOFT_CANNOT_CLEAR_MESSAGE && e.outcome === 'FAILED'))
    const left = await db.productCustomsClear.findMany({ where: { productId: product.id } })
    assert.deepEqual(left.map((m) => m.field), ['countryOfOrigin'])
  } finally {
    await db.wmsMutationEvent.deleteMany({ where: { entityId: product.id } })
    await db.product.delete({ where: { id: product.id } })
  }
})
