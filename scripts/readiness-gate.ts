#!/usr/bin/env tsx
/**
 * THE READINESS GATE (npm run readiness:gate).
 *
 * One command, one verdict: GO, GO-WITH-ACCEPTED-WARNINGS or NO-GO for a phase (P0, P1, P2) of the
 * switchover, from the checks catalogued in lib/ops/readiness-gate-constants.ts. READ-ONLY against the
 * database it is pointed at, no call to any vendor, no secret on a command line.
 *
 * Usage:
 *   npm run readiness:gate -- --phase <P0|P1|P2> [--expect-granted <connector[,connector]|none>]
 *                             [--acceptances <file>] [--rehearsal-dir <dir>] [--report-dir <dir>] [--json]
 *
 * Exit codes: READINESS_GATE_EXIT_CODES in lib/ops/readiness-gate-constants.ts, documented once in
 * docs/installation.md ("Readiness gate"); a test compares the two. Operator text lives in the same module.
 *
 * DATABASE_URL must be in the environment: the gate does not read .env files. The outbound check reads the
 * grant variables of THIS process, so run it with the environment the services run with.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildGateReport,
  decideVerdict,
  parseAcceptanceFile,
  renderGateMarkdown,
  type AcceptanceFile,
} from '../lib/ops/readiness-gate.ts'
import {
  ACCEPTANCES_DEFAULT_FILE,
  DEFAULT_REHEARSAL_DIR,
  DEFAULT_REPORT_DIR,
  READINESS_GATE_COMMAND,
  READINESS_GATE_EXIT_CODES,
  READINESS_PHASES,
  readinessGateExitCode,
  type ReadinessPhase,
} from '../lib/ops/readiness-gate-constants.ts'
import {
  collectGateResults,
  defaultReadOutbound,
  defaultReadReconciliation,
  defaultRunInvariant,
  readNewestRehearsal,
  readPackageScriptsFrom,
  runNpmScript,
  type GateDeps,
} from '../lib/ops/readiness-gate-collect.ts'
import { publishGateReport } from '../lib/ops/readiness-gate-publish.ts'
import { checkAncestors, verifyPublishedReport } from '../lib/ops/published-report.ts'
import { OUTBOUND_CONNECTORS } from '../lib/security/outbound-write-hold-constants.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000
const MAX_ACCEPTANCE_BYTES = 1024 * 1024

export type GateCliArgs = {
  phase: ReadinessPhase
  expectGranted: string[] | null
  acceptances: string | null
  rehearsalDir: string
  reportDir: string
  json: boolean
  help: boolean
}

const USAGE = `Usage: ${READINESS_GATE_COMMAND} -- --phase <${READINESS_PHASES.join('|')}> [--expect-granted <${OUTBOUND_CONNECTORS.join('|')}[,...]|none>] [--acceptances <file>] [--rehearsal-dir <dir>] [--report-dir <dir>] [--json]

Exit codes:
${READINESS_GATE_EXIT_CODES.map((row) => `  ${String(row.code).padStart(2)}  ${row.name}: ${row.meaning}`).join('\n')}
`

export function parseGateArgs(argv: readonly string[]): GateCliArgs | { error: string } {
  const out: GateCliArgs = { phase: 'P0', expectGranted: null, acceptances: null, rehearsalDir: DEFAULT_REHEARSAL_DIR, reportDir: DEFAULT_REPORT_DIR, json: false, help: false }
  let phase: ReadinessPhase | null = null
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (arg === '--json') { out.json = true; continue }
    if (['--phase', '--expect-granted', '--acceptances', '--rehearsal-dir', '--report-dir'].includes(arg)) {
      if (seen.has(arg)) return { error: `${arg} was given more than once` }
      seen.add(arg)
      const value = argv[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) return { error: `${arg} needs a value` }
      i += 1
      if (arg === '--phase') {
        if (!(READINESS_PHASES as readonly string[]).includes(value)) return { error: `--phase must be one of ${READINESS_PHASES.join(', ')}` }
        phase = value as ReadinessPhase
      } else if (arg === '--expect-granted') {
        const names = value === 'none' ? [] : value.split(',')
        const bad = names.filter((name) => !(OUTBOUND_CONNECTORS as readonly string[]).includes(name))
        if (bad.length > 0 || new Set(names).size !== names.length) return { error: `--expect-granted must be none or a comma-separated list of distinct connectors from ${OUTBOUND_CONNECTORS.join(', ')}` }
        out.expectGranted = names
      } else if (arg === '--acceptances') out.acceptances = value
      else if (arg === '--rehearsal-dir') out.rehearsalDir = value
      else out.reportDir = value
      continue
    }
    return { error: `unknown argument ${arg}` }
  }
  if (out.help) return out
  if (phase === null) return { error: '--phase is required (there is no default: the same installation can be ready for one phase and not the next)' }
  out.phase = phase
  if (phase === 'P2' && out.expectGranted === null) return { error: '--expect-granted is required for P2: name the connectors that are meant to be able to write, or none' }
  if (phase !== 'P2' && out.expectGranted !== null) return { error: `--expect-granted applies to P2 only; ${phase} expects every connector held` }
  return out
}

function readAcceptanceText(file: string): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error(`${file} is not a regular file`)
    if (info.size > MAX_ACCEPTANCE_BYTES) throw new Error(`${file} is larger than ${MAX_ACCEPTANCE_BYTES} bytes`)
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < info.size) {
      const n = readSync(fd, buffer, read, info.size - read, read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The acceptance file. A DEFAULT path that does not exist means none; a NAMED path that does not exist is a refusal. */
export function loadAcceptances(args: Pick<GateCliArgs, 'acceptances'>, repoRoot: string): { file: AcceptanceFile; path: string | null } | { refused: string } {
  const explicit = args.acceptances !== null
  const file = path.resolve(explicit ? args.acceptances! : path.join(repoRoot, ACCEPTANCES_DEFAULT_FILE))
  try {
    return { file: parseAcceptanceFile(readAcceptanceText(file)), path: file }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !explicit) return { file: parseAcceptanceFile(null), path: null }
    if (explicit) return { refused: `the acceptance file ${file} could not be read (${code ?? (error as Error).message})` }
    return { file: { status: 'rejected', problems: [`the default acceptance file ${file} could not be read (${code ?? (error as Error).message})`], entries: [] }, path: file }
  }
}

function defaultDeps(env: Record<string, string | undefined>): GateDeps {
  const now = () => new Date()
  return {
    now,
    runInvariant: defaultRunInvariant,
    readOutbound: () => defaultReadOutbound(now()),
    readReconciliation: defaultReadReconciliation,
    runScript: runNpmScript,
    readPackageScripts: () => readPackageScriptsFrom(REPO_ROOT),
    readNewestRehearsal: (dir) => readNewestRehearsal(dir, verifyPublishedReport),
    env,
    repoRoot: REPO_ROOT,
  }
}

async function disconnectDb(): Promise<void> {
  const { db } = await import('@/lib/db')
  let timeout: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    db.$disconnect(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, DISCONNECT_TIMEOUT_MS)
      timeout.unref()
    }),
  ])
  if (timeout) clearTimeout(timeout)
}

export type GateRunOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  deps?: GateDeps
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  disconnect?: () => Promise<void>
  /** Test seam only; the command line never reaches it. */
  publishHooks?: Parameters<typeof publishGateReport>[2]
  repoRoot?: string
}

/** Returns the process exit code. Never throws. */
export async function runReadinessGate(options: GateRunOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const env = options.env ?? process.env
  const refused = (message: string): number => {
    stderr(`Refused: ${message}\n\n${USAGE}`)
    return readinessGateExitCode('refused')
  }
  try {
    const args = parseGateArgs(options.argv)
    if ('error' in args) return refused(args.error)
    if (args.help) {
      stdout(USAGE)
      return 0
    }
    if (!env.DATABASE_URL) return refused('DATABASE_URL is not set in the environment. The gate does not read .env files; export it from the installation\'s environment file (without putting it on a command line).')

    const reportDir = path.resolve(args.reportDir)
    try {
      lstatSync(reportDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refused(`the report directory ${reportDir} cannot be inspected`)
      const parentProblem = checkAncestors(path.dirname(reportDir), '--report-dir parent')
      if (parentProblem) return refused(parentProblem)
      mkdirSync(reportDir, { mode: 0o700 })
    }
    const ancestorProblem = checkAncestors(reportDir, '--report-dir')
    if (ancestorProblem) return refused(ancestorProblem)

    const repoRoot = options.repoRoot ?? REPO_ROOT
    const accepted = loadAcceptances(args, repoRoot)
    if ('refused' in accepted) return refused(accepted.refused)

    const deps = options.deps ?? defaultDeps(env)
    stderr(`Readiness gate for ${args.phase}: collecting checks (validate:db can take several minutes).`)
    const { results, notes } = await collectGateResults({ phase: args.phase, expectGranted: args.expectGranted, rehearsalDir: path.resolve(args.rehearsalDir) }, deps)
    const now = deps.now()
    const verdict = decideVerdict({ phase: args.phase, results, acceptances: accepted.file, now })
    const runId = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}`
    const report = buildGateReport({ runId, now, phase: args.phase, expectGranted: args.expectGranted, verdict, acceptances: accepted.file, acceptancePath: accepted.path, notes })

    const published = publishGateReport(report, reportDir, options.publishHooks)
    let exitCode = verdict.exitCode
    if (!published.ok) {
      stderr(`The report could not be published (${published.error}).`)
      // A GO that cannot be read back is not a GO. NO-GO stays NO-GO.
      if (verdict.verdict !== 'NO-GO') exitCode = readinessGateExitCode('report-not-published')
    }
    const markdown = renderGateMarkdown({ ...report, exitCode })
    if (args.json) {
      stderr(markdown)
      stdout(published.ok ? JSON.stringify(published.record, null, 2) : JSON.stringify({ ...report, exitCode, published: false }, null, 2))
    } else {
      stdout(markdown)
    }
    if (published.ok) stderr(`Report: ${published.json}\nReport: ${published.markdown}`)
    return exitCode
  } catch (error) {
    stderr(`The readiness gate failed before it reached a verdict (treat as NO-GO): ${error instanceof Error ? error.message : String(error)}`)
    return readinessGateExitCode('failed')
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runReadinessGate({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = readinessGateExitCode('failed')
    },
  )
}
