#!/usr/bin/env tsx
/**
 * RE-KEY IMS TAX RATES TO THE CUSTOM TAX CODES OF THE CONNECTED XERO ORGANISATION (npm run tax:rekey): see lib/tax/tax-rekey.ts for the model. Without --apply it is a read-only preview that
 * prints the plan and its digest; with --apply --confirm <digest> it writes that plan in one transaction inside the Xero connection fence. It reads the stored copy of Xero's list and
 * never calls Xero or WooCommerce.
 *
 * HARDENING (as scripts/vat-difference-report.ts and scripts/reconciliation-pack.ts). The process environment is REPLACED by a short whitelist before the application's database client is
 * imported; the account must be root or the checkout's owner (by uid); an argument that looks like a credential is refused; what is printed about a refusal is a closed code and the
 * plan's own figures, never a value from a vendor. Exit codes: see lib/tax/tax-rekey-cli.ts (0 nothing to do / applied, 1 plan lists work, 2 refused, 3 internal).
 */

import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  TAX_REKEY_CLI_CODES, accountAllowed, buildTaxRekeyEnv, parseTaxRekeyArgs, renderTaxRekeyText, renderTaxRekeyUsage, taxRekeyExitCode,
  type TaxRekeyCliCode,
} from '../lib/tax/tax-rekey-cli.ts'
import { pickXeroHoldEnv, type TaxRekeyRunOptions, type TaxRekeyRunResult } from '../lib/tax/tax-rekey.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type TaxRekeyDeps = {
  /** Runs the preview / apply, with the application's database client loaded AFTER the environment was replaced. */
  run: (options: TaxRekeyRunOptions) => Promise<TaxRekeyRunResult>
  disconnect: () => Promise<void>
}
export type TaxRekeyCliOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<TaxRekeyDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  onKeptEnv?: (kept: Readonly<Record<string, string>>) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultDeps(): Promise<TaxRekeyDeps> {
  const [{ runTaxRekey }, { db }] = await Promise.all([import('../lib/tax/tax-rekey.ts'), import('../lib/db/index.ts')])
  return {
    run: runTaxRekey,
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
export async function runTaxRekeyCli(options: TaxRekeyCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: TaxRekeyCliCode): number => { err(`Refused: ${code}\n${TAX_REKEY_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseTaxRekeyArgs(options.argv)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderTaxRekeyUsage()); return 0 }
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Before anything imports the application's database client.
    // The Xero hold is read from the caller's environment (the same variables the application's producers obey); captured BEFORE the environment is replaced.
    const producerEnv = pickXeroHoldEnv(parent)
    const kept = buildTaxRekeyEnv(parent, parent.HOME ?? '/tmp')
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(kept)
    options.onKeptEnv?.(kept)
    const given = options.deps
    const deps: TaxRekeyDeps = given?.run !== undefined && given.disconnect !== undefined ? { run: given.run, disconnect: given.disconnect } : await defaultDeps()
    disconnect = deps.disconnect
    const result = await deps.run({ apply: args.apply, confirm: args.confirm ?? undefined, allowUnposted: args.allowUnposted, producerEnv })
    out(args.json ? JSON.stringify(result, null, 2) : renderTaxRekeyText(result))
    return taxRekeyExitCode(result)
  } catch {
    err('The tax re-key failed before it reached an outcome: INTERNAL. Run the preview again to see what state the rates are in.')
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTaxRekeyCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
