/**
 * `npm run first-load:lifecycle-review`: the OWNER LIFECYCLE REVIEW SHEET, as a function so tests drive it without a subprocess.
 * scripts/first-load-lifecycle-review.ts is a thin wrapper that supplies the WMS reader.
 *
 * READ-ONLY. It reads the SAME run manifest as first-load:prepare (the Qoblex exports through their column maps, the WooCommerce snapshot bundle, the
 * sku-renames), verifies the snapshot bundle exactly as prepare does, runs the transform as a dry run WITHOUT any lifecycle decision (so the sheet
 * shows the lifecycle the first load would set today), and optionally reads the WMS product and stock listing through the injected reader (GET only).
 * It writes two files into a NEW directory, each mode 600: the sheet (lifecycle-review.xlsx) and its generation record
 * (lifecycle-review.generation.json), which `first-load:prepare` binds the filled sheet to. Nothing is written anywhere else; no credential is printed.
 *
 * The WMS is optional: without its env file the WMS columns read "not read", the Notes say so, and an Archived decision then always needs an override reason.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPrepareRun, type CliIo } from '../cli'
import { canonicalJson } from '../snapshot'
import { EXIT_CODES } from '../spec'
import { ConfigError, prepare } from '../transform'
import { buildGeneration, LIFECYCLE_REVIEW_FILE_NAMES, renderGeneration } from './generation'
import { buildReviewModel, ReviewModelError, type QoblexProductRow, type QoblexStockRow, type WmsListing } from './model'
import { readDecisionFile } from './read-back'
import { notesFor, renderReviewSheet } from './sheet'

export const LIFECYCLE_REVIEW_EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: string; meaning: string }> = [
  { code: EXIT_CODES.OK, name: 'OK', meaning: 'The sheet and its generation record were written.' },
  { code: EXIT_CODES.USAGE, name: 'USAGE', meaning: 'Bad command line or an invalid run manifest. Nothing was read, requested or written.' },
  { code: EXIT_CODES.INPUT_UNUSABLE, name: 'INPUT_UNUSABLE', meaning: 'An input cannot be used: a manifest file or column map, the products or stock-lots dataset missing, the WooCommerce snapshot bundle not verified, or the WMS env file refused or its listing unreadable. Nothing was written.' },
  { code: EXIT_CODES.OUTPUT_FAILED, name: 'OUTPUT_FAILED', meaning: 'The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again.' },
  { code: EXIT_CODES.INTERNAL, name: 'INTERNAL', meaning: 'A self-check of this command failed (the sheet just written does not read back). A defect in the tool.' },
]

/** The WMS reader the script injects (lib/first-load never names a connector). */
export interface WmsReader {
  /** The option that names its env file, for example `--<connector>-env-file`. */
  flag: string
  /** The WMS as the operator knows it, for headers and messages. */
  label: string
  /** Reads the listing with GET requests only. Throws `WmsReadRefused` before any request, or `WmsReadFailed`; neither message carries a credential. */
  read: (envFile: string) => Promise<WmsListing>
}

export class WmsReadRefused extends Error {}
export class WmsReadFailed extends Error {}

export interface ReviewCliDeps {
  wms?: WmsReader
}

export function usageText(deps: ReviewCliDeps = {}): string {
  const flag = deps.wms?.flag ?? '--wms-env-file'
  const label = deps.wms?.label ?? 'WMS'
  return [
    `Usage: first-load-lifecycle-review --manifest <run.json> --out <dir> [${flag} <file>]`,
    '',
    'Writes the owner lifecycle review sheet (lifecycle-review.xlsx) and its generation record into a new directory. Read-only: nothing is written to any system.',
    '',
    '  --manifest <file>  the first-load run manifest (the same one first-load:prepare reads): the Qoblex products and stock-lots exports, the woo-product-status',
    '                     dataset with its wooSnapshot, and any sku-renames. Its lifecycle-decisions input and lifecycleReview are ignored here.',
    '  --out <dir>        output directory; must not exist or must be empty. The files are mode 600.',
    `  ${flag} <file>  optional: the read-only ${label} credentials file (mode 600). Without it the ${label} columns read "not read".`,
    '  --help             this text',
    '',
    'Exit codes:',
    ...LIFECYCLE_REVIEW_EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

class UsageError extends Error {}

function parseArgs(argv: string[], deps: ReviewCliDeps): { manifest: string; out: string; wmsEnvFile: string | null } | 'help' {
  let manifest: string | null = null
  let out: string | null = null
  let wmsEnvFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') return 'help'
    else if (arg === '--manifest') manifest = value()
    else if (arg === '--out') out = value()
    else if (deps.wms && arg === deps.wms.flag) wmsEnvFile = value()
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)} (credentials are never accepted on the command line: put them in the env file)`)
  }
  if (manifest === null) throw new UsageError('--manifest is required')
  if (out === null) throw new UsageError('--out is required')
  return { manifest, out, wmsEnvFile }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export async function runLifecycleReviewCli(argv: string[], io: CliIo, deps: ReviewCliDeps = {}): Promise<number> {
  const tool = 'first-load-lifecycle-review'
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv, deps)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${tool}: ${error.message}\n\n${usageText(deps)}`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  if (args === 'help') {
    io.stdout(usageText(deps))
    return EXIT_CODES.OK
  }
  const outDir = path.resolve(args.out)
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    io.stderr(`${tool}: the output directory ${args.out} is not empty; nothing was read or written (choose a new directory)\n`)
    return EXIT_CODES.OUTPUT_FAILED
  }

  // ---- the manifest, read and bound exactly as first-load:prepare does, without the decisions ----
  const loaded = loadPrepareRun(args.manifest, io, { runId: null, withoutDecisions: true, rawProductStates: true }, tool, () => usageText(deps))
  if (!loaded.ok) return loaded.exit
  const run = loaded.run
  const refuse = (message: string): number => {
    io.stderr(`${tool}: an input cannot be used, nothing was written:\n  - ${message}\n`)
    return EXIT_CODES.INPUT_UNUSABLE
  }
  if (!run.datasets.products) return refuse('the manifest lists no products dataset (the Qoblex stock-on-hand export): the sheet lists the Qoblex catalogue')
  if (!run.datasets['stock-lots']) return refuse('the manifest lists no stock-lots dataset (the Qoblex stock-on-hand export): the sheet shows the Qoblex stock, and an Archived decision is checked against it')
  if (!run.datasets['woo-product-status']) return refuse('the manifest lists no woo-product-status dataset (written by first-load:woo-snapshot): the sheet shows every product\'s own WooCommerce status, name and stock')
  const binding = run.productStatusBinding
  if (binding === undefined || !binding.verified || run.wooSnapshot === null) {
    return refuse(`the WooCommerce snapshot bundle is not verified, so no WooCommerce status, name or stock can be shown: ${binding !== undefined && !binding.verified ? binding.problems.join('; ') : 'woo-product-status was not verified against the snapshot'}`)
  }

  let result
  try {
    result = prepare({ config: run.config, datasets: run.datasets, variantParentsBinding: run.variantParentsBinding, productStatusBinding: run.productStatusBinding, dryRun: true })
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${tool}: invalid run configuration: ${error.message}\n`)
      return EXIT_CODES.USAGE
    }
    throw error
  }

  // ---- the WMS listing (optional; GET only, through the injected reader) ----
  let wms: WmsListing | null = null
  if (args.wmsEnvFile !== null && deps.wms) {
    try {
      wms = await deps.wms.read(args.wmsEnvFile)
    } catch (error) {
      if (error instanceof WmsReadRefused || error instanceof WmsReadFailed) return refuse(`${deps.wms.label}: ${error.message}`)
      throw error
    }
  }
  const wmsLabel = deps.wms?.label ?? 'WMS'

  // ---- the model, the generation record, the sheet ----
  const qoblexProducts: QoblexProductRow[] = run.datasets.products.rows.map((row) => ({
    sku: row.values.sku ?? '', name: row.values.name ?? '', type: row.values.type ?? '', state: run.rawProductStates.get((row.values.sku ?? '').trim()) ?? '',
  }))
  const qoblexStock: QoblexStockRow[] = run.datasets['stock-lots'].rows.map((row) => ({ sku: row.values.sku ?? '', warehouseCode: row.values.warehouseCode ?? '', qty: row.values.qty ?? '' }))
  let model
  try {
    model = buildReviewModel({ catalogue: result.catalogue, skuRenames: result.skuRenames, qoblexProducts, qoblexStock, snapshot: run.wooSnapshot, wms })
  } catch (error) {
    if (error instanceof ReviewModelError) return refuse(error.message)
    throw error
  }
  const wmsDigest = wms === null ? null : sha256(canonicalJson({ products: [...wms.products].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)), physical: [...wms.physical.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), warehouses: wms.warehouses }))
  const generation = buildGeneration({
    inputs: {
      products: run.datasets.products.parts.map((p) => p.sha256),
      stockLots: run.datasets['stock-lots'].parts.map((p) => p.sha256),
      snapshotPayloadSha256: binding.snapshotPayloadSha256,
      productStatusSha256: binding.csvSha256,
      wms: { read: wms !== null, digest: wmsDigest },
    },
    review: model.entries,
  })
  const options = { wmsLabel, wmsRead: wms !== null, wmsWarehouses: wms?.warehouses ?? [] }
  let sheet: Buffer
  try {
    sheet = renderReviewSheet(model, generation, options, notesFor(model, generation, options))
  } catch (error) {
    io.stderr(`${tool}: internal error: the sheet could not be built (${error instanceof Error ? error.message : String(error)})\n`)
    return EXIT_CODES.INTERNAL
  }
  // Self-check: the sheet just built reads back to exactly the review set, bound to this generation.
  const reread = readDecisionFile(sheet)
  if (!reread.ok || reread.bindingTab?.sheetId !== generation.sheetId || reread.bindingTab.digest !== generation.digest || (model.entries.length > 0 && (reread.sheetIds.length !== 1 || reread.sheetIds[0] !== generation.sheetId))) {
    io.stderr(`${tool}: internal error: the sheet just built does not read back with its binding${reread.ok ? '' : `: ${reread.problems.join('; ')}`}\n`)
    return EXIT_CODES.INTERNAL
  }

  // ---- the files ----
  const created: string[] = []
  let createdDir = false
  try {
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      createdDir = true
    }
    for (const [name, content] of [[LIFECYCLE_REVIEW_FILE_NAMES.sheet, sheet], [LIFECYCLE_REVIEW_FILE_NAMES.generation, Buffer.from(renderGeneration(generation), 'utf8')]] as const) {
      const target = path.join(outDir, name)
      writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
      created.push(target)
    }
  } catch (error) {
    for (const file of created) rmSync(file, { force: true })
    if (createdDir) rmSync(outDir, { recursive: true, force: true })
    io.stderr(`${tool}: writing the output failed (${error instanceof Error ? error.message : String(error)}); the files this run had written were removed\n`)
    return EXIT_CODES.OUTPUT_FAILED
  }

  const decidable = model.entries.length
  const withStock = model.review.filter((r) => r.stockAboveZero).length
  const flagged = model.rows.filter((r) => r.flags.length > 0).length
  io.stdout([
    `Lifecycle review sheet ${generation.sheetId} written to ${args.out}:`,
    `  ${LIFECYCLE_REVIEW_FILE_NAMES.sheet}: ${model.review.length} row(s) to review (${decidable} loaded into IMS and to be decided, ${withStock} holding stock), ${model.rows.length} row(s) on "All products", ${flagged} row(s) with a SKU mismatch`,
    `  ${LIFECYCLE_REVIEW_FILE_NAMES.generation}: name it in the run manifest as lifecycleReview.generation, and the filled sheet as the lifecycle-decisions input`,
    wms === null
      ? `  ${wmsLabel}: NOT READ (${deps.wms ? `no ${deps.wms.flag}` : 'no reader'}): its columns read "not read" and every Archived decision will need an override reason`
      : `  ${wmsLabel}: ${wms.products.length} product(s) and the physical stock of ${wms.warehouses.length} warehouse(s) read with GET requests only`,
    '',
  ].join('\n'))
  return EXIT_CODES.OK
}
