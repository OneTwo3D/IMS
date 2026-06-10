#!/usr/bin/env tsx

import { config as loadDotenv } from 'dotenv'
import { Pool } from 'pg'

import { runInvariantCheckPreflight } from '@/lib/cron/invariant-check-preflight'
import type { InvariantCheckPreflightResult } from '@/lib/cron/invariant-check-preflight'
import { runInvariantCheckPreflightCli } from './invariant-check-preflight.ts'

loadDotenv({ path: '.env.local', override: false, quiet: true })
loadDotenv({ path: '.env', override: false, quiet: true })

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the invariant preflight fixture')
}

const pool = new Pool({ connectionString: DATABASE_URL })
const fixtureId = `invariant-preflight-fixture-${Date.now()}`
const productId = `${fixtureId}-product`
const warehouseId = `${fixtureId}-warehouse`
const stockLevelId = `${fixtureId}-stock-level`
const warehouseCode = `IPF${Date.now().toString(36).slice(-5).toUpperCase()}`

async function cleanupFixture(): Promise<void> {
  await pool.query('DELETE FROM "stock_levels" WHERE id = $1', [stockLevelId])
  await pool.query('DELETE FROM "warehouses" WHERE id = $1', [warehouseId])
  await pool.query('DELETE FROM "products" WHERE id = $1', [productId])
}

async function seedReservedSourceMismatch(): Promise<void> {
  await cleanupFixture()
  await pool.query('BEGIN')
  try {
    await pool.query(
      `
        INSERT INTO "products" (
          id,
          sku,
          name,
          type,
          "lifecycleStatus",
          "oversellAllowed",
          active,
          "createdAt",
          "updatedAt"
        )
        VALUES ($1, $2, $3, 'SIMPLE', 'ACTIVE', false, true, NOW(), NOW())
      `,
      [productId, fixtureId, 'Invariant preflight fixture product'],
    )
    await pool.query(
      `
        INSERT INTO "warehouses" (
          id,
          code,
          name,
          type,
          country,
          active,
          "createdAt",
          "updatedAt"
        )
        VALUES ($1, $2, $3, 'STANDARD', 'GB', true, NOW(), NOW())
      `,
      [warehouseId, warehouseCode, 'Invariant preflight fixture warehouse'],
    )
    await pool.query(
      `
        INSERT INTO "stock_levels" (
          id,
          "productId",
          "warehouseId",
          quantity,
          "reservedQty",
          "updatedAt"
        )
        VALUES ($1, $2, $3, 2, 1, NOW())
      `,
      [stockLevelId, productId, warehouseId],
    )
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    throw error
  }
}

async function runCliWithCapturedPreflight(): Promise<{
  exitCode: number
  preflight: InvariantCheckPreflightResult
}> {
  let capturedPreflight: InvariantCheckPreflightResult | undefined
  const exitCode = await runInvariantCheckPreflightCli({
    runPreflight: async () => {
      capturedPreflight = await runInvariantCheckPreflight()
      return capturedPreflight
    },
  })
  if (!capturedPreflight) {
    throw new Error('Invariant preflight did not return a result')
  }
  return { exitCode, preflight: capturedPreflight }
}

async function main(): Promise<void> {
  try {
    await seedReservedSourceMismatch()

    const {
      exitCode: failingExitCode,
      preflight: seededPreflight,
    } = await runCliWithCapturedPreflight()
    if (failingExitCode !== 1 || seededPreflight?.failure !== 'critical_findings') {
      throw new Error('Expected invariant preflight to fail with critical findings from the fixture')
    }
    const seededFindingCodes = seededPreflight.result.criticalFindings.map((finding) => finding.code)
    if (!seededFindingCodes.includes('stock_reserved_source_mismatch')) {
      throw new Error(
        `Expected stock_reserved_source_mismatch from the fixture; got ${seededFindingCodes.join(', ') || 'none'}`,
      )
    }

    await cleanupFixture()

    const {
      exitCode: passingExitCode,
      preflight: cleanPreflight,
    } = await runCliWithCapturedPreflight()
    if (passingExitCode !== 0) {
      const failure = cleanPreflight.failure ?? 'unknown'
      throw new Error(`Expected invariant preflight to pass after removing the fixture data; got ${failure}`)
    }

    console.log('Invariant preflight fixture passed: seeded violation failed, cleanup pass succeeded.')
  } finally {
    await cleanupFixture().catch(() => {})
    await pool.end()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
