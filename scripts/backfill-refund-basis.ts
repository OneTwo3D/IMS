/**
 * o3d-lvk: stamp `totalsBasis` on refunds written before the totals_basis migration.
 *
 * WHY IT MATTERS OPERATIONALLY. o3d-w00's fail-closed (PR #516) refuses and quarantines a second
 * refund on an order whose EARLIER refund has a NULL basis, because a legacy total may be GROSS and
 * summing it with a new NET total can over-refund. Every pre-migration refund has a NULL basis, so
 * every order that already carried one now quarantines its next refund. This is what stops that.
 *
 * It stamps ONLY where the evidence is unanimous. An UNKNOWN refund is left NULL and keeps failing
 * closed, which is the safe default — a wrong basis silently changes what a later refund may post.
 *
 * Usage:
 *   tsx scripts/backfill-refund-basis.ts [--dry-run] [--yes] [--allow-production] [--limit N]
 *
 * --dry-run reports exactly what a real run would stamp, because the decision is computed by the
 * same pure function the write path uses.
 */
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { config } from 'dotenv'

import {
  planRefundBasisBackfill,
  applyRefundBasisBackfill,
  type RefundBasisBackfillOrder,
} from '../lib/domain/sales/refund-basis-backfill'

// .env MUST load before lib/db is imported: that module builds its pg Pool from
// process.env.DATABASE_URL at IMPORT time, so a static import here would construct a pool with no
// connection string and fail with an opaque SASL "client password must be a string".
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function numericArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function main() {
  const { db } = await import('../lib/db/index')
  const dryRun = hasFlag('dry-run')
  const assumeYes = hasFlag('yes')
  const allowProduction = hasFlag('allow-production')
  const limit = numericArg('limit', 5000)

  if (process.env.NODE_ENV === 'production' && !allowProduction) {
    throw new Error('Refusing to run the refund-basis backfill in production without --allow-production')
  }

  // Only orders that HAVE an unstamped refund are worth loading. Anything else cannot change.
  const orders = await db.salesOrder.findMany({
    where: { refunds: { some: { totalsBasis: null } } },
    select: {
      id: true,
      lines: { select: { id: true, productId: true, qty: true, totalBase: true, taxBase: true } },
      refunds: {
        select: {
          id: true,
          totalsBasis: true,
          lines: { select: { productId: true, salesOrderLineId: true, qty: true, totalBase: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  const plan = await planRefundBasisBackfill(orders as unknown as RefundBasisBackfillOrder[])

  console.log(`orders scanned:            ${orders.length}${orders.length === limit ? ` (LIMIT reached — rerun for the rest)` : ''}`)
  console.log(`refunds already stamped:   ${plan.alreadyStamped}`)
  console.log(`refunds to stamp:          ${plan.decisions.length}`)
  console.log(`  NET:                     ${plan.decisions.filter((d) => d.basis === 'NET').length}`)
  console.log(`  GROSS:                   ${plan.decisions.filter((d) => d.basis === 'GROSS').length}`)
  console.log(`refunds left UNRESOLVED:   ${plan.unresolved.length} (stay NULL, keep failing closed)`)

  if (plan.unresolved.length > 0) {
    console.log('\norders whose next refund will STILL quarantine:')
    for (const u of plan.unresolved.slice(0, 20)) console.log(`  order ${u.orderId} refund ${u.refundId}`)
    if (plan.unresolved.length > 20) console.log(`  ... and ${plan.unresolved.length - 20} more`)
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.')
    await db.$disconnect()
    return
  }
  if (plan.decisions.length === 0) {
    console.log('\nnothing to stamp.')
    await db.$disconnect()
    return
  }

  if (!assumeYes) {
    const rl = createInterface({ input, output })
    const answer = await rl.question(`\nStamp ${plan.decisions.length} refund(s)? [y/N] `)
    rl.close()
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('aborted.')
      await db.$disconnect()
      return
    }
  }

  const result = await db.$transaction((tx) => applyRefundBasisBackfill(tx, plan.decisions))
  console.log(`\nstamped: ${result.stamped}`)
  if (result.skippedRaced > 0) {
    // Reported rather than swallowed: the plan and the outcome disagreeing means something else
    // stamped those rows between planning and applying, which is worth knowing about.
    console.log(`skipped (stamped concurrently): ${result.skippedRaced}`)
  }
  await db.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
