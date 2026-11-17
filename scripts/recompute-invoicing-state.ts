/**
 * Re-derive SalesOrder.invoicingState for every order. Idempotent: run it twice and the second run changes nothing.
 *
 * WHY THE MIGRATION DOES NOT DO ALL OF IT. The migration sets FULLY_INVOICED on every order with invoice evidence (a conservative
 * SQL rule), so no stored value is wrong after an upgrade. It cannot detect a PARTIAL: that needs the stored invoice lines against the
 * order's lines, and the standing rules, which are single-sourced in lib/domain/sales/invoicing-state.ts (a SQL copy would drift). This
 * refines those, and is the repair to run after a data restore or after a write that bypassed the write sites.
 *
 * Usage:
 *   tsx scripts/recompute-invoicing-state.ts [--dry-run] [--batch N]
 *
 * --dry-run reports how many orders a real run would change, by the same derivation, and writes nothing.
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported (it builds its pool from DATABASE_URL at import time).
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function numericArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function main() {
  const { db } = await import('../lib/db/index')
  const { repairInvoicingStates } = await import('../lib/domain/sales/invoicing-state')
  const dryRun = process.argv.includes('--dry-run')
  const limit = numericArg('batch', 500)
  let examined = 0
  let changed = 0
  let after: string | null = null
  for (;;) {
    const page = await repairInvoicingStates(db as never, { limit, after, dryRun })
    examined += page.examined
    changed += page.changed
    if (!page.nextCursor) break
    after = page.nextCursor
  }
  console.log(`${dryRun ? 'Would change' : 'Changed'} ${changed} of ${examined} sales orders.`)
  await db.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
