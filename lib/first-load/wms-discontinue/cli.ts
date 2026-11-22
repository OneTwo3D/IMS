/**
 * The first-load WMS ARCHIVE command: plans, and on an explicit confirmation carries out, archiving (discontinuing) in the WMS every product the owner set
 * to Archived on the lifecycle review sheet. A function so tests drive it without a subprocess; the script that names the connector is a thin wrapper that
 * supplies the WMS reader and writer, the IMS target and the command's name (lib/first-load never names a connector).
 *
 * THE DRY RUN (default) is READ-ONLY. It reads the SAME run manifest as first-load:prepare, with the owner's filled sheet bound to its generation record
 * (`lifecycleReview` and the `lifecycle-decisions` input), runs the transform exactly as a real prepare does (pure: nothing is written) and takes the products
 * whose lifecycle comes from an owner decision and is ARCHIVED. It refuses the plan when the decisions are not usable (not bound, a refused or missing
 * decision, the review set changed or unchecked): archiving in the WMS follows the import, never a sheet that would not import. It then reads the WMS
 * product census and physical stock through the injected reader (GET only) and prints, per SKU, what would change and why every other SKU would not, with
 * a confirmation token derived from the plan. It exits non-zero when any SKU is refused or a real prepare of the manifest is blocked (#1126 R1 LOW).
 *
 * --execute WRITES, and only when every one of these holds (else nothing is sent to the WMS):
 *   - the IMS target is confirmed (env file, --expect-db, --expect-system-id), its advisory lock is free, the writer's preflight passes under the TARGET's
 *     environment (the WMS step live there, no hold, its grant for exactly this tenant), and its system switch (the one the script names, registered in lib/domain/settings/system-switches.ts, default OFF)
 *     reads exactly `true`;
 *   - the decisions would import and a real prepare of the manifest is not blocked;
 *   - the plan recomputed now from a fresh WMS read has exactly the token the operator reviewed (--plan-token), and refuses no SKU;
 *   - the import is proven: every SKU to be written is an IMS product whose lifecycle is ARCHIVED in the target (target.ts says why this proof);
 * then lib/first-load/wms-discontinue/execute.ts writes one SKU at a time, re-reading, verifying and recording each, and stopping at the first surprise.
 * No credential is printed.
 */
import { loadPrepareRun, type CliIo } from '../cli'
import { EXIT_CODES } from '../spec'
import { ConfigError, prepare } from '../transform'
import { executeArchivePlan, type ArchiveExecuteResult, type WmsArchiveWriter } from './execute'
import { buildArchivePlan, isRefused, type ArchivePlan, type WmsCensus } from './plan'
import { archiveSwitchStillOn, readArchiveTarget, recordArchiveWrite, unprovenImports, type ArchiveTargetPort } from './target'

export const WMS_ARCHIVE_EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: string; meaning: string }> = [
  { code: EXIT_CODES.OK, name: 'OK', meaning: 'Dry run: the plan was printed, no SKU is refused and a real prepare of the manifest is not blocked (the plan may be empty). --execute: every WOULD_ARCHIVE SKU was written and verified.' },
  { code: EXIT_CODES.BLOCKING_FINDINGS, name: 'BLOCKING_FINDINGS', meaning: 'The plan was printed and at least one Archived SKU is refused (not found, a bundle, no discontinued flag, no stock row, or physical stock other than zero), or a real prepare of the manifest is blocked by other findings: resolve each before any write. With --execute nothing was written.' },
  { code: EXIT_CODES.USAGE, name: 'USAGE', meaning: 'Bad command line or an invalid run manifest. Nothing was read or requested.' },
  { code: EXIT_CODES.INPUT_UNUSABLE, name: 'INPUT_UNUSABLE', meaning: 'An input cannot be used: a manifest file, the decisions not bound to a verified review sheet, a refused or missing decision, a review set that changed or cannot be checked, or the WMS credentials file refused or its census unreadable. With --execute also: the IMS target not confirmed or unreadable, another run holding its lock, the switch not on, the WMS step not live in the target (or its hold or grant refusing the write), a plan token that does not match the plan made now, or an import that is not proven. Nothing was written.' },
  { code: EXIT_CODES.OUTPUT_FAILED, name: 'WRITE_STOPPED', meaning: '--execute stopped at the first answer that was not exactly the expected one (a re-read that differs, stock that appeared, the switch turned off, a write the WMS refused or that got no usable answer, a read-back that does not verify, or a record that could not be written). The SKUs written and verified before it are listed and recorded; nothing after it was attempted.' },
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

/**
 * Opens the WMS writer from the credentials file (the same parsed configuration the census was read with) under the TARGET installation's environment
 * (the variables of its env file): every rule about whether the write may leave is the target's. Throws `WmsCensusRefused` before any request.
 */
export type WmsArchiveOpenWriter = (envFile: string, targetEnv: Readonly<Record<string, string | undefined>>) => WmsArchiveWriter

/** The IMS target of --execute: one session (the run's advisory lock lives on it), and the variables of its env file. */
export interface ArchiveTarget {
  port: ArchiveTargetPort
  env: Readonly<Record<string, string | undefined>>
  /** Takes the run's session lock; false when another run holds it. */
  tryLock: () => Promise<boolean>
  unlock: () => Promise<void>
  close: () => Promise<void>
}

/** What --execute needs besides the reader; the script supplies it (the WMS writer from the same credentials file, the IMS target from its env file). */
export interface WmsArchiveExecuteDeps {
  /** The system switch that must read exactly `true`. */
  switchKey: string
  openWriter: WmsArchiveOpenWriter
  /** Opens the IMS target from its env file, with that file's environment and the run's lock. Throws with a short message (never a credential) when it cannot. */
  openTarget: (envFile: string) => Promise<ArchiveTarget>
  /** A new activity-log id. */
  newId: () => string
}

export function usageText(reader?: Pick<WmsCensusReader, 'flag' | 'label'>, tool = DEFAULT_TOOL): string {
  const flag = reader?.flag ?? '--wms-env-file'
  const label = reader?.label ?? 'WMS'
  return [
    `Usage: ${tool} --manifest <run.json> ${flag} <file>`,
    `       ${tool} --manifest <run.json> ${flag} <file> --execute --plan-token <MSA-...> --env-file <ims.env> --expect-db <name> --expect-system-id <id> --operator <name>`,
    '',
    `Plans archiving (discontinuing) in ${label} every product the owner set to Archived on the lifecycle review sheet. Without --execute it is a DRY RUN: it reads, prints the plan and its token and writes nothing.`,
    `With --execute it WRITES to ${label} (LIVE), one product at a time, only for the plan whose token is given, after the import is proven in the IMS target.`,
    '',
    '  --manifest <file>          the first-load run manifest with lifecycleReview.generation and the lifecycle-decisions input (the filled review sheet)',
    `  ${flag} <file>  the ${label} credentials file (mode 600), the same one first-load:lifecycle-review reads`,
    '  --execute                  write the plan (needs every option below, and the system switch on in the IMS target)',
    '  --plan-token <MSA-...>     the token the dry run printed for the plan you reviewed; a plan that changed since is refused',
    '  --env-file <file>          the IMS installation env file (DATABASE_URL inside) the first load was applied to: a regular file you own, mode 600',
    '  --expect-db <name>         must equal current_database() of that target; otherwise nothing is read or written',
    '  --expect-system-id <id>    must equal its cluster system identifier; otherwise nothing is read or written',
    '  --operator <name>          who runs it (a name, not an e-mail address): recorded with every write',
    '  --help                     this text',
    '',
    'Exit codes:',
    ...WMS_ARCHIVE_EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

class UsageError extends Error {}

const DEFAULT_TOOL = 'first-load-wms-archive'

interface ExecuteArgs { planToken: string; envFile: string; expectDb: string; expectSystemId: string; operator: string }
interface ParsedArgs { manifest: string; envFile: string; execute: ExecuteArgs | null }

const EXECUTE_VALUE_FLAGS = ['--plan-token', '--env-file', '--expect-db', '--expect-system-id', '--operator'] as const
const CREDENTIAL_IN_ARG = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@|[?&](password|passwd|pwd|secret|token|key)=/i
const OPERATOR = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,79}$/u

function parseArgs(argv: string[], reader: WmsCensusReader): ParsedArgs | 'help' {
  let manifest: string | null = null
  let envFile: string | null = null
  let execute = false
  const values = new Map<string, string>()
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
    else if ((EXECUTE_VALUE_FLAGS as readonly string[]).includes(arg)) {
      if (values.has(arg)) throw new UsageError(`${arg} was given twice`)
      const v = value()
      if (CREDENTIAL_IN_ARG.test(v)) throw new UsageError(`the value of ${arg} looks like it carries a credential; name the target by an env file`)
      values.set(arg, v)
    } else throw new UsageError(`unknown argument ${JSON.stringify(arg)} (credentials are never accepted on the command line: put them in the env file)`)
  }
  if (manifest === null) throw new UsageError('--manifest is required')
  if (envFile === null) throw new UsageError(`${reader.flag} is required (the plan is made against what ${reader.label} holds now)`)
  if (!execute) {
    if (values.size > 0) throw new UsageError(`${[...values.keys()].join(', ')} only go with --execute`)
    return { manifest, envFile, execute: null }
  }
  const missing = EXECUTE_VALUE_FLAGS.filter((f) => !values.has(f))
  if (missing.length > 0) throw new UsageError(`--execute needs ${missing.join(', ')}`)
  if (!/^MSA-[0-9a-f]{16}$/.test(values.get('--plan-token')!)) throw new UsageError('--plan-token must be the MSA- token the dry run printed')
  const operator = values.get('--operator')!
  if (!OPERATOR.test(operator) || operator.includes('@')) throw new UsageError('--operator must be a name of letters, digits, spaces and . \' _ - (at most 80 characters, not an e-mail address)')
  return { manifest, envFile, execute: { planToken: values.get('--plan-token')!, envFile: values.get('--env-file')!, expectDb: values.get('--expect-db')!, expectSystemId: values.get('--expect-system-id')!, operator } }
}

const DECISION_CODES = new Set(['LIFECYCLE_DECISIONS_NOT_BOUND', 'LIFECYCLE_DECISION_MISSING', 'LIFECYCLE_REVIEW_SET_CHANGED', 'LIFECYCLE_REVIEW_SET_UNCHECKED'])

export async function runWmsArchiveCli(argv: string[], io: CliIo, reader: WmsCensusReader, tool = DEFAULT_TOOL, executeDeps?: WmsArchiveExecuteDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv, reader)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${tool}: ${error.message}\n\n${usageText(reader, tool)}`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  if (args === 'help') {
    io.stdout(usageText(reader, tool))
    return EXIT_CODES.OK
  }
  if (args.execute !== null && executeDeps === undefined) {
    io.stderr(`${tool}: --execute is not wired in this build of the command (no ${reader.label} writer or IMS target was supplied). Nothing was read or written.\n`)
    return EXIT_CODES.USAGE
  }

  // ---- the decisions, bound and applied exactly as a real first-load:prepare does ----
  const loaded = loadPrepareRun(args.manifest, io, { runId: null }, tool, () => usageText(reader, tool))
  if (!loaded.ok) return loaded.exit
  const run = loaded.run
  const refuse = (problems: string[]): number => {
    const listed = problems.slice(0, 20).map((p) => `  - ${p}`)
    if (problems.length > 20) listed.push(`  ... and ${problems.length - 20} more`)
    io.stderr(`${tool}: refused, nothing was written to ${reader.label}:\n${listed.join('\n')}\n`)
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

  // ---- --execute: the IMS target first (identity, switch, import proof read), before the WMS is touched ----
  const archived = result.catalogue.filter((e) => e.lifecycleSource === 'decision' && e.lifecycle === 'ARCHIVED').map((e) => e.sku)
  let target: ArchiveTarget | null = null
  let locked = false
  try {
    let proof: Awaited<ReturnType<typeof readArchiveTarget>> | null = null
    let writer: WmsArchiveWriter | null = null
    let stepEvidence = ''
    if (args.execute !== null) {
      const ex = args.execute
      const deps = executeDeps!
      if (result.blocking) return refuse(['a real first-load:prepare of this manifest is blocked by other findings, so the import cannot have been made from it: nothing is written'])
      try {
        target = await deps.openTarget(ex.envFile)
        locked = await target.tryLock()
        if (!locked) return refuse(['another run of this command holds the target\'s lock: one run at a time'])
        proof = await readArchiveTarget(target.port, deps.switchKey, archived)
      } catch (error) {
        return refuse([`the IMS target could not be read (${error instanceof Error ? error.message : 'error'})`])
      }
      if (proof.database !== ex.expectDb) return refuse(['--expect-db does not equal the database the server reports; the target is not the database you named'])
      if (proof.systemId !== ex.expectSystemId) return refuse(['--expect-system-id does not equal the cluster system identifier the server reports'])
      if (proof.switchValue !== 'true') return refuse([`the system switch ${deps.switchKey} is not on in the target (it reads ${proof.switchValue === null ? 'unset, the default OFF' : JSON.stringify(proof.switchValue)}): set it with npm run settings:set at the owner's go, and back to false afterwards`])
      // The writer under the TARGET's rules, and its preflight, before the WMS is read at all (#1128 R1 LOW-2, MED-3).
      try {
        writer = deps.openWriter(args.envFile, target.env)
      } catch (error) {
        if (error instanceof WmsCensusRefused || error instanceof WmsCensusFailed) return refuse([`${reader.label}: ${error.message}`])
        throw error
      }
      const preflight = writer.preflight()
      if (!preflight.ok) return refuse([`the write may not leave under the target installation's rules: ${preflight.problem}`])
      stepEvidence = preflight.evidence
    }

    // ---- what the WMS holds now (GET only, through the injected reader) ----
    let census: WmsCensus
    try {
      census = await reader.read(args.envFile)
    } catch (error) {
      if (error instanceof WmsCensusRefused || error instanceof WmsCensusFailed) return refuse([`${reader.label}: ${error.message}`])
      throw error
    }
    const plan = buildArchivePlan({ sheetId: binding.sheetId, catalogue: result.catalogue, skuRenames: result.skuRenames, census, wmsLabel: reader.label, prepareBlocked: result.blocking })
    const blocked = plan.rows.some((r) => isRefused(r.outcome)) || plan.prepareBlocked
    if (args.execute === null) {
      io.stdout(renderPlan(plan, reader.label, census, true))
      return blocked ? EXIT_CODES.BLOCKING_FINDINGS : EXIT_CODES.OK
    }

    // ---- --execute: the confirmed plan, the import proof, then the writes ----
    const ex = args.execute
    io.stdout(renderPlan(plan, reader.label, census, false))
    if (plan.token !== ex.planToken) return refuse([`--plan-token ${ex.planToken} is not the token of the plan made now (${plan.token}): what ${reader.label} or the decisions hold changed since the dry run. Run the dry run again and review it`])
    if (blocked) {
      io.stderr(`${tool}: nothing was written: the plan refuses at least one SKU; resolve each and run the dry run again.\n`)
      return EXIT_CODES.BLOCKING_FINDINGS
    }
    const writes = plan.rows.filter((r) => r.outcome === 'WOULD_ARCHIVE').map((r) => r.sku)
    const unproven = unprovenImports(proof!, writes)
    if (unproven.length > 0) return refuse([`the import is not proven in the target ${ex.expectDb}: every SKU to be written must be an IMS product whose lifecycle is ARCHIVED (run first-load:apply first)`, ...unproven])
    if (writes.length === 0) {
      io.stdout(`  nothing to write: no SKU of the plan would change in ${reader.label}\n`)
      return EXIT_CODES.OK
    }
    const port = target!.port
    io.stdout(`  writing ${writes.length} SKU(s) to ${reader.label}, one at a time (operator ${ex.operator}, plan ${plan.token}):\n`)
    const outcome = await executeArchivePlan(plan, {
      writer: writer!,
      record: (entry) => recordArchiveWrite(port, executeDeps!.newId, entry),
      imsProductIdOf: (sku) => proof!.products.get(sku)!.id,
      operator: ex.operator,
      stepEvidence,
      switchStillOn: () => archiveSwitchStillOn(port, executeDeps!.switchKey),
      progress: (line) => io.stdout(`${line}\n`),
    })
    io.stdout(renderSummary(outcome, reader.label))
    if (outcome.stopped !== null) {
      io.stderr(`${tool}: STOPPED at ${outcome.stopped.row.sku}: ${outcome.stopped.problem}${outcome.stopped.sent ? ` (the request WAS sent: check the ${reader.label} product ${outcome.stopped.row.productId} by hand)` : ' (nothing was sent for it)'}\n`)
      return EXIT_CODES.OUTPUT_FAILED
    }
    return EXIT_CODES.OK
  } finally {
    if (locked) await target!.unlock().catch(() => undefined)
    await target?.close().catch(() => undefined)
  }
}

export function renderSummary(outcome: ArchiveExecuteResult, label: string): string {
  const lines = ['', `${label} archive write summary`, `  written and verified: ${outcome.verified.length}`]
  for (const r of outcome.verified) lines.push(`    ${r.sku} (${label} product ${r.productId}): discontinued false -> true`)
  if (outcome.stopped !== null) {
    lines.push(`  STOPPED at: ${outcome.stopped.row.sku} (${label} product ${outcome.stopped.row.productId}): ${outcome.stopped.problem}`, `  request sent for it: ${outcome.stopped.sent ? 'yes' : 'no'}`)
    lines.push(`  not attempted: ${outcome.notAttempted.length}${outcome.notAttempted.length > 0 ? ` (${outcome.notAttempted.map((r) => r.sku).join(', ')})` : ''}`)
  }
  lines.push('  every write is recorded in the IMS activity log (entity PRODUCT; actions first_load_wms_archive_attempt / _verified / _failed)', '')
  return lines.join('\n')
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length))

export function renderPlan(plan: ArchivePlan, label: string, census: WmsCensus, dryRun: boolean): string {
  const lines: string[] = [
    `${label} archive plan for the review sheet ${plan.sheetId} ${dryRun ? '(DRY RUN: nothing was written)' : '(EXECUTE: recomputed now from a fresh read)'}`,
    `  ${plan.rows.length} product(s) the owner set to Archived; ${label} read with GET requests only (${census.products.length} product(s) of client ${census.clientId} at ${census.origin}, the physical stock of warehouse(s) ${census.warehouses.join(', ')})`,
    `  would archive ${plan.counts.WOULD_ARCHIVE}; already discontinued ${plan.counts.SKIP_ALREADY_DISCONTINUED}; not a ${label} product ${plan.counts.SKIP_NOT_A_WMS_PRODUCT}; refused ${plan.counts.REFUSED_NOT_FOUND + plan.counts.REFUSED_BUNDLE + plan.counts.REFUSED_FLAG_NOT_STATED + plan.counts.REFUSED_NO_STOCK_ROW + plan.counts.REFUSED_STOCK} (not found ${plan.counts.REFUSED_NOT_FOUND}, bundle ${plan.counts.REFUSED_BUNDLE}, no flag ${plan.counts.REFUSED_FLAG_NOT_STATED}, no stock row ${plan.counts.REFUSED_NO_STOCK_ROW}, stock ${plan.counts.REFUSED_STOCK})`,
  ]
  if (plan.prepareBlocked) lines.push('  BLOCKED: a real first-load:prepare of this manifest is blocked by other findings (not the decisions): the import cannot have been made from it, so nothing can be written')
  lines.push('', `  ${pad('SKU', 28)} ${pad('outcome', 26)} ${pad(`${label} id`, 12)} ${pad('DisCont', 8)} ${pad('stock', 6)} reason`)
  for (const r of plan.rows) {
    lines.push(`  ${pad(r.sku, 28)} ${pad(r.outcome, 26)} ${pad(r.productId ?? '-', 12)} ${pad(r.discontinued === null ? '-' : String(r.discontinued), 8)} ${pad(r.stock === null ? (r.productId !== null && !r.stockRow ? 'none' : '-') : String(r.stock), 6)} ${r.reason}`)
  }
  lines.push('', `  plan token: ${plan.token} (derived from every row above, the sheet, the warehouses, the client and the address; any change gives another token)`, `  plan digest: ${plan.digest}`, '')
  return lines.join('\n')
}
