/**
 * o3d-zjsb5.9: THE PRODUCTCOMPONENT <-> BOM/BOMITEM CONSISTENCY CHECK, as a command.
 *
 * IMS stores a manufactured product's recipe twice and the schema has NO constraint tying the two
 * copies together, so this is the only thing that catches a divergence. Read-only: it opens no
 * transaction and writes nothing.
 *
 * Usage:
 *   tsx scripts/check-bom-recipe-consistency.ts            # human-readable, exit 1 on any drift
 *   tsx scripts/check-bom-recipe-consistency.ts --json      # machine-readable
 *
 * EXIT 1 ON DRIFT IS THE POINT. A check that reports and exits 0 is a check nobody notices, and
 * this one exists precisely because the failure it detects is silent everywhere else: a BOM with a
 * ProductComponent recipe and no BomItem rows is sellable, passes every database guard, and is
 * invisible to replenishment planning and reorder-MO generation.
 *
 * NOT IN `check:all`. Everything in that target is a static source check that runs with no
 * database; this one needs a live DATABASE_URL, so wiring it in would make `check:all` fail on any
 * machine without one and teach people to ignore it.
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported — that module builds its pg Pool from
// process.env.DATABASE_URL at import time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

async function main() {
  const { db } = await import('../lib/db/index')
  const { findBomRecipeDrift } = await import('../lib/products/bom-recipe')
  const asJson = process.argv.includes('--json')

  const drift = await findBomRecipeDrift(db)

  if (asJson) {
    console.log(JSON.stringify({ driftCount: drift.length, drift }, null, 2))
  } else if (drift.length === 0) {
    console.log('BOM recipe consistency: OK — product_components and bom_items agree for every BOM product.')
  } else {
    console.error(`BOM recipe consistency: ${drift.length} problem(s) found.`)
    for (const row of drift) {
      console.error(`  [${row.kind}] ${row.detail}`)
    }
    console.error(
      '\nTo repair: re-import the affected products through the products CSV (the `components` column '
      + 'writes BOTH representations in one transaction). See help-docs/importing-data.md.',
    )
  }

  await db.$disconnect()
  process.exit(drift.length === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
