/**
 * The first-load-prepare command line, as a function so tests can drive it without a subprocess.
 * scripts/first-load-prepare.ts is a three-line wrapper around `runCli`.
 *
 * File in, file out: it reads the files named in a run manifest and writes into --out. It opens no network socket and
 * no database connection (the module graph imports neither).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { InputError, ingestDataset, mergeIngested, parseColumnMap, type ColumnMap, type IngestedDataset } from './ingest'
import { renderAccountingTable, renderJson, renderMarkdown } from './report'
import { DATASET_NAMES, EXIT_CODES, EXIT_CODE_TABLE, IN_TRANSIT_CONVENTIONS, type DatasetName, type InTransitConvention } from './spec'
import { ConfigError, prepare, type PrepareConfig } from './transform'

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

interface Manifest {
  baseCurrency: string
  asOf: string | null
  inTransitConvention: InTransitConvention | null
  purchaseOrderKeyPrefix: string | null
  transferKeyPrefix: string | null
  maxPurchaseTaxRate: string | null
  inputs: Array<{ dataset: DatasetName; file: string; columnMap: string | null; supersedesEarlier: boolean }>
}

const MANIFEST_KEYS = new Set(['formatVersion', 'baseCurrency', 'asOf', 'inTransitConvention', 'purchaseOrderKeyPrefix', 'transferKeyPrefix', 'maxPurchaseTaxRate', 'inputs'])
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

export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let args: Args
  let manifest: Manifest
  let manifestDir = ''
  try {
    args = parseArgs(argv)
    if (args.help) {
      io.stdout(usageText())
      return EXIT_CODES.OK
    }
    manifestDir = path.dirname(path.resolve(args.manifest))
    let text: string
    try {
      text = readFileSync(args.manifest, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read the manifest ${args.manifest}: ${error instanceof Error ? error.message : String(error)}`)
    }
    manifest = parseManifest(text)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`first-load-prepare: ${error.message}\n\n${usageText()}`)
      return EXIT_CODES.USAGE
    }
    throw error
  }

  const resolve = (file: string) => path.resolve(manifestDir, file)
  const parts: Partial<Record<DatasetName, Array<{ ingested: IngestedDataset; supersedes: boolean }>>> = {}
  const layouts = new Map<DatasetName, Set<string>>()
  const maps = new Map<string, ColumnMap>()
  const datasets: Partial<Record<DatasetName, IngestedDataset>> = {}
  try {
    const problems: string[] = []
    for (const input of manifest.inputs) {
      let mapping = null
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
      let bytes: Buffer
      try {
        bytes = readFileSync(resolve(input.file))
      } catch (error) {
        problems.push(`cannot read ${input.file}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      try {
        ;(parts[input.dataset] ??= []).push({ ingested: ingestDataset(input.dataset, bytes, input.file, mapping), supersedes: input.supersedesEarlier })
      } catch (error) {
        if (error instanceof InputError) problems.push(...error.problems)
        else throw error
      }
    }
    if (problems.length > 0) throw new InputError(problems)
    for (const [name, kinds] of layouts) {
      if (kinds.size > 1) {
        io.stderr(`first-load-prepare: dataset ${name} is listed with a mix of wide-warehouse-block files and other files; one run reads a dataset either entirely wide or entirely not wide, because rows of the same SKU and warehouse in two layouts could not be told apart and would be added together\n\n${usageText()}`)
        return EXIT_CODES.USAGE
      }
    }
    for (const name of Object.keys(parts) as DatasetName[]) datasets[name] = mergeIngested(parts[name]!.map((part) => part.ingested), parts[name]!.map((part) => part.supersedes))
  } catch (error) {
    if (error instanceof InputError) {
      io.stderr(`first-load-prepare: an input cannot be used, nothing was written:\n${error.problems.map((p) => `  - ${p}`).join('\n')}\n`)
      return EXIT_CODES.INPUT_UNUSABLE
    }
    throw error
  }

  const config: PrepareConfig = {
    runId: args.runId,
    baseCurrency: manifest.baseCurrency,
    asOf: manifest.asOf,
    inTransitConvention: manifest.inTransitConvention,
    purchaseOrderKeyPrefix: manifest.purchaseOrderKeyPrefix,
    transferKeyPrefix: manifest.transferKeyPrefix,
    maxPurchaseTaxRate: manifest.maxPurchaseTaxRate,
  }
  let result
  try {
    result = (deps.prepare ?? prepare)({ config, datasets })
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

