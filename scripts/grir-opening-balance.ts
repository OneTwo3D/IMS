/**
 * Opening GR/IR (goods received, not invoiced) balance for STAGE: derive it from the order lines received but not yet billed (or billed but not
 * yet received) that predate the GR/IR sub-ledger. Production is reinstalled and gets no backfill.
 *
 * Usage:
 *   tsx scripts/grir-opening-balance.ts [--dry-run] [--as-of YYYY-MM-DD] [--allow-production]
 *
 * --dry-run prints exactly what a real run would write (the same plan function builds both) and writes nothing. A real run is idempotent: one
 * OPENING_BALANCE row per line, keyed on the line, so re-running writes nothing new; a line that already carries live sub-ledger rows is skipped.
 * The rows are in the GR/IR sub-ledger only: nothing is posted to Xero by this script (the daily batch's reclass journal, when GR/IR posting is on,
 * picks them up like any other row).
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported: that module builds its pg Pool from process.env.DATABASE_URL at IMPORT time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function valueOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const dryRun = hasFlag('dry-run')
  if (process.env.NODE_ENV === 'production' && !hasFlag('allow-production')) {
    throw new Error('Refusing to write an opening GR/IR balance in production (it is a stage tool); pass --allow-production to override.')
  }
  const asOf = valueOf('as-of') ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`--as-of must be YYYY-MM-DD, got ${asOf}`)
  const { planGrirOpeningBalance, applyGrirOpeningBalance } = await import('../lib/domain/accounting/grir-opening-balance')
  const plan = await planGrirOpeningBalance()
  console.log(`${dryRun ? 'DRY RUN. ' : ''}Opening GR/IR as of ${asOf}: ${plan.rows.length} line(s) to open, net ${plan.totalBaseDelta} (credit-positive); ${plan.skippedWithHistory} line(s) with history left alone; ${plan.settled} line(s) settled.`)
  for (const row of plan.rows) {
    console.log(`  ${row.poReference} line ${row.poLineId}: received ${row.received} - returned ${row.returned} - billed ${row.billed} = ${row.openQty} x ${row.unitCostBase} = ${row.baseDelta}`)
  }
  if (dryRun) return
  const written = await applyGrirOpeningBalance(plan, { asOf })
  console.log(`Wrote ${written} OPENING_BALANCE row(s) (rows already present were left as they were).`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1) })
