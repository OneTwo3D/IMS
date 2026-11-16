/**
 * READ-ONLY report: what the GTIN/MPN identifier split would do to the identifiers IMS holds today (o3d-mu0a).
 *
 * Reclassifies every Product.barcode (with Product.mpn) by shape, using the same classifier the Mintsoft and
 * WooCommerce syncs use, and lists what WOULD move to mpn and what lands in leftover. It performs no write of any
 * kind (one SELECT), so it is safe to run against any database, including production. Production gets no backfills.
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/report-identifier-reclassification.ts [--json]
 *
 * `leftover` rows are two codes for one slot (two part numbers, or two GTINs). They are reported, never resolved.
 */

import { db } from '@/lib/db'
import { buildIdentifierReport } from '@/lib/domain/products/identifier-report'

async function main() {
  const json = process.argv.includes('--json')
  const products = await db.product.findMany({
    where: { OR: [{ barcode: { not: null } }, { mpn: { not: null } }] },
    select: { sku: true, barcode: true, mpn: true },
    orderBy: { sku: 'asc' },
  })
  const report = buildIdentifierReport(products)

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`Identifier reclassification (read-only) @ ${new Date().toISOString()}`)
  console.log(`  products with a barcode or MPN: ${report.withIdentifiers}`)
  for (const [action, count] of Object.entries(report.counts)) console.log(`  ${action.padEnd(24)} ${count}`)
  for (const row of report.rows) {
    console.log(`\n[${row.action}] ${row.sku}`)
    console.log(`  now:   barcode=${row.barcode ?? '(none)'}  mpn=${row.mpn ?? '(none)'}`)
    console.log(`  after: gtin=${row.gtin || '(none)'}  mpn=${row.newMpn || '(none)'}${row.leftover ? `  LEFTOVER=${row.leftover}` : ''}`)
  }
  console.log('\nNothing was written. leftover rows need a human decision; they are never guessed.')
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
