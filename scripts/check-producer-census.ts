/**
 * Run the producer census over the whole tree (see scripts/producer-census.ts for what it does and
 * does not catch). Exits 1 with every failure listed, 2 when the census itself could not run.
 *
 *   npm run check:producer-census            report; non-zero on any failure
 *   tsx scripts/check-producer-census.ts --list   print every site found (to write declarations from)
 */
import { DECLARATIONS, EXCLUDED_OPERATIONS, NO_PRODUCER } from './producer-census-declarations'
import { formatCounts, reconcile, scanTree } from './producer-census'

function main(): number {
  let scan
  try {
    scan = scanTree(process.cwd())
  } catch (error) {
    console.error(`producer census could not run: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (process.argv.includes('--list')) {
    for (const site of scan.sites) console.log(`${site.key}\t${site.file}:${site.line}`)
  }
  const report = reconcile({
    sites: scan.sites,
    declarations: DECLARATIONS,
    excludedOperations: EXCLUDED_OPERATIONS,
    noProducer: NO_PRODUCER,
    filesScanned: scan.filesScanned,
  })
  console.log(formatCounts(report))
  if (report.failures.length > 0) {
    console.error(`\nproducer census FAILED with ${report.failures.length} finding(s):\n`)
    for (const failure of report.failures) console.error(`  - ${failure}\n`)
    return 1
  }
  console.log('producer census: OK (every producer call site is declared; every declaration matches a site)')
  return 0
}

process.exitCode = main()
