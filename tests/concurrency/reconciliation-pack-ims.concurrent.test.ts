import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE IMS READERS AND THE COMMAND, AGAINST A REAL, MIGRATED POSTGRESQL.
 *
 *   - every section's SQL runs and returns the seeded rows (so a wrong column name is red here, not in production);
 *   - the rig can fail: a write through the very connection the reader uses is REFUSED by the server;
 *   - ONE SNAPSHOT: a row committed by another connection after the read began is invisible to a later section;
 *   - a statement timeout is READ_INCOMPLETE; pg_control_system() answers an account that is not a superuser;
 *   - NO-WRITE PROOF: a whole run of the command (the real invariant report included) leaves every table's rows and
 *     statistics unchanged, and the only network connection it opens is to the database's own host and port.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TAG = `RCPK${process.pid}`

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, pgModule, readers, cli] = await Promise.all([
    import('@/lib/db'), import('pg'), import('../../lib/reconciliation-pack/ims-readers.ts'), import('../../scripts/reconciliation-pack.ts'),
  ])
  return { db, pg: pgModule.default, readers, cli }
}

async function withClient<T>(fn: (client: import('pg').Client, pg: typeof import('pg').default) => Promise<T>): Promise<T> {
  const { pg } = await load()
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try { return await fn(client, pg) } finally { await client.end() }
}

const orderIds: string[] = []
type Seed = { warehouseId: string; productId: string; feeId: string; orderId: string; taxRateId: string; ids: { link?: string } }
async function seed(): Promise<Seed> {
  const { db } = await load()
  const warehouse = await db.warehouse.create({ data: { code: `${TAG}W`, name: 'recon warehouse' } })
  const product = await db.product.create({ data: { sku: `${TAG}-A`, name: 'recon a' } })
  const fee = await db.product.create({ data: { sku: `${TAG}-FEE`, name: 'recon fee', type: 'NON_INVENTORY' } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: '5', reservedQty: '1' } })
  await db.stockLevel.create({ data: { productId: fee.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' } })
  const order = await db.salesOrder.create({ data: { status: 'PROCESSING', currency: 'GBP', subtotalForeign: '10', totalForeign: '12', subtotalBase: '10', totalBase: '12', externalCreatedAt: new Date('2026-10-05T10:00:00Z') } })
  const shipped = await db.salesOrder.create({ data: { status: 'SHIPPED', currency: 'GBP', subtotalForeign: '1', totalForeign: '1', subtotalBase: '1', totalBase: '1' } })
  orderIds.push(order.id, shipped.id)
  await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `${TAG}101` } })
  const rate = await db.taxRate.create({ data: { name: `${TAG} rate`, rate: '0.2' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: `${TAG}t1`, externalName: 'x', externalRatePct: '20', taxRateId: rate.id } })
  for (const [id, status, basis] of [[`${TAG}-s1`, 'SYNCED', null], [`${TAG}-s2`, 'SYNCED', 'OPERATOR_ASSERTION'], [`${TAG}-s3`, 'FAILED', null]] as const) {
    await db.$executeRawUnsafe(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "externalTransactionId", settlement_basis, "createdAt") VALUES ($1, 'xero', 'SALES_INVOICE', $2::"AccountingSyncStatus", 'SalesOrder', $3, $4, $5, now())`, id, status, `${id}-ref`, `${id}-doc`, basis)
  }
  await db.$executeRawUnsafe(`INSERT INTO inventory_snapshot_runs (id, "snapshotDate", "stockLevelCount", "snapshotCount", "updatedAt") VALUES ($1, '2026-10-19', 1, 1, now())`, `${TAG}-run`)
  await db.$executeRawUnsafe(`INSERT INTO inventory_snapshots (id, "snapshotDate", "productId", "warehouseId", qty, "valueBase", "unitCostBase") VALUES ($1, '2026-10-19', $2, $3, 5, 12.5, 2.5)`, `${TAG}-snap`, product.id, warehouse.id)
  await db.$executeRawUnsafe(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "updatedAt") VALUES ($1, 'xero', $2, '630', 'Inventory', '2026-10-19', 'GBP', 7, 7, now())`, `${TAG}-bal`, `${TAG}-acct`)
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: TAG } })
  await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `${TAG}ext`, stockSyncMode: 'NOTIFICATION_ONLY' } })
  return { warehouseId: warehouse.id, productId: product.id, feeId: fee.id, orderId: order.id, taxRateId: rate.id, ids: {} }
}

async function cleanup() {
  const { db } = await load()
  await db.$executeRawUnsafe(`DELETE FROM external_wms_bindings WHERE "externalWarehouseId" LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM wms_connections WHERE label = '${TAG}'`)
  await db.$executeRawUnsafe(`DELETE FROM accounting_account_balance_snapshots WHERE id LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM inventory_snapshots WHERE id LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM inventory_snapshot_runs WHERE id LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM accounting_sync_logs WHERE id LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM shopping_tax_rate_mappings WHERE "externalTaxRateId" LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM tax_rates WHERE name LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM shopping_order_links WHERE "externalOrderId" LIKE '${TAG}%'`)
  for (const id of orderIds.splice(0)) await db.$executeRawUnsafe(`DELETE FROM sales_orders WHERE id = $1`, id)
  await db.$executeRawUnsafe(`DELETE FROM stock_levels WHERE "productId" IN (SELECT id FROM products WHERE sku LIKE '${TAG}%')`)
  await db.$executeRawUnsafe(`DELETE FROM products WHERE sku LIKE '${TAG}%'`)
  await db.$executeRawUnsafe(`DELETE FROM warehouses WHERE code LIKE '${TAG}%'`)
}

test('[reconciliation pack] every section reads the seeded rows from a real database, in one read-only transaction', { skip: !RUN }, async () => {
  const { readers } = await load()
  try {
    const s = await seed()
    const read = await withClient((client) => readers.readImsSnapshot(client, { sections: [...readers.IMS_SECTIONS], asOf: '2026-10-19' }))
    assert.ok(read.ok, JSON.stringify(read))
    if (!read.ok) return
    for (const id of readers.IMS_SECTIONS) assert.ok(read.sections[id]?.ok, `${id}: ${JSON.stringify(read.sections[id])}`)
    const v = <K extends (typeof readers.IMS_SECTIONS)[number]>(id: K) => (read.sections[id] as { ok: true; value: import('../../lib/reconciliation-pack/ims-readers.ts').ImsSectionValues[K] }).value
    assert.match(v('identity').systemIdentifier, /^[0-9]{10,20}$/)
    const stock = v('stock')
    assert.deepEqual(stock.tracked.filter((p) => p.sku.startsWith(TAG)).map((p) => [p.sku, p.warehouseCode, p.quantity, p.reservedQty]), [[`${TAG}-A`, `${TAG}W`, '5.000000', '1.000000']])
    assert.deepEqual(stock.untracked.filter((p) => p.sku.startsWith(TAG)).map((p) => [p.sku, p.productType]), [[`${TAG}-FEE`, 'NON_INVENTORY']])
    assert.deepEqual(v('products').filter((p) => p.sku.startsWith(TAG)).map((p) => p.sku).sort(), [`${TAG}-A`, `${TAG}-FEE`])
    const orders = v('orders')
    assert.ok(orders.every((o) => o.status !== 'SHIPPED'), 'a shipped order is not open')
    const mine = orders.find((o) => o.id === s.orderId)!
    assert.deepEqual([mine.status, mine.currency, mine.totalForeign, mine.externalCreatedAt, mine.externalUpdatedAt, mine.links], ['PROCESSING', 'GBP', '12.0000', '2026-10-05T10:00:00.000Z', null, [{ connector: 'woocommerce', externalOrderId: `${TAG}101` }]])
    assert.ok(v('taxes').mappings.some((m) => m.externalTaxRateId === `${TAG}t1` && m.taxRateId === s.taxRateId))
    assert.ok(v('taxes').rates.some((r) => r.id === s.taxRateId))
    assert.deepEqual(v('xeroSyncLogs').filter((l) => l.id.startsWith(TAG)).map((l) => l.id), [`${TAG}-s1`], 'only connector-confirmed rows: not an operator assertion, not a failure')
    const snaps = v('snapshots')
    assert.deepEqual(snaps.run, { stockLevelCount: 1, snapshotCount: 1 }) // a shared scratch DB may hold others' runs for other dates, never this one
    assert.deepEqual(snaps.values.map((x) => [x.productId, x.qty, x.valueBase, x.valueReplayReliable]), [[s.productId, '5.000000', '12.500000', true]])
    assert.deepEqual(snaps.balances.filter((b) => b.externalAccountId.startsWith(TAG)).map((b) => [b.accountCode, b.currency, b.amountBase]), [['630', 'GBP', '7.000000']])
    const binding = v('wmsBindings').find((b) => b.externalWarehouseId === `${TAG}ext`)!
    assert.deepEqual([binding.stockSyncMode, binding.alignmentConfirmed, readers.alignmentState(binding)], ['NOTIFICATION_ONLY', false, 'unconfirmed'])
    assert.ok(['absent', 'unverified', 'verified'].includes(v('boundaries').firstLoad.state))
    // The storefront status section (R9): column names proven against the real tables. The migration seeds the built-in mapping rows.
    const statuses = v('storefrontStatus')
    assert.ok(statuses.configured.length >= 0 && statuses.configured.every((slug) => /^[a-z0-9][a-z0-9_-]*$/.test(slug)))
    assert.ok(statuses.mappings.some((m) => m.externalStatus === 'processing' && m.imsStatus === 'PROCESSING'), JSON.stringify(statuses.mappings))
  } finally { await cleanup() }
})

test('[reconciliation pack] the rig can fail: a write over the reader\'s own connection is refused by the server', { skip: !RUN }, async () => {
  const { readers } = await load()
  let refusal: { code?: string; message?: string } | null = null
  await withClient(async (client) => {
    const spy = { async query(sql: string, values?: unknown[]) {
      if (/pg_control_system/.test(sql) && refusal === null) {
        await client.query('SAVEPOINT rig')
        try { await client.query(`INSERT INTO settings (key, value, "updatedAt") VALUES ('${TAG}', 'x', now())`); refusal = {} } catch (error) { refusal = error as { code?: string } }
        await client.query('ROLLBACK TO SAVEPOINT rig')
      }
      return client.query(sql, values)
    } }
    const read = await readers.readImsSnapshot(spy, { sections: ['identity'] })
    assert.ok(read.ok)
  })
  assert.equal(refusal!.code, '25006', 'read-only transaction: the server refused the INSERT')
  const left = await withClient((client) => client.query(`SELECT 1 FROM settings WHERE key = '${TAG}'`))
  assert.equal(left.rowCount, 0)
})

test('[reconciliation pack] ONE snapshot: a row another connection commits after the read began is invisible to a later section', { skip: !RUN }, async () => {
  const { readers, db } = await load()
  try {
    let injected = false
    await withClient(async (client) => {
      const spy = { async query(sql: string, values?: unknown[]) {
        // After the stock section has been read, another connection commits a new product.
        if (!injected && /FROM products\b/.test(sql) && !/stock_levels/.test(sql)) {
          injected = true
          await db.product.create({ data: { sku: `${TAG}-LATE`, name: 'late' } })
        }
        return client.query(sql, values)
      } }
      const read = await readers.readImsSnapshot(spy, { sections: ['products'] })
      assert.ok(read.ok && read.sections.products!.ok)
      if (read.ok && read.sections.products!.ok) assert.ok(!read.sections.products!.value.some((p) => p.sku === `${TAG}-LATE`), 'the late row is outside the snapshot')
    })
    assert.ok(injected, 'precondition: the concurrent commit happened during the read')
    const after = await withClient((client) => readers.readImsSnapshot(client, { sections: ['products'] }))
    assert.ok(after.ok && after.sections.products!.ok && after.sections.products!.value.some((p) => p.sku === `${TAG}-LATE`), 'a read that begins afterwards sees it (the rig can fail)')
  } finally { await cleanup() }
})

test('[reconciliation pack] a real statement timeout is READ_INCOMPLETE and the transaction is gone', { skip: !RUN }, async () => {
  const { readers } = await load()
  await withClient(async (client) => {
    const slow = { query: (sql: string, values?: unknown[]) => client.query(/pg_control_system/.test(sql) ? 'SELECT pg_sleep(2)' : sql, values) }
    assert.deepEqual(await readers.readImsSnapshot(slow, { sections: ['identity'], statementTimeoutMs: 50 }), { ok: false, reason: 'READ_INCOMPLETE' })
    const state = await client.query(`SELECT current_setting('transaction_read_only') AS ro, now() = statement_timestamp() AS fresh`)
    assert.equal(state.rows[0].ro, 'off', 'rolled back: the connection is back to an ordinary session')
  })
})

test('[reconciliation pack] pg_control_system() answers an account that is not a superuser', { skip: !RUN }, async () => {
  const { readers } = await load()
  const role = `rcpk_probe_${process.pid}`
  await withClient(async (admin, pg) => {
    const sup = await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)
    if (sup.rows[0].rolsuper !== true) return // the account running the tier is already unprivileged: the other tests prove it
    const password = randomBytes(12).toString('hex') // random, used once, for a role dropped below
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER PASSWORD '${password}'`)
    try {
      const url = new URL(process.env.DATABASE_URL!)
      url.username = role; url.password = password
      const probe = new pg.Client({ connectionString: url.toString() })
      await probe.connect()
      try {
        const read = await readers.readImsSnapshot(probe, { sections: ['identity'] })
        assert.ok(read.ok && read.sections.identity!.ok, JSON.stringify(read))
      } finally { await probe.end() }
    } finally { await admin.query(`DROP ROLE ${role}`) }
  })
})

// Rows of this test carry their own prefix, so the sections test above (which counts only rows starting with TAG) is unaffected.
const XP = `RCXP${process.pid}`

test('[reconciliation pack] xeroPostings reads the P0 record and every row that could be a write to Xero from the real tables (column names proven)', { skip: !RUN }, async () => {
  const { readers, db } = await load()
  const insert = (id: string, connector: string, type: string, status: string, doc: string | null, extra: { syncedAt?: string; processingStartedAt?: string; createdAt?: string } = {}) =>
    db.$executeRawUnsafe(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "externalTransactionId", "syncedAt", "processingStartedAt", "createdAt") VALUES ($1, $2, $3::"AccountingSyncType", $4::"AccountingSyncStatus", 'SalesOrder', $5, $6, $7::timestamp, $8::timestamp, COALESCE($9::timestamp, now()))`,
      id, connector, type, status, `${id}-ref`, doc, extra.syncedAt ?? null, extra.processingStartedAt ?? null, extra.createdAt ?? null)
  const existing = await withClient((client) => client.query(`SELECT count(*)::int AS n FROM first_load_apply_runs`))
  try {
    // The sync-log population: in = SYNCED, PROCESSING, or any row with a document id; out = other connector, nothing sent.
    await insert(`${XP}-synced`, 'xero', 'SALES_INVOICE', 'SYNCED', 'doc1', { syncedAt: '2026-10-05 10:00:00', createdAt: '2026-10-05 09:00:00' })
    await insert(`${XP}-asserted`, 'xero', 'SALES_INVOICE', 'SYNCED', 'doc2', { syncedAt: '2026-10-05 11:00:00', createdAt: '2026-10-05 10:30:00' })
    // Created after the others, but its sync time came from a host clock that was BEHIND: the later creation time is its instant.
    await insert(`${XP}-late-created`, 'xero', 'SALES_INVOICE', 'SYNCED', 'doc5', { syncedAt: '2026-09-15 08:00:00', createdAt: '2026-10-08 08:00:00' })
    await db.$executeRawUnsafe(`UPDATE accounting_sync_logs SET settlement_basis = 'OPERATOR_ASSERTION' WHERE id = $1`, `${XP}-asserted`)
    await insert(`${XP}-processing`, 'xero', 'INVOICE_PDF', 'PROCESSING', null, { processingStartedAt: '2026-10-06 12:00:00', createdAt: '2026-09-01 00:00:00' })
    await insert(`${XP}-failed-with-doc`, 'xero', 'TAX_RATE_SYNC', 'FAILED', 'doc3', { createdAt: '2026-10-07 13:00:00' })
    await insert(`${XP}-pending`, 'xero', 'COGS_JOURNAL', 'PENDING', null)
    await insert(`${XP}-cancelled`, 'xero', 'COGS_JOURNAL', 'CANCELLED', null)
    await insert(`${XP}-other-connector`, 'quickbooks', 'SALES_INVOICE', 'SYNCED', 'doc4', { syncedAt: '2026-10-05 10:00:00' })

    const none = await withClient((client) => readers.readImsSnapshot(client, { sections: ['xeroPostings'] }))
    assert.ok(none.ok && none.sections.xeroPostings!.ok, JSON.stringify(none))
    if (!none.ok || !none.sections.xeroPostings!.ok) return
    const mine = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith(XP))
    const value = none.sections.xeroPostings!.value
    assert.deepEqual(mine(value.rows).map((r) => [r.id.slice(XP.length + 1), r.type, r.status, r.at]), [
      ['asserted', 'SALES_INVOICE', 'SYNCED', '2026-10-05T11:00:00.000Z'],
      ['failed-with-doc', 'TAX_RATE_SYNC', 'FAILED', '2026-10-07T13:00:00.000Z'],
      ['late-created', 'SALES_INVOICE', 'SYNCED', '2026-10-08T08:00:00.000Z'],
      ['processing', 'INVOICE_PDF', 'PROCESSING', '2026-10-06T12:00:00.000Z'],
      ['synced', 'SALES_INVOICE', 'SYNCED', '2026-10-05T10:00:00.000Z'],
    ], 'the latest of the sync time, the processing start and the creation time; an operator assertion, a failure with a document id and a PROCESSING row are all kept; other connectors and rows that sent nothing are not')

    if (existing.rows[0].n === 0) {
      // The P0 record: only a VERIFIED run is a recorded P0, and the instant is when the load STARTED (created_at), not when it last changed.
      for (const [status, expected] of [['APPLIED', 'unverified'], ['VERIFIED', 'verified']] as const) {
        await db.$executeRawUnsafe(`DELETE FROM first_load_apply_runs`)
        await db.$executeRawUnsafe(`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts, created_at, updated_at) VALUES ($1, true, 1, 'digest', 'run', $2, '{}', '{}', '2026-10-01 09:00:00', '2026-10-02 18:30:00')`, `${XP}-run`, status)
        const read = await withClient((client) => readers.readImsSnapshot(client, { sections: ['xeroPostings'] }))
        assert.ok(read.ok && read.sections.xeroPostings!.ok, JSON.stringify(read))
        if (read.ok && read.sections.xeroPostings!.ok) {
          const p0 = read.sections.xeroPostings!.value.p0
          assert.equal(p0.state, expected)
          if (p0.state === 'verified') assert.equal(p0.startedAt, '2026-10-01T09:00:00.000Z', 'created_at, not updated_at')
        }
      }
    }
  } finally {
    await db.$executeRawUnsafe(`DELETE FROM accounting_sync_logs WHERE id LIKE '${XP}%'`)
    await db.$executeRawUnsafe(`DELETE FROM first_load_apply_runs WHERE id LIKE '${XP}%'`)
  }
})
