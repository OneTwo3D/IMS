import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * The LEASE taken around each Mintsoft customs clear, against a real PostgreSQL (scratch database): a clear planned from a marker
 * is sent only while that same marker is current, unleased (or its lease expired), under the retry cap, and the IMS field is still
 * empty. NO lock or transaction is held across the request: a refill that races it completes at once, and the clear is then
 * reported superseded rather than applied. Also the open discrepancy for a clear Mintsoft cannot perform, and createdAt-guarded
 * marker deletes.
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

test('the clear is sent while the planned marker is current; the lease is released and an attempt counted', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    let sent = 0
    let during = null as { claimToken: string | null } | null
    const result = await claim('commodityCode', async () => { sent += 1; during = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } }); return 'ok' })
    assert.deepEqual(result, { claimed: true, value: 'ok' })
    assert.equal(sent, 1)
    assert.ok(during!.claimToken, 'the lease is held while the request is in flight')
    const after = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(after.claimToken, null)
    assert.equal(after.claimedAt, null)
    assert.equal(after.attempts, 1)
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
    const fresh = await db.productCustomsClear.findMany({ where: { productId: product.id } })
    const again = await sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(fresh))('commodityCode', async () => 'sent')
    assert.equal(again.claimed, true)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a refill racing the request is NOT blocked by it (no lock held across the request) and the clear is reported superseded', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const claiming = claim('commodityCode', async () => { entered(); await gate; return 'posted' })
    await inside
    // The refill (and the editor save behind it) completes while the request is still in flight.
    await Promise.race([
      db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the refill waited on the in-flight clear request')), 5_000)),
    ])
    release()
    const result = await claiming
    assert.equal(result.claimed, true)
    assert.equal((result as { value: string }).value, 'posted', 'the request itself went out')
    assert.match((result as { superseded?: string }).superseded ?? '', /filled again/)
    assert.equal(await db.productCustomsClear.count({ where: { productId: product.id } }), 0)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('an empty -> refill -> empty cycle DURING the request is superseded too (the new marker is not the one that was sent for)', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const claim = sync.buildCustomsClearClaim(product.id, sync.plannedClearMarkers(markers))
    const result = await claim('commodityCode', async () => {
      await db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
      return 'posted'
    })
    assert.equal(result.claimed, true)
    assert.ok((result as { superseded?: string }).superseded)
    // the new marker survives untouched for the next run to plan from
    const left = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(left.claimToken, null)
    assert.equal(left.attempts, 0)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a live lease held by another run refuses the clear (retry set); an expired lease is taken over', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const planned = sync.plannedClearMarkers(markers)
    await db.productCustomsClear.updateMany({ where: { productId: product.id }, data: { claimToken: 'other-run', claimedAt: new Date() } })
    let sent = 0
    const refused = await sync.buildCustomsClearClaim(product.id, planned)('commodityCode', async () => { sent += 1 })
    assert.deepEqual(refused, { claimed: false, reason: 'another run holds the clear lease', retry: true })
    assert.equal(sent, 0)
    const held = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(held.claimToken, 'other-run', 'the other run keeps its lease')
    await db.$executeRaw`UPDATE "product_customs_clears" SET "claimedAt" = now() - interval '11 minutes' WHERE "productId" = ${product.id}`
    const taken = await sync.buildCustomsClearClaim(product.id, planned)('commodityCode', async () => { sent += 1; return 'ok' })
    assert.equal(taken.claimed, true)
    assert.equal(sent, 1)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('two claims at once: exactly one sends', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const planned = sync.plannedClearMarkers(markers)
    let sent = 0
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 300))
    const run = () => sync.buildCustomsClearClaim(product.id, planned)('commodityCode', async () => { sent += 1; await gate })
    const results = await Promise.all([run(), run(), run()])
    assert.equal(sent, 1)
    assert.equal(results.filter((r) => r.claimed).length, 1)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('the retry cap stops the clear and a failing request still releases the lease', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    const planned = sync.plannedClearMarkers(markers)
    await assert.rejects(sync.buildCustomsClearClaim(product.id, planned)('commodityCode', async () => { throw new Error('boom') }), /boom/)
    const after = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(after.claimToken, null, 'released after a failure')
    assert.equal(after.attempts, 1)
    await db.productCustomsClear.updateMany({ where: { productId: product.id }, data: { attempts: sync.CUSTOMS_CLEAR_MAX_ATTEMPTS } })
    let sent = 0
    const capped = await sync.buildCustomsClearClaim(product.id, planned)('commodityCode', async () => { sent += 1 })
    assert.equal(capped.claimed, false)
    assert.match((capped as { reason: string }).reason, /retry cap/)
    assert.equal(sent, 0)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('markers are deleted only while they are still the version read', { skip }, async () => {
  const { db, sync } = await load()
  const { product, markers } = await clearedProduct(db)
  try {
    await db.product.update({ where: { id: product.id }, data: { hsCode: '39219090' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
    await sync.deleteCustomsMarkers(product.id, markers)
    assert.equal(await db.productCustomsClear.count({ where: { productId: product.id } }), 1, 'the newer marker survives a delete of the older one')
    const fresh = await db.productCustomsClear.findMany({ where: { productId: product.id } })
    await sync.deleteCustomsMarkers(product.id, fresh)
    assert.equal(await db.productCustomsClear.count({ where: { productId: product.id } }), 0)
  } finally {
    await db.product.delete({ where: { id: product.id } })
  }
})

test('a clear Mintsoft cannot perform raises ONE open discrepancy naming the value it holds; it resolves on empty or refill; no mutation event', { skip }, async () => {
  const { db, sync } = await load()
  const warehouse = await db.warehouse.create({ data: { code: `CLW${randomUUID().slice(0, 8)}`, name: 'Clear probe' } })
  const product = await db.product.create({ data: { sku: `CLU-${randomUUID()}`, name: 'Manual probe', customsDescription: 'Motor', countryOfOrigin: 'CN' } })
  try {
    await db.product.update({ where: { id: product.id }, data: { customsDescription: null, countryOfOrigin: null } })
    const read = async () => (await db.productCustomsClear.findMany({ where: { productId: product.id } }))
    const ctx = async () => ({
      scopes: [{ warehouseId: warehouse.id, warehouseCode: warehouse.code }],
      product: { id: product.id, sku: product.sku, hsCode: null, countryOfOrigin: null, customsDescription: null, customsClears: await read() },
    })
    const held = { CustomsDescription: 'Brushless motor', CountryOfManufacture: { Code: 'CN' }, CountryOfManufactureId: 5 }
    const open = () => db.wmsStockDiscrepancy.findMany({ where: { productId: product.id, category: 'CUSTOMS_CLEAR_MANUAL' } })
    for (let run = 0; run < 2; run += 1) await sync.syncManualCustomsClearDiscrepancy(await ctx(), held)
    const rows = await open()
    assert.equal(rows.length, 1, 'one row however often it is seen')
    assert.equal(rows[0].status, 'OPEN')
    assert.equal(rows[0].detectionCount, 2)
    assert.match(rows[0].wmsValue ?? '', /customs description "Brushless motor"/)
    assert.match(rows[0].wmsValue ?? '', /country of origin "CN"/)
    // not read: nothing new is raised and the open one stays
    await sync.syncManualCustomsClearDiscrepancy(await ctx(), undefined)
    assert.equal((await open())[0].status, 'OPEN')
    // Mintsoft shows the description empty: only the origin is outstanding
    await sync.syncManualCustomsClearDiscrepancy(await ctx(), { CustomsDescription: '', CountryOfManufacture: { Code: 'CN' }, CountryOfManufactureId: 5 })
    const partial = (await open())[0]
    assert.equal(partial.status, 'OPEN')
    assert.doesNotMatch(partial.wmsValue ?? '', /description/)
    // Mintsoft shows both empty: resolved
    await sync.syncManualCustomsClearDiscrepancy(await ctx(), { CustomsDescription: '', CountryOfManufacture: null, CountryOfManufactureId: 0 })
    assert.equal((await open())[0].status, 'RESOLVED')
    // raised again, then the IMS fields are refilled (markers gone): resolved without reading Mintsoft
    await sync.syncManualCustomsClearDiscrepancy(await ctx(), held)
    assert.equal((await open()).filter((r) => r.status === 'OPEN').length, 1)
    await db.product.update({ where: { id: product.id }, data: { customsDescription: 'Motor', countryOfOrigin: 'CN' } })
    await sync.syncManualCustomsClearDiscrepancy({ ...(await ctx()), product: { ...(await ctx()).product, customsDescription: 'Motor', countryOfOrigin: 'CN' } }, undefined)
    assert.equal((await open()).filter((r) => r.status === 'OPEN').length, 0)
    assert.equal(await db.wmsMutationEvent.count({ where: { entityId: product.id } }), 0, 'no mislabelled mutation event')
  } finally {
    await db.wmsStockDiscrepancy.deleteMany({ where: { productId: product.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.warehouse.delete({ where: { id: warehouse.id } })
  }
})
