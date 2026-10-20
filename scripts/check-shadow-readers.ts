/**
 * Run the shadow-reader census over the whole tree (see scripts/shadow-reader-census.ts). Exits 1 with every failure listed, 2 when the
 * census itself could not run.
 *
 *   npm run check:shadow-readers          report; non-zero on any failure
 *   tsx scripts/check-shadow-readers.ts --list   print every site found (to write declarations from)
 */
import { DECLARATIONS } from './shadow-reader-declarations'
import { MIN_FILES, MIN_SITES_BY_FAMILY, reconcile, scanTree, summarise } from './shadow-reader-census'

function main(): number {
  let scan
  try {
    scan = scanTree(process.cwd())
  } catch (error) {
    console.error(`shadow-reader census could not run: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (process.argv.includes('--list')) for (const site of scan.sites) console.log(`${site.key}\tx${site.count}\t${site.file}:${site.line}`)
  const report = reconcile(scan.sites, DECLARATIONS)
  console.log(summarise(scan, DECLARATIONS))
  const failures: string[] = [...report.malformed]
  if (scan.filesScanned < MIN_FILES) failures.push(`subject not reached: only ${scan.filesScanned} source files scanned (floor ${MIN_FILES})`)
  const byFamily = new Map<string, number>()
  for (const site of scan.sites) byFamily.set(site.family, (byFamily.get(site.family) ?? 0) + 1)
  for (const [family, floor] of Object.entries(MIN_SITES_BY_FAMILY)) {
    if ((byFamily.get(family) ?? 0) < floor) failures.push(`subject not reached: ${byFamily.get(family) ?? 0} ${family} sites found (floor ${floor})`)
  }
  for (const site of report.undeclared) failures.push(`UNDECLARED ${site.key} (x${site.count}) at ${site.file}:${site.line}: a reader of sync-row presence nobody classified under a shadow`)
  for (const key of report.stale) failures.push(`STALE ${key}: declared but no such site exists`)
  for (const m of report.moved) failures.push(`MOVED ${m.key}: declared x${m.declared}, found x${m.found}`)
  for (const failure of failures) console.error(failure)
  return failures.length === 0 ? 0 : 1
}

process.exit(main())
