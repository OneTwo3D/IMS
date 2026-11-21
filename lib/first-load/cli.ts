/**
 * The first-load-prepare command line, as a function so tests can drive it without a subprocess.
 * scripts/first-load-prepare.ts is a three-line wrapper around `runCli`.
 *
 * File in, file out: it reads the files named in a run manifest and writes into --out. It opens no network socket and
 * no database connection (the module graph imports neither).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { InputError, decisionSkuKey, ingestDataset, type IngestDecisions, mergeIngested, parseColumnMap, type ColumnMap, type DatasetMapping, type IngestedDataset } from './ingest'
import { renderAccountingTable, renderJson, renderMarkdown } from './report'
import { DATASET_NAMES, EXIT_CODES, EXIT_CODE_TABLE, IN_TRANSIT_CONVENTIONS, type DatasetName, type InTransitConvention } from './spec'
import { bindingFromVerification, productStatusBindingFromVerification, normaliseStoreOrigin, parseVisibilityAttestation, verifyWooSnapshotBundle, type SnapshotPayload, type VisibilityAttestation, type ProductStatusBinding, type VariantParentsBinding } from './snapshot'
import { ConfigError, prepare, type PrepareConfig } from './transform'
import { parseGeneration, type LifecycleDecisionsBinding } from './lifecycle-review/generation'
import { readDecisionFile } from './lifecycle-review/read-back'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export const REPORT_JSON_NAME = 'validation-report.json'
export const REPORT_MD_NAME = 'validation-report.md'

export function usageText(): string {
  return [
    'Usage: first-load-prepare --manifest <run.json> (--out <dir> | --dry-run) [--run-id <id>]',
    '',
    '  --manifest <file>  run manifest (JSON); relative paths inside it are relative to the manifest',
    '  --out <dir>        output directory; must not exist or must be empty',
    '  --dry-run          validate and print the report; write nothing',
    '  --run-id <id>      explicit label recorded in the report (letters, digits, "-", "_", "."); the only run-specific text in any output',
    '  --help             this text',
    '',
    'Exit codes:',
    ...EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

class UsageError extends Error {}

export interface Manifest {
  baseCurrency: string
  asOf: string | null
  inTransitConvention: InTransitConvention | null
  purchaseOrderKeyPrefix: string | null
  transferKeyPrefix: string | null
  maxPurchaseTaxRate: string | null
  requireVariantParents: boolean
  /** Where the snapshot and its provenance are, for the variant-parents binding. Relative to the manifest. */
  wooSnapshot: { snapshot: string; provenance: string; origin: string | null; visibilityChecked: VisibilityAttestation | null } | null
  /** The owner lifecycle review the lifecycle-decisions were made on: the generation record first-load:lifecycle-review wrote beside the sheet. Relative to the manifest. */
  lifecycleReview: { generation: string } | null
  inputs: Array<{ dataset: DatasetName; file: string; columnMap: string | null; supersedesEarlier: boolean }>
}

const MANIFEST_KEYS = new Set(['formatVersion', 'baseCurrency', 'asOf', 'inTransitConvention', 'purchaseOrderKeyPrefix', 'transferKeyPrefix', 'maxPurchaseTaxRate', 'requireVariantParents', 'wooSnapshot', 'lifecycleReview', 'inputs'])
const INPUT_KEYS = new Set(['dataset', 'file', 'columnMap', 'supersedesEarlier'])

function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`the manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError('the manifest must be a JSON object')
  const m = raw as Record<string, unknown>
  for (const key of Object.keys(m)) if (!MANIFEST_KEYS.has(key)) throw new UsageError(`unknown manifest key "${key}"`)
  if (m.formatVersion !== 1) throw new UsageError('manifest formatVersion must be 1')
  if (typeof m.baseCurrency !== 'string') throw new UsageError('manifest baseCurrency is required (for example "GBP"): it is never assumed')
  const optionalString = (key: string): string | null => {
    const value = m[key]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') throw new UsageError(`manifest ${key} must be a string`)
    return value
  }
  const convention = optionalString('inTransitConvention')
  if (convention !== null && !(IN_TRANSIT_CONVENTIONS as readonly string[]).includes(convention)) {
    throw new UsageError(`manifest inTransitConvention must be one of ${IN_TRANSIT_CONVENTIONS.join(', ')}`)
  }
  if (m.requireVariantParents !== undefined && typeof m.requireVariantParents !== 'boolean') throw new UsageError('manifest requireVariantParents must be true or false')
  const requireFlag = m.requireVariantParents === true
  let wooSnapshot: Manifest['wooSnapshot'] = null
  if (m.wooSnapshot !== undefined) {
    const w = m.wooSnapshot
    if (typeof w !== 'object' || w === null || Array.isArray(w)) throw new UsageError('manifest wooSnapshot must be an object {"snapshot": <woo-snapshot.json>, "provenance": <woo-snapshot.provenance.json>, "origin": <the WooCommerce store origin>, "visibilityChecked": <per-status counts from the shop admin>}')
    const wo = w as Record<string, unknown>
    for (const key of Object.keys(wo)) if (key !== 'snapshot' && key !== 'provenance' && key !== 'origin' && key !== 'visibilityChecked') throw new UsageError(`unknown key "${key}" in manifest wooSnapshot`)
    if (typeof wo.snapshot !== 'string' || wo.snapshot === '' || typeof wo.provenance !== 'string' || wo.provenance === '') throw new UsageError('manifest wooSnapshot needs a snapshot path and a provenance path (both strings)')
    // The origin is the operator's declaration of which store the snapshot must come from. Absent is accepted here and refused where the snapshot is bound (an ERROR finding).
    let origin: string | null = null
    if (wo.origin !== undefined) {
      if (typeof wo.origin !== 'string' || normaliseStoreOrigin(wo.origin) === null) throw new UsageError('manifest wooSnapshot origin must be an http(s) origin such as https://shop.example')
      origin = normaliseStoreOrigin(wo.origin)
    }
    // The operator's attestation of what the real key should see (the shop admin's per-status counts). Absent is refused where the snapshot is bound.
    let visibilityChecked: VisibilityAttestation | null = null
    if (wo.visibilityChecked !== undefined) {
      const parsedAttestation = parseVisibilityAttestation(wo.visibilityChecked)
      if (!parsedAttestation.ok) throw new UsageError(`manifest wooSnapshot visibilityChecked: ${parsedAttestation.problem}`)
      visibilityChecked = parsedAttestation.value
    }
    wooSnapshot = { snapshot: wo.snapshot, provenance: wo.provenance, origin, visibilityChecked }
  }
  let lifecycleReview: Manifest['lifecycleReview'] = null
  if (m.lifecycleReview !== undefined) {
    const l = m.lifecycleReview
    if (typeof l !== 'object' || l === null || Array.isArray(l) || Object.keys(l).some((key) => key !== 'generation') || typeof (l as Record<string, unknown>).generation !== 'string' || (l as Record<string, unknown>).generation === '') {
      throw new UsageError('manifest lifecycleReview must be an object {"generation": <lifecycle-review.generation.json>} (the record first-load:lifecycle-review wrote beside the sheet)')
    }
    lifecycleReview = { generation: (l as Record<string, string>).generation }
  }
  if (!Array.isArray(m.inputs) || m.inputs.length === 0) throw new UsageError('manifest inputs must be a non-empty array')
  const seen = new Set<string>()
  const inputs: Manifest['inputs'] = []
  for (const entry of m.inputs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new UsageError('each manifest input must be an object')
    const e = entry as Record<string, unknown>
    for (const key of Object.keys(e)) if (!INPUT_KEYS.has(key)) throw new UsageError(`unknown key "${key}" in a manifest input`)
    if (typeof e.dataset !== 'string' || !(DATASET_NAMES as readonly string[]).includes(e.dataset)) throw new UsageError(`manifest input dataset must be one of ${DATASET_NAMES.join(', ')}`)
    if (typeof e.file !== 'string' || e.file === '') throw new UsageError(`manifest input ${e.dataset} needs a file`)
    if (e.columnMap !== undefined && (typeof e.columnMap !== 'string' || e.columnMap === '')) throw new UsageError(`manifest input ${e.dataset}: columnMap must be a path`)
    if (e.supersedesEarlier !== undefined && typeof e.supersedesEarlier !== 'boolean') throw new UsageError(`manifest input ${e.dataset}: supersedesEarlier must be true or false`)
    if (e.supersedesEarlier === true && e.dataset !== 'products') throw new UsageError(`manifest input ${e.dataset}: supersedesEarlier is only supported for the products dataset`)
    if (e.dataset === 'lifecycle-decisions' && e.columnMap !== undefined) throw new UsageError('manifest input lifecycle-decisions takes no columnMap: it is the filled review sheet (.xlsx), a CSV export of its Review tab, or a canonical file')
    if (e.dataset === 'lifecycle-decisions' && inputs.some((earlier) => earlier.dataset === e.dataset)) throw new UsageError('manifest input lifecycle-decisions may be listed once: the decisions of one review sheet')
    if (e.supersedesEarlier === true && !inputs.some((earlier) => earlier.dataset === e.dataset)) throw new UsageError(`manifest input ${e.dataset}: supersedesEarlier needs an earlier file for the same dataset (list the file to be replaced first)`)
    const key = `${e.dataset}\u0000${path.normalize(e.file)}`
    if (seen.has(key)) throw new UsageError(`dataset ${e.dataset} lists the file ${e.file} twice`)
    seen.add(key)
    inputs.push({ dataset: e.dataset as DatasetName, file: e.file, columnMap: typeof e.columnMap === 'string' ? e.columnMap : null, supersedesEarlier: e.supersedesEarlier === true })
  }
  return {
    baseCurrency: m.baseCurrency,
    asOf: optionalString('asOf'),
    inTransitConvention: convention as InTransitConvention | null,
    purchaseOrderKeyPrefix: optionalString('purchaseOrderKeyPrefix'),
    transferKeyPrefix: optionalString('transferKeyPrefix'),
    maxPurchaseTaxRate: optionalString('maxPurchaseTaxRate'),
    requireVariantParents: requireFlag,
    wooSnapshot,
    lifecycleReview,
    inputs,
  }
}

interface Args {
  manifest: string
  out: string | null
  dryRun: boolean
  runId: string | null
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { manifest: '', out: null, dryRun: false, runId: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--manifest') args.manifest = value()
    else if (arg === '--out') args.out = value()
    else if (arg === '--run-id') args.runId = value()
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (args.help) return args
  if (args.manifest === '') throw new UsageError('--manifest is required')
  if (args.out === null && !args.dryRun) throw new UsageError('give --out <dir>, or --dry-run to write nothing')
  if (args.out !== null && args.dryRun) throw new UsageError('--out and --dry-run are mutually exclusive: a dry run writes nothing')
  if (args.runId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(args.runId)) throw new UsageError('--run-id must be letters, digits, "-", "_" or "." (at most 64 characters)')
  return args
}

export interface CliDeps {
  /** Test seam: replace the transform to exercise the INTERNAL exit path. Production passes nothing. */
  prepare?: typeof prepare
}

/** Everything a manifest names, read, ingested and bound: what `prepare()` takes. Shared by first-load:prepare and first-load:lifecycle-review. */
export interface LoadedRun {
  manifest: Manifest
  manifestDir: string
  config: PrepareConfig
  datasets: Partial<Record<DatasetName, IngestedDataset>>
  variantParentsBinding: VariantParentsBinding | undefined
  productStatusBinding: ProductStatusBinding | undefined
  lifecycleDecisionsBinding: LifecycleDecisionsBinding | undefined
  /**
   * With `rawProductStates`: the products dataset's lifecycle cell per SKU (as read, before renames) BEFORE the column map's value map turned it into a
   * lifecycle (Qoblex "State": Active, Inactive, Archived), for the review sheet. Later files win where they state one.
   */
  rawProductStates: Map<string, string>
  /** The verified snapshot payload, when woo-product-status was verified against it (the review sheet reads names, statuses and stock from it). */
  wooSnapshot: SnapshotPayload | null
}

export interface LoadOptions {
  runId: string | null
  /** Leave the lifecycle-decisions input and the lifecycleReview binding out of the run (the review sheet shows the lifecycle BEFORE any decision). */
  withoutDecisions?: boolean
  rawProductStates?: boolean
}

export type LoadResult = { ok: true; run: LoadedRun } | { ok: false; exit: number }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Reads the manifest and every file it names. On a usage or input problem it prints the message (as first-load-prepare does) and returns the exit code. */
export function loadPrepareRun(manifestPath: string, io: CliIo, options: LoadOptions, tool = 'first-load-prepare', usage: () => string = usageText): LoadResult {
  let manifest: Manifest
  let manifestDir = ''
  try {
    manifestDir = path.dirname(path.resolve(manifestPath))
    let text: string
    try {
      text = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read the manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    manifest = parseManifest(text)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${tool}: ${error.message}\n\n${usage()}`)
      return { ok: false, exit: EXIT_CODES.USAGE }
    }
    throw error
  }
  if (options.withoutDecisions) manifest = { ...manifest, lifecycleReview: null, inputs: manifest.inputs.filter((input) => input.dataset !== 'lifecycle-decisions') }

  const resolve = (file: string) => path.resolve(manifestDir, file)
  const parts: Partial<Record<DatasetName, Array<{ ingested: IngestedDataset; supersedes: boolean }>>> = {}
  const layouts = new Map<DatasetName, Set<string>>()
  const maps = new Map<string, ColumnMap>()
  const datasets: Partial<Record<DatasetName, IngestedDataset>> = {}
  const problems: string[] = []
  const rawProductStates = new Map<string, string>()
  let decisionsFile: { sheetIds: string[]; bindingTab: { sheetId: string; digest: string } | null; kind: string; sha256: string } | null = null
  try {
    // Pass 1: resolve every column map and check the manifest as a whole BEFORE any dataset file is read, so a missing or malformed data
    // file cannot turn a manifest error (exit 2) into an input error (exit 3).
    const resolved: Array<{ input: (typeof manifest.inputs)[number]; mapping: DatasetMapping | null }> = []
    for (const input of manifest.inputs) {
      let mapping: DatasetMapping | null = null
      if (input.columnMap !== null) {
        const mapPath = resolve(input.columnMap)
        let map = maps.get(mapPath)
        if (!map) {
          let mapText: string
          try {
            mapText = readFileSync(mapPath, 'utf8')
          } catch (error) {
            problems.push(`cannot read the column map ${input.columnMap}: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
          try {
            map = parseColumnMap(mapText, input.columnMap)
          } catch (error) {
            if (error instanceof InputError) {
              problems.push(...error.problems)
              continue
            }
            throw error
          }
          maps.set(mapPath, map)
        }
        mapping = map.datasets[input.dataset] ?? null
        if (mapping === null) {
          problems.push(`${input.columnMap}: the column map has no entry for dataset "${input.dataset}"`)
          continue
        }
      }
      layouts.set(input.dataset, (layouts.get(input.dataset) ?? new Set()).add(mapping?.wide ? 'wide' : 'canonical-or-long'))
      resolved.push({ input, mapping })
    }
    for (const [name, kinds] of layouts) {
      if (kinds.size > 1) {
        io.stderr(`${tool}: dataset ${name} is listed with a mix of wide-warehouse-block files and other files; one run reads a dataset either entirely wide or entirely not wide, because rows of the same SKU and warehouse in two layouts could not be told apart and would be added together. Nothing was read.\n\n${usage()}`)
        return { ok: false, exit: EXIT_CODES.USAGE }
      }
    }
    // Pass 2: read the files. The decisions lists that act while a source file is read (non-stock SKUs, SKU by product name) are read FIRST.
    const DECISION_FIRST = new Set<DatasetName>(['non-stock-skus', 'sku-name-overrides'])
    resolved.sort((a, b) => Number(DECISION_FIRST.has(b.input.dataset)) - Number(DECISION_FIRST.has(a.input.dataset)))
    let decisions: IngestDecisions | undefined
    const decisionsNow = (): IngestDecisions => {
      const nonStockSkus = new Set<string>()
      for (const part of parts['non-stock-skus'] ?? []) for (const row of part.ingested.rows) nonStockSkus.add(decisionSkuKey(row.values.sku ?? ''))
      const skuByName = new Map<string, string>()
      const typeByName = new Map<string, string>()
      for (const part of parts['sku-name-overrides'] ?? []) for (const row of part.ingested.rows) {
        const name = (row.values.name ?? '').trim()
        const sku = (row.values.sku ?? '').trim()
        if (name !== '' && sku !== '') skuByName.set(name, sku)
        const type = (row.values.type ?? '').trim()
        if (name !== '' && sku !== '' && (type === 'KIT' || type === 'BOM')) typeByName.set(name, type)
      }
      return { nonStockSkus, skuByName, typeByName }
    }
    for (const { input, mapping } of resolved) {
      if (decisions === undefined && !DECISION_FIRST.has(input.dataset)) decisions = decisionsNow()
      let bytes: Buffer
      try {
        bytes = readFileSync(resolve(input.file))
      } catch (error) {
        problems.push(`cannot read ${input.file}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      try {
        if (input.dataset === 'lifecycle-decisions') {
          // The filled review sheet (.xlsx), a CSV export of its Review tab, or a canonical file: read into the canonical dataset, keeping the hash of the bytes READ.
          const read = readDecisionFile(bytes)
          if (!read.ok) { problems.push(...read.problems.map((p) => `${input.file}: ${p}`)); continue }
          const fileSha = sha256(bytes)
          const ingested = ingestDataset('lifecycle-decisions', Buffer.from(read.canonicalCsv, 'utf8'), input.file, null, decisions)
          ;(parts[input.dataset] ??= []).push({ ingested: { ...ingested, sha256: fileSha, bytes: bytes.length, parts: [{ file: input.file, sha256: fileSha, bytes: bytes.length }] }, supersedes: false })
          decisionsFile = { sheetIds: read.sheetIds, bindingTab: read.bindingTab, kind: read.kind, sha256: fileSha }
          continue
        }
        ;(parts[input.dataset] ??= []).push({ ingested: ingestDataset(input.dataset, bytes, input.file, mapping, decisions), supersedes: input.supersedesEarlier })
        if (options.rawProductStates && input.dataset === 'products') {
          // The same file again with the lifecycle cell left as the source states it (the value map removed): the Qoblex State the review sheet shows.
          const raw = mapping === null ? null : { ...mapping, valueMaps: Object.fromEntries(Object.entries(mapping.valueMaps).filter(([column]) => column !== 'lifecycleStatus')) }
          const again = raw === null ? parts[input.dataset]!.at(-1)!.ingested : ingestDataset(input.dataset, bytes, input.file, raw, decisions)
          for (const row of again.rows) {
            const sku = (row.values.sku ?? '').trim()
            const state = (row.values.lifecycleStatus ?? '').trim() || ((row.values.active ?? '').trim() === '' ? '' : `active=${(row.values.active ?? '').trim()}`)
            if (sku !== '' && state !== '') rawProductStates.set(sku, state)
          }
        }
      } catch (error) {
        if (error instanceof InputError) problems.push(...error.problems)
        else throw error
      }
    }
    if (problems.length > 0) throw new InputError(problems)
    for (const name of Object.keys(parts) as DatasetName[]) datasets[name] = mergeIngested(parts[name]!.map((part) => part.ingested), parts[name]!.map((part) => part.supersedes))
  } catch (error) {
    if (error instanceof InputError) {
      io.stderr(`${tool}: an input cannot be used, nothing was written:\n${error.problems.map((p) => `  - ${p}`).join('\n')}\n`)
      return { ok: false, exit: EXIT_CODES.INPUT_UNUSABLE }
    }
    throw error
  }

  const config: PrepareConfig = {
    runId: options.runId,
    baseCurrency: manifest.baseCurrency,
    asOf: manifest.asOf,
    inTransitConvention: manifest.inTransitConvention,
    purchaseOrderKeyPrefix: manifest.purchaseOrderKeyPrefix,
    transferKeyPrefix: manifest.transferKeyPrefix,
    maxPurchaseTaxRate: manifest.maxPurchaseTaxRate,
    requireVariantParents: manifest.requireVariantParents,
  }
  // The variant-parents dataset assigns parents and woo-product-status gives lifecycles, so each is only accepted when it equals the rows regenerated from the verified snapshot named by the manifest.
  const readOrNull = (file: string): Buffer | null => {
    try {
      return readFileSync(resolve(file))
    } catch {
      return null
    }
  }
  const bindingFor = (dataset: 'variant-parents' | 'woo-product-status'): VariantParentsBinding | undefined => {
    if (datasets[dataset] === undefined) return undefined
    const listed = manifest.inputs.filter((i) => i.dataset === dataset)
    if (listed.length !== 1 || listed[0].columnMap !== null) return { verified: false, problems: [`the ${dataset} dataset must be exactly one canonical file written by first-load:woo-snapshot (no column map, listed once)`] }
    if (manifest.wooSnapshot === null) return { verified: false, problems: [`the manifest does not name wooSnapshot (the snapshot and provenance that ${dataset}.csv was written with), so ${dataset}.csv cannot be verified`] }
    const verdict = verifyWooSnapshotBundle({
      snapshotBytes: readOrNull(manifest.wooSnapshot.snapshot),
      provenanceBytes: readOrNull(manifest.wooSnapshot.provenance),
      ...(dataset === 'variant-parents' ? { csvBytes: readOrNull(listed[0].file) } : { productStatusBytes: readOrNull(listed[0].file) }),
      expectedOrigin: manifest.wooSnapshot.origin,
      visibilityChecked: manifest.wooSnapshot.visibilityChecked,
    })
    if (dataset === 'woo-product-status' && verdict.ok && verdict.productStatusSha256 !== null) wooSnapshot = verdict.payload
    return dataset === 'variant-parents' ? bindingFromVerification(verdict) : productStatusBindingFromVerification(verdict)
  }
  let wooSnapshot: SnapshotPayload | null = null
  // The owner's decisions are only taken from the review sheet the manifest names (lifecycleReview.generation): the decisions file must carry that sheet's id,
  // and an .xlsx also its hidden binding tab with the generation digest. Absent the record, a supplied decisions dataset is refused by the transform.
  const decisionsBinding = (): LifecycleDecisionsBinding | undefined => {
    if (manifest.lifecycleReview === null) return undefined
    const bytes = readOrNull(manifest.lifecycleReview.generation)
    if (bytes === null) return { verified: false, problems: [`the lifecycle review generation record ${manifest.lifecycleReview.generation} could not be read`] }
    const parsed = parseGeneration(bytes.toString('utf8'))
    if (!parsed.ok) return { verified: false, problems: [parsed.problem] }
    const generation = parsed.value
    if (decisionsFile === null) return { verified: true, sheetId: generation.sheetId, generation: generation.body, fileSha256: null }
    const found: { sheetIds: string[]; bindingTab: { sheetId: string; digest: string } | null; kind: string } = decisionsFile
    const why: string[] = []
    if (found.sheetIds.length === 0) why.push(`no decision row carries a Sheet id (the review sheet ${generation.sheetId} writes it on every row)`)
    else if (found.sheetIds.length > 1 || found.sheetIds[0] !== generation.sheetId) why.push(`the decisions carry the sheet id(s) ${found.sheetIds.slice(0, 3).join(', ')}, not ${generation.sheetId} (the sheet the generation record describes): the decisions were made on another sheet`)
    if (found.kind === 'xlsx') {
      if (found.bindingTab === null) why.push('the workbook\'s hidden binding tab is missing or unreadable')
      else if (found.bindingTab.sheetId !== generation.sheetId || found.bindingTab.digest !== generation.digest) why.push('the workbook\'s hidden binding tab names another generation (sheet id or digest differ): the workbook is not the sheet this record describes')
    }
    return why.length > 0 ? { verified: false, problems: why } : { verified: true, sheetId: generation.sheetId, generation: generation.body, fileSha256: (decisionsFile as { sha256: string }).sha256 }
  }
  return {
    ok: true,
    run: {
      manifest, manifestDir, config, datasets,
      variantParentsBinding: bindingFor('variant-parents'),
      productStatusBinding: bindingFor('woo-product-status'),
      lifecycleDecisionsBinding: decisionsBinding(),
      rawProductStates,
      wooSnapshot,
    },
  }
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
    if (args.help) {
      io.stdout(usageText())
      return EXIT_CODES.OK
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`first-load-prepare: ${error.message}\n\n${usageText()}`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  const loaded = loadPrepareRun(args.manifest, io, { runId: args.runId })
  if (!loaded.ok) return loaded.exit
  const { config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding } = loaded.run
  let result
  try {
    result = (deps.prepare ?? prepare)({ config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding, dryRun: args.dryRun })
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`first-load-prepare: invalid run configuration: ${error.message}\n`)
      return EXIT_CODES.USAGE
    }
    throw error
  }

  const { report, outputs } = result
  const markdown = renderMarkdown(report, { dryRun: args.dryRun })
  const exitFor = (): number => (report.selfCheckFailures.length > 0 ? EXIT_CODES.INTERNAL : result.blocking ? EXIT_CODES.BLOCKING_FINDINGS : EXIT_CODES.OK)

  if (args.dryRun) {
    io.stdout(markdown)
    io.stdout(`\n${renderAccountingTable(report)}\n`)
    return exitFor()
  }

  const outDir = path.resolve(args.out!)
  const created: string[] = []
  let createdDir = false
  try {
    if (existsSync(outDir)) {
      if (readdirSync(outDir).length > 0) {
        io.stderr(`first-load-prepare: the output directory ${args.out} is not empty; nothing was written (choose a new directory)\n`)
        return EXIT_CODES.OUTPUT_FAILED
      }
    } else {
      mkdirSync(outDir, { recursive: true })
      createdDir = true
    }
    const write = (name: string, content: string) => {
      const target = path.join(outDir, name)
      writeFileSync(target, content, { flag: 'wx', encoding: 'utf8' })
      created.push(target)
    }
    for (const file of outputs) write(file.name, file.content)
    write(REPORT_JSON_NAME, renderJson(report))
    write(REPORT_MD_NAME, markdown)
  } catch (error) {
    for (const file of created) rmSync(file, { force: true })
    if (createdDir) rmSync(outDir, { recursive: true, force: true })
    io.stderr(`first-load-prepare: writing the output failed (${error instanceof Error ? error.message : String(error)}); the files this run had written were removed\n`)
    return EXIT_CODES.OUTPUT_FAILED
  }

  io.stdout(`${renderAccountingTable(report)}\n\n`)
  io.stdout(`Verdict: ${report.verdict}\n`)
  io.stdout(outputs.length > 0 ? `Wrote ${outputs.length} import file(s), ${REPORT_JSON_NAME} and ${REPORT_MD_NAME} to ${args.out}\n` : `No import file was produced. Wrote ${REPORT_JSON_NAME} and ${REPORT_MD_NAME} to ${args.out}\n`)
  return exitFor()
}

