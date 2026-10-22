#!/usr/bin/env tsx
/**
 * THE RECONCILIATION PACK (npm run reconcile:pack): runs the pack's items, publishes one report, exits with a code derived from
 * the items. READ-ONLY against the database, NO call to any vendor, no secret on a command line, and no overall verdict (the
 * readiness gate decides). Flags, closed codes and exit codes are single-sourced in lib/reconciliation-pack/constants.ts and
 * rendered into docs/installation.md ("Reconciliation pack"); `--help` prints them.
 *
 * HARDENING. The process environment is REPLACED by a short whitelist before the application's database client is imported, so
 * an inherited PG variable, outbound grant or loader variable cannot change what the run reads; the account must be root or the
 * checkout's owner (by uid); an argument that looks like a credential is refused; the report directory and every ancestor must
 * be modifiable only by root or the running account. Problem text is a closed code, never a value from a file or a vendor.
 */

import { lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import { pgConnectionConfig } from '../lib/db/database-url-schema.mjs'
import { loadAcceptances } from '../lib/reconciliation-pack/acceptances.ts'
import { accountAllowed, buildPackEnv, parsePackArgs, type PackArgs } from '../lib/reconciliation-pack/cli.ts'
import {
  PACK_CHAIN_CODES, PACK_CLI_CODES, PACK_CLI_FLAGS, PACK_COMMAND, PACK_EXIT_CODES, packExitCode, renderPackCliCodeTable, renderPackExitCodeTable,
  type PackChainCode, type PackCliCode,
} from '../lib/reconciliation-pack/constants.ts'
import { newRunId } from '../lib/reconciliation-pack/harness.ts'
import { readImsSnapshot, type ImsQueryClient } from '../lib/reconciliation-pack/ims-readers.ts'
import { publishPackReport, type PublishHooks } from '../lib/reconciliation-pack/publish.ts'
import { memoisedInvariant, runItems, type BasisPort, type ItemRunner, type LivenessPort } from '../lib/reconciliation-pack/run.ts'
import { readPackChain } from '../lib/reconciliation-pack/trend.ts'
import type { PackItemId } from '../lib/reconciliation-pack/constants.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 10_000

export type ImsConnection = { client: ImsQueryClient; close: () => Promise<void> }
export type PackCliDeps = {
  now: () => Date
  openIms: () => Promise<ImsConnection>
  /** The invariant report with no-op writers. Evidence of unknown shape: the item runners validate it. */
  runInvariant: () => Promise<unknown>
  liveness?: LivenessPort
  basis?: BasisPort
  runners?: Partial<Record<PackItemId, ItemRunner>>
  /** Called last, whatever happened: closes the application's database client if the invariant run opened it. */
  disconnect: () => Promise<void>
}
export type PackCliOptions = {
  argv: readonly string[]
  /** The environment the command was started with. Defaults to process.env, which is then REPLACED by the whitelist. */
  env?: Record<string, string | undefined>
  /** Test seam: do not touch process.env. */
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<PackCliDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  publishHooks?: PublishHooks
}

const usage = (): string => [
  `Usage: ${PACK_COMMAND} -- --phase <P0|P1|P2> [--as-of <YYYY-MM-DD>] [--items <R3,R4,...>] [--acceptances <file>] [--report-dir <dir>] [--basis-only] [--vendor-reads-only]`,
  '',
  ...PACK_CLI_FLAGS.map((f) => `  ${f.flag}${f.value === '-' ? '' : ` <${f.value}>`}: ${f.meaning}`),
  '',
  'Exit codes:',
  renderPackExitCodeTable(),
  '',
  'Codes printed when the command stops without a report:',
  renderPackCliCodeTable(),
].join('\n')

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultOpenIms(): Promise<ImsConnection> {
  const client = new pg.Client({ ...pgConnectionConfig(process.env.DATABASE_URL), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: 'reconcile-pack' })
  await client.connect()
  return { client: client as unknown as ImsQueryClient, close: () => client.end() }
}

let applicationClientLoaded = false
async function defaultRunInvariant(): Promise<unknown> {
  applicationClientLoaded = true
  const { runInvariantCheckPreflight } = await import('../lib/cron/invariant-check-preflight.ts')
  const { runScheduledInvariantCheck } = await import('../lib/cron/invariant-check.ts')
  const { runInventoryInvariantReport } = await import('../lib/domain/inventory/invariants.ts')
  // The scheduled check with every writer a no-op, and the stock-movement branch read over ALL history: the scheduled check looks back
  // 90 days only, and a pack item that claims "zero critical findings" may not rest on a window.
  return await runInvariantCheckPreflight(() => runScheduledInvariantCheck({
    createRunId: () => `reconcile-pack-${new Date().toISOString()}`,
    writeActivityLog: async () => {},
    notifyAdmins: async () => {},
    getPreviousCriticalFindingsHash: async () => null,
    setCriticalFindingsHash: async () => {},
    runInventoryReport: () => runInventoryInvariantReport({ collectionMode: 'sql', pageSize: 500, maxFindings: 5000, stockMovementLookbackDays: null }),
  }))
}
async function defaultDisconnect(): Promise<void> {
  if (!applicationClientLoaded) return
  const { db } = await import('../lib/db/index.ts')
  let timer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([db.$disconnect(), new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCONNECT_TIMEOUT_MS); timer.unref() })])
  if (timer) clearTimeout(timer)
}

function ownerUid(root: string): number | null {
  try { return lstatSync(root).uid } catch { return null }
}

/** Returns the process exit code. Never throws. */
export async function runPackCli(options: PackCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const deps: PackCliDeps = {
    now: () => new Date(),
    openIms: defaultOpenIms,
    runInvariant: defaultRunInvariant,
    disconnect: defaultDisconnect,
    ...(options.deps ?? {}),
  }
  const refuse = (code: PackCliCode | PackChainCode): number => {
    const meaning = code in PACK_CLI_CODES ? PACK_CLI_CODES[code as PackCliCode] : PACK_CHAIN_CODES[code as PackChainCode]
    err(`Refused: ${code}\n${meaning}\n(run with --help for the usage and the exit codes)`)
    return packExitCode('refused')
  }
  try {
    const now = deps.now()
    const args = parsePackArgs(options.argv, now)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(usage()); return 0 }

    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(repoRoot)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    if (args.vendorReadsOnly) return refuse('VENDOR_READS_RESERVED')
    if (args.basisOnly) return await basisOnly(args, deps, out, err)

    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Before anything imports the application's database client.
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(buildPackEnv(parent, parent.HOME ?? '/tmp'))

    const reportDir = path.resolve(args.reportDir)
    try { mkdirSync(reportDir, { recursive: true, mode: 0o700 }) } catch { return refuse('DIR_UNREADABLE') }
    // readPackChain checks the directory and every ancestor first (DIR_UNTRUSTED), so this is also the trust check.
    const chain = readPackChain(reportDir)
    if (!chain.ok) return refuse(chain.code)

    const accepted = loadAcceptances(args.acceptances, repoRoot)
    if ('refused' in accepted) return refuse('ACCEPTANCE_FILE_UNREADABLE')

    const startedAt = deps.now()
    let systemIdentifier: string | null = null
    try {
      const ims = await deps.openIms()
      try {
        const read = await readImsSnapshot(ims.client, { sections: ['identity'] })
        const identity = read.ok ? read.sections.identity : undefined
        if (identity?.ok === true) systemIdentifier = identity.value.systemIdentifier
      } finally {
        await ims.close().catch(() => undefined)
      }
    } catch { systemIdentifier = null }
    if (systemIdentifier === null) {
      err(`Stopped: DATABASE_UNREADABLE\n${PACK_CLI_CODES.DATABASE_UNREADABLE}`)
      return packExitCode('internal')
    }

    const { items, streams } = await runItems({
      phase: args.phase,
      asOf: args.asOf!,
      selected: args.items,
      liveness: deps.liveness,
      runners: deps.runners,
      context: { phase: args.phase, asOf: args.asOf!, now: deps.now, acceptances: accepted.file, invariant: memoisedInvariant(deps.runInvariant) },
    })
    const finishedAt = deps.now()
    const published = publishPackReport(reportDir, {
      runId: newRunId(startedAt), systemIdentifier, phase: args.phase, asOf: args.asOf!,
      startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), streams, items,
    }, options.publishHooks)
    if (!published.ok) {
      err(`${published.kind === 'refused' ? 'Refused' : 'Not published'}: ${published.code}\n${PACK_CHAIN_CODES[published.code]}`)
      return published.exitCode
    }
    for (const item of published.record.items) out(`${item.id} ${item.outcome} ${item.reasons.join(',') || '-'}`)
    out(`Exit code: ${published.record.exitCode} (${PACK_EXIT_CODES.find((row) => row.code === published.record.exitCode)?.name ?? 'unknown'})`)
    err(`Report: ${published.json}\nReport: ${published.markdown}`)
    return published.exitCode
  } catch {
    err(`The reconciliation pack failed before it reached an outcome (treat as inconclusive): INTERNAL`)
    return packExitCode('internal')
  } finally {
    await deps.disconnect().catch(() => undefined)
  }
}

async function basisOnly(args: PackArgs, deps: PackCliDeps, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  if (!deps.basis) {
    err(`Refused: BASIS_UNAVAILABLE_NOT_BUILT\n${PACK_CLI_CODES.BASIS_UNAVAILABLE_NOT_BUILT}`)
    return packExitCode('refused')
  }
  let reading
  try { reading = await deps.basis.check(args.asOf!) } catch { return packExitCode('internal') }
  // The port's codes are printed only if they are closed-code shaped; anything else is dropped to a count.
  const codes = reading.codes.filter((code) => /^[A-Z][A-Z0-9_]{2,63}$/.test(code)).slice(0, 16)
  out(`Basis for ${args.asOf}: ${reading.ok === true ? 'ready' : 'not ready'}${codes.length ? ` (${codes.join(', ')})` : ''}`)
  return reading.ok === true ? 0 : packExitCode('inconclusive')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPackCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = packExitCode('internal') },
  )
}
