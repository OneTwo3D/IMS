/**
 * `npm run first-load:mintsoft-archive`: the DRY-RUN PLANNER for archiving, in the WMS, every product the owner set to Archived on the lifecycle review
 * sheet. A function so tests drive it without a subprocess; scripts/first-load-mintsoft-archive.ts is a thin wrapper that supplies the WMS reader.
 *
 * READ-ONLY. It reads the SAME run manifest as first-load:prepare, with the owner's filled sheet bound to its generation record (`lifecycleReview` and the
 * `lifecycle-decisions` input), runs the transform exactly as a real prepare does (pure: nothing is written) and takes the products whose lifecycle comes
 * from an owner decision and is ARCHIVED. It refuses the plan when the decisions are not usable (not bound, a refused or missing decision, the review set
 * changed or unchecked): archiving in the WMS follows the import, never a sheet that would not import. It then reads the WMS product census and physical
 * stock through the injected reader (GET only) and prints, per SKU, what would change and why every other SKU would not, with a confirmation token
 * derived from the plan.
 *
 * THE WRITE IS NOT BUILT. `--execute` is refused before anything is read: the WMS product-update request that sets the discontinued flag has not been
 * verified (docs/first-load-input-spec.md "Mintsoft archive for Archived decisions" lists what is unknown). Nothing here can write; no credential is printed.
 */
import { loadPrepareRun, type CliIo } from '../cli'
import { EXIT_CODES } from '../spec'
import { ConfigError, prepare } from '../transform'
import { buildArchivePlan, isRefused, type ArchivePlan, type WmsCensus } from './plan'

export const MINTSOFT_ARCHIVE_EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: string; meaning: string }> = [
  { code: EXIT_CODES.OK, name: 'OK', meaning: 'The plan was printed and no SKU is refused (it may be empty).' },
  { code: EXIT_CODES.BLOCKING_FINDINGS, name: 'BLOCKING_FINDINGS', meaning: 'The plan was printed and at least one Archived SKU is refused (not found, a bundle, no discontinued flag, or physical stock above zero): resolve each before any write.' },
  { code: EXIT_CODES.USAGE, name: 'USAGE', meaning: 'Bad command line, an invalid run manifest, or --execute (the write is not built). Nothing was read or requested.' },
  { code: EXIT_CODES.INPUT_UNUSABLE, name: 'INPUT_UNUSABLE', meaning: 'An input cannot be used: a manifest file, the decisions not bound to a verified review sheet, a refused or missing decision, a review set that changed or cannot be checked, or the WMS credentials file refused or its census unreadable. Nothing was planned.' },
]

/** The WMS reader the script injects (lib/first-load never names a connector). */
export interface WmsCensusReader {
  /** The option that names its env file, for example `--<connector>-env-file`. */
  flag: string
  /** The WMS as the operator knows it, for headers and messages. */
  label: string
  /** Reads the census with GET requests only. Throws `WmsCensusRefused` before any request, or `WmsCensusFailed`; neither message carries a credential. */
  read: (envFile: string) => Promise<WmsCensus>
}

export class WmsCensusRefused extends Error {}
export class WmsCensusFailed extends Error {}

export function usageText(reader?: Pick<WmsCensusReader, 'flag' | 'label'>): string {
  const flag = reader?.flag ?? '--wms-env-file'
  const label = reader?.label ?? 'WMS'
  return [
    `Usage: first-load-mintsoft-archive --manifest <run.json> ${flag} <file>`,
    '',
    `Plans archiving (discontinuing) in ${label} every product the owner set to Archived on the lifecycle review sheet. A DRY RUN: it reads, prints the plan and writes nothing.`,
    '',
    '  --manifest <file>  the first-load run manifest with lifecycleReview.generation and the lifecycle-decisions input (the filled review sheet)',
    `  ${flag} <file>  the read-only ${label} credentials file (mode 600), the same one first-load:lifecycle-review reads`,
    `  --execute          REFUSED: the ${label} write is not built (its request shape is unverified)`,
    '  --help             this text',
    '',
    'Exit codes:',
    ...MINTSOFT_ARCHIVE_EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

class UsageError extends Error {}

function parseArgs(argv: string[], reader: WmsCensusReader): { manifest: string; envFile: string } | 'help' | 'execute' {
  let manifest: string | null = null
  let envFile: string | null = null
  let execute = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') return 'help'
    else if (arg === '--manifest') manifest = value()
    else if (arg === reader.flag) envFile = value()
    else if (arg === '--execute') execute = true
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)} (credentials are never accepted on the command line: put them in the env file)`)
  }
  if (execute) return 'execute'
  if (manifest === null) throw new UsageError('--manifest is required')
  if (envFile === null) throw new UsageError(`${reader.flag} is required (the plan is made against what ${reader.label} holds now)`)
  return { manifest, envFile }
}

const DECISION_CODES = new Set(['LIFECYCLE_DECISIONS_NOT_BOUND', 'LIFECYCLE_DECISION_MISSING', 'LIFECYCLE_REVIEW_SET_CHANGED', 'LIFECYCLE_REVIEW_SET_UNCHECKED'])

export async function runMintsoftArchiveCli(argv: string[], io: CliIo, reader: WmsCensusReader): Promise<number> {
  const tool = 'first-load-mintsoft-archive'
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv, reader)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${tool}: ${error.message}\n\n${usageText(reader)}`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  if (args === 'help') {
    io.stdout(usageText(reader))
    return EXIT_CODES.OK
  }
  if (args === 'execute') {
    io.stderr(`${tool}: --execute is refused: the ${reader.label} write is NOT BUILT. The request that sets a product's discontinued flag has not been verified (which route and field, whether a partial body leaves every other field untouched, what the answer looks like, and how a read-back shows it). Nothing was read, requested or written. Run without --execute for the dry-run plan; see docs/first-load-input-spec.md "Mintsoft archive for Archived decisions".\n`)
    return EXIT_CODES.USAGE
  }

  // ---- the decisions, bound and applied exactly as a real first-load:prepare does ----
  const loaded = loadPrepareRun(args.manifest, io, { runId: null }, tool, () => usageText(reader))
  if (!loaded.ok) return loaded.exit
  const run = loaded.run
  const refuse = (problems: string[]): number => {
    io.stderr(`${tool}: the plan cannot be made, nothing was requested:\n${problems.slice(0, 20).map((p) => `  - ${p}\n`).join('')}${problems.length > 20 ? `  ... and ${problems.length - 20} more\n` : ''}`)
    return EXIT_CODES.INPUT_UNUSABLE
  }
  if (!run.datasets['lifecycle-decisions'] || run.manifest.lifecycleReview === null) return refuse(['the manifest names no lifecycle-decisions input and lifecycleReview.generation: the plan is made from the owner\'s filled review sheet, bound to its generation record'])
  let result
  try {
    result = prepare({ config: run.config, datasets: run.datasets, variantParentsBinding: run.variantParentsBinding, productStatusBinding: run.productStatusBinding, lifecycleDecisionsBinding: run.lifecycleDecisionsBinding, lifecycleReviewInputs: run.lifecycleReviewInputs, dryRun: false })
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${tool}: invalid run configuration: ${error.message}\n`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  const binding = run.lifecycleDecisionsBinding
  const problems: string[] = []
  for (const f of result.report.findings) if (f.severity === 'ERROR' && (f.dataset === 'lifecycle-decisions' || DECISION_CODES.has(f.code))) problems.push(`${f.code}: ${f.message}`)
  for (const d of result.report.dispositions) if (d.dataset === 'lifecycle-decisions' && d.outcome === 'REJECTED') problems.push(`decision ${d.key} refused (${d.code}): ${d.reason}`)
  if (binding === undefined || !binding.verified) problems.push('the lifecycle decisions are not bound to a verified review sheet')
  if (problems.length > 0 || binding === undefined || !binding.verified) return refuse(problems)

  // ---- what the WMS holds now (GET only, through the injected reader) ----
  let census: WmsCensus
  try {
    census = await reader.read(args.envFile)
  } catch (error) {
    if (error instanceof WmsCensusRefused || error instanceof WmsCensusFailed) return refuse([`${reader.label}: ${error.message}`])
    throw error
  }
  const plan = buildArchivePlan({ sheetId: binding.sheetId, catalogue: result.catalogue, skuRenames: result.skuRenames, census, wmsLabel: reader.label })
  io.stdout(renderPlan(plan, reader.label, census, result.blocking))
  return plan.rows.some((r) => isRefused(r.outcome)) ? EXIT_CODES.BLOCKING_FINDINGS : EXIT_CODES.OK
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length))

export function renderPlan(plan: ArchivePlan, label: string, census: WmsCensus, prepareBlocking: boolean): string {
  const lines: string[] = [
    `${label} archive plan for the review sheet ${plan.sheetId} (DRY RUN: nothing was written)`,
    `  ${plan.rows.length} product(s) the owner set to Archived; ${label} read with GET requests only (${census.products.length} product(s), the physical stock of warehouse(s) ${census.warehouses.join(', ')})`,
    `  would archive ${plan.counts.WOULD_ARCHIVE}; already discontinued ${plan.counts.SKIP_ALREADY_DISCONTINUED}; not a ${label} product ${plan.counts.SKIP_NOT_A_WMS_PRODUCT}; refused ${plan.counts.REFUSED_NOT_FOUND + plan.counts.REFUSED_BUNDLE + plan.counts.REFUSED_FLAG_NOT_STATED + plan.counts.REFUSED_STOCK} (not found ${plan.counts.REFUSED_NOT_FOUND}, bundle ${plan.counts.REFUSED_BUNDLE}, no flag ${plan.counts.REFUSED_FLAG_NOT_STATED}, stock ${plan.counts.REFUSED_STOCK})`,
  ]
  if (prepareBlocking) lines.push('  NOTE: a real first-load:prepare of this manifest is blocked by other findings (not the decisions): the import has not happened yet')
  lines.push('', `  ${pad('SKU', 28)} ${pad('outcome', 26)} ${pad(`${label} id`, 12)} ${pad('DisCont', 8)} ${pad('stock', 6)} reason`)
  for (const r of plan.rows) {
    lines.push(`  ${pad(r.sku, 28)} ${pad(r.outcome, 26)} ${pad(r.productId ?? '-', 12)} ${pad(r.discontinued === null ? '-' : String(r.discontinued), 8)} ${pad(r.stock === null ? '-' : String(r.stock), 6)} ${r.reason}`)
  }
  lines.push('', `  plan token: ${plan.token} (derived from every row above; any change gives another token)`, `  plan digest: ${plan.digest}`, '')
  return lines.join('\n')
}
