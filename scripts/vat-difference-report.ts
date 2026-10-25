#!/usr/bin/env tsx
/**
 * THE VAT DIFFERENCE REPORT (npm run vat:diff): compares the VAT rates of Xero, IMS and WooCommerce and lists every difference with a reason
 * code. READ ONLY: the database is read in a READ ONLY transaction, WooCommerce through the GET-only transport of the reconciliation pack, Xero not at all
 * (the stored copy of its list, proven first). It never writes anywhere; at P1 the owner corrects WooCommerce by hand from this report.
 *
 * HARDENING (as scripts/reconciliation-pack.ts). The process environment is REPLACED by a short whitelist before the application's database client is
 * imported; the account must be root or the checkout's owner (by uid); an argument that looks like a credential is refused; what is printed about a
 * refusal is a closed code, never a value from a vendor. Exit codes: see lib/tax/vat-difference-cli.ts (0 same, 1 differences, 2 refused, 3 internal).
 */

import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  VAT_DIFF_CLI_CODES, accountAllowed, buildVatDiffEnv, parseVatDiffArgs, renderVatDiffText, renderVatDiffUsage, vatDiffExitCode,
  type VatDiffCliCode,
} from '../lib/tax/vat-difference-cli.ts'
import { createStoredWooPort, runVatDifferenceReport, type VatRunDb } from '../lib/tax/vat-difference-run.ts'
import type { WooGetPort } from '../lib/reconciliation-pack/woo-source.ts'
import type { VatDifferenceReport } from '../lib/tax/vat-difference-report.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type VatDiffDeps = {
  now: () => Date
  /** The application's database client, loaded AFTER the environment was replaced. */
  openDb: () => Promise<{ db: VatRunDb; disconnect: () => Promise<void> }>
  woo: WooGetPort
}
export type VatDiffOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<VatDiffDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  onKeptEnv?: (kept: Readonly<Record<string, string>>) => void
  /** Test seam: told the report the run reached. */
  onReport?: (report: VatDifferenceReport) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultOpenDb(): Promise<{ db: VatRunDb; disconnect: () => Promise<void> }> {
  const { db } = await import('../lib/db/index.ts')
  return {
    db: db as unknown as VatRunDb,
    disconnect: async () => {
      let timer: ReturnType<typeof setTimeout> | null = null
      await Promise.race([db.$disconnect(), new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCONNECT_TIMEOUT_MS); timer.unref() })])
      if (timer) clearTimeout(timer)
    },
  }
}

function ownerUid(root: string): number | null {
  try { return lstatSync(root).uid } catch { return null }
}

/** Returns the process exit code. Never throws. */
export async function runVatDiffCli(options: VatDiffOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: VatDiffCliCode): number => { err(`Refused: ${code}\n${VAT_DIFF_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseVatDiffArgs(options.argv)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderVatDiffUsage()); return 0 }
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Before anything imports the application's database client.
    const kept = buildVatDiffEnv(parent, parent.HOME ?? '/tmp')
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(kept)
    options.onKeptEnv?.(kept)
    const now = options.deps?.now ?? (() => new Date())
    const opened = await (options.deps?.openDb ?? defaultOpenDb)()
    disconnect = opened.disconnect
    const report = await runVatDifferenceReport({ db: opened.db, now, woo: options.deps?.woo ?? createStoredWooPort() })
    options.onReport?.(report)
    out(args.json ? JSON.stringify(report, null, 2) : renderVatDiffText(report))
    return vatDiffExitCode(report)
  } catch {
    err(`The VAT difference report failed before it reached an outcome (treat as not compared): INTERNAL`)
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runVatDiffCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
