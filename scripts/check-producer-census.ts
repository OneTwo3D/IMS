/**
 * Run the producer census over the whole tree (see scripts/producer-census.ts for what it does and
 * does not catch). Exits 1 with every failure listed, 2 when the census itself could not run.
 *
 *   npm run check:producer-census            report; non-zero on any failure
 *   tsx scripts/check-producer-census.ts --list   print every site found (to write declarations from)
 */
import { DECLARATIONS, EXCLUDED_OPERATIONS, NO_PRODUCER } from './producer-census-declarations'
import { formatCounts, reconcile, scanTree } from './producer-census'
import { formatWooCounts, runWooCensus } from './producer-census-woocommerce'

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
    sources: scan.sources,
  })
  console.log(formatCounts(report))
  // The WooCommerce half: what each WooCommerce writer does about the producer-side hold, and every raw WooCommerce write found.
  const woo = runWooCensus(process.cwd(), DECLARATIONS, new Set(scan.sites.map((site) => site.key)), NO_PRODUCER)
  console.log(formatWooCounts(woo.counts))
  const failures = [...report.failures, ...woo.failures]
  if (scan.filesScanned >= 800 && (woo.counts.seamFunctions === 0 || woo.counts.transportWrites === 0 || woo.counts.outboxEnqueueSites === 0)) {
    failures.push(`SUBJECT NOT REACHED: the WooCommerce census saw ${woo.counts.seamFunctions} seam function(s), ${woo.counts.transportWrites} transport write(s) and ${woo.counts.outboxEnqueueSites} outbox enqueue site(s); each must be above zero on this tree.`)
  }
  if (failures.length > 0) {
    console.error(`\nproducer census FAILED with ${failures.length} finding(s):\n`)
    for (const failure of failures) console.error(`  - ${failure}\n`)
    return 1
  }
  console.log('producer census: OK (every producer call site is declared; every declaration matches a site)')
  return 0
}

process.exitCode = main()
