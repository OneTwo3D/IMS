/**
 * BULK TRADE-DATA (HS code + customs description) AND COUNTRY-OF-ORIGIN CSV TOOL (o3d-zvec.20).
 *
 *   npx tsx scripts/mintsoft-bulk-product-data.ts trade <csv>            DRY RUN (default): prints a no-write comparison
 *   npx tsx scripts/mintsoft-bulk-product-data.ts coo   <csv>            DRY RUN
 *   npx tsx scripts/mintsoft-bulk-product-data.ts trade <csv> --apply    writes the values onto the IMS products
 *
 * A dry run reads the database and writes nothing; it makes no Mintsoft call. `--apply` is refused unless the setting
 * `mintsoft_product_parity_enabled` is 'true'. Applying changes IMS products only: the next Mintsoft product sync carries the values to
 * Mintsoft through its guarded writer. Mintsoft is LIVE: only the owner runs `--apply`, never an agent.
 * CSVs: trade = SKU, "customs description", and one of "EU 8 digit HS code" / "new hs code" / "EU 10 digit HS code"; coo = SKU, coo.
 * `--limit N` takes the first N rows.
 */
import { readFileSync } from 'node:fs'
import { db } from '@/lib/db'
import { runBulkProductData } from '@/lib/connectors/mintsoft/sync/bulk-product-data-run'

async function main() {
  const [kind, csvPath, ...flags] = process.argv.slice(2)
  if ((kind !== 'trade' && kind !== 'coo') || !csvPath) {
    console.error('usage: mintsoft-bulk-product-data.ts <trade|coo> <csv> [--apply] [--limit N]')
    process.exitCode = 2
    return
  }
  const limitIndex = flags.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number(flags[limitIndex + 1]) : undefined
  const result = await runBulkProductData({ kind, csvText: readFileSync(csvPath, 'utf8'), apply: flags.includes('--apply'), limit })
  console.log(result.report)
  if (result.skippedChanged.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
