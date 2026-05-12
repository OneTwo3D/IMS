#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

loadDotenv({ path: '.env.local', override: false, quiet: true })
loadDotenv({ path: '.env', override: false, quiet: true })

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required for stock quantity constraint checks.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const client = await pool.connect()

const probeId = randomUUID().replace(/-/g, '')
const productId = `constraint-product-${probeId}`
const warehouseId = `constraint-warehouse-${probeId}`

const cases = [
  {
    name: 'stock_levels blocks negative quantity',
    constraint: 'stock_levels_quantity_nonnegative',
    text: `
      INSERT INTO "stock_levels" ("id", "productId", "warehouseId", "quantity", "reservedQty", "updatedAt")
      VALUES ($1, $2, $3, -1, 0, NOW())
    `,
  },
  {
    name: 'stock_levels blocks negative reserved quantity',
    constraint: 'stock_levels_reserved_nonnegative',
    text: `
      INSERT INTO "stock_levels" ("id", "productId", "warehouseId", "quantity", "reservedQty", "updatedAt")
      VALUES ($1, $2, $3, 0, -1, NOW())
    `,
  },
  {
    name: 'cost_layers blocks negative received quantity',
    constraint: 'cost_layers_received_nonnegative',
    text: `
      INSERT INTO "cost_layers" ("id", "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostBase", "receivedAt", "isOpeningStock")
      VALUES ($1, $2, $3, -1, 0, 1, NOW(), FALSE)
    `,
  },
  {
    name: 'cost_layers blocks negative remaining quantity',
    constraint: 'cost_layers_remaining_qty_non_negative',
    text: `
      INSERT INTO "cost_layers" ("id", "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostBase", "receivedAt", "isOpeningStock")
      VALUES ($1, $2, $3, 1, -1, 1, NOW(), FALSE)
    `,
  },
  {
    name: 'cost_layers blocks remaining quantity above received quantity',
    constraint: 'cost_layers_remaining_qty_lte_received_qty',
    text: `
      INSERT INTO "cost_layers" ("id", "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostBase", "receivedAt", "isOpeningStock")
      VALUES ($1, $2, $3, 1, 2, 1, NOW(), FALSE)
    `,
  },
  {
    name: 'stock_movements blocks negative movement quantity',
    constraint: 'stock_movements_qty_nonnegative',
    text: `
      INSERT INTO "stock_movements" ("id", "type", "productId", "qty", "createdAt")
      VALUES ($1, 'ADJUSTMENT', $2, -1, NOW())
    `,
  },
]

function makeProbeRowId(name) {
  return `${name}-${randomUUID().replace(/-/g, '').slice(0, 18)}`
}

try {
  await client.query('BEGIN')

  await client.query(
    `
      INSERT INTO "products" ("id", "sku", "name", "updatedAt")
      VALUES ($1, $2, $3, NOW())
    `,
    [productId, `CONSTRAINT-${probeId.slice(0, 12)}`, 'Constraint Probe Product'],
  )

  await client.query(
    `
      INSERT INTO "warehouses" ("id", "code", "name", "updatedAt")
      VALUES ($1, $2, $3, NOW())
    `,
    [warehouseId, `QC${probeId.slice(0, 10).toUpperCase()}`, 'Constraint Probe Warehouse'],
  )

  for (const testCase of cases) {
    const savepoint = `sp_${testCase.constraint}`
    await client.query(`SAVEPOINT ${savepoint}`)

    let caught = null
    try {
      if (testCase.constraint.startsWith('stock_movements')) {
        await client.query(testCase.text, [makeProbeRowId('movement'), productId])
      } else {
        await client.query(testCase.text, [makeProbeRowId('row'), productId, warehouseId])
      }
    } catch (error) {
      caught = error
    }

    assert.ok(caught, `${testCase.name} should fail`)
    assert.equal(
      caught.constraint,
      testCase.constraint,
      `${testCase.name} should fail with ${testCase.constraint}`,
    )

    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  }

  await client.query('ROLLBACK')
  console.log(`Verified ${cases.length} stock quantity CHECK constraints.`)
} finally {
  client.release()
  await pool.end()
}
