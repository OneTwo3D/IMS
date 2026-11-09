#!/usr/bin/env tsx
/**
 * APPLY THE EU IOSS / VOEC RATE DECLARATION TO THE IMS DATABASE (npm run eu-vat:seed): see lib/tax/eu-vat-preflight.ts. It sets schemePostingTaxType and reportingCategory (IOSS or VOEC) on the IMS rates
 * lib/tax/eu-vat-seed.json declares, through the WooCommerce mappings that name them, and nothing else. It is a DRY RUN unless --apply --confirm <digest> is given (the digest of the plan the dry run
 * printed). It never calls Xero or WooCommerce, never writes a tax rate to Xero, never creates a rate, and nothing runs it automatically.
 *
 * HARDENING: as scripts/eu-vat-preflight.ts. Exit codes: see lib/tax/eu-vat-cli.ts (0 nothing to do / applied, 1 dry run lists work, 2 refused, 3 internal).
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { EU_VAT_CLI_CODES, accountAllowed, buildEuVatEnv, euVatSeedExitCode, parseEuVatArgs, renderEuVatSeedText, renderEuVatSeedUsage, type EuVatCliCode } from '../lib/tax/eu-vat-cli.ts'
import type { EuVatSeedApplyResult } from '../lib/tax/eu-vat-preflight.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type EuVatSeedDeps = {
  /** The dry run (confirm absent) or the apply (confirm = the digest), with the application's database client loaded AFTER the environment was replaced. */
  run: (options: { apply: boolean; confirm: string | null }) => Promise<EuVatSeedApplyResult>
  disconnect: () => Promise<void>
}
export type EuVatSeedCliOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<EuVatSeedDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultDeps(): Promise<EuVatSeedDeps> {
  const [{ applyEuVatSeed, planEuVatSeedApply, readEuVatImsSide }, { loadEuVatSeed }, { db }] = await Promise.all([
    import('../lib/tax/eu-vat-preflight.ts'), import('../lib/tax/eu-vat-seed.ts'), import('../lib/db/index.ts'),
  ])
  type Tx = Parameters<typeof readEuVatImsSide>[0]
  return {
    run: async ({ apply, confirm }) => {
      const seed = loadEuVatSeed()
      if (apply && confirm !== null) return applyEuVatSeed(db as unknown as Parameters<typeof applyEuVatSeed>[0], seed, confirm)
      // The dry run: read only.
      const plan = planEuVatSeedApply({ seed, ...(await readEuVatImsSide(db as unknown as Tx)) })
      return { applied: false, plan, refusal: null }
    },
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
export async function runEuVatSeedCli(options: EuVatSeedCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: EuVatCliCode): number => { err(`Refused: ${code}\n${EU_VAT_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseEuVatArgs(options.argv, true)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderEuVatSeedUsage()); return 0 }
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(buildEuVatEnv(parent, parent.HOME ?? '/tmp'))
    const given = options.deps
    const deps: EuVatSeedDeps = given?.run !== undefined && given.disconnect !== undefined ? { run: given.run, disconnect: given.disconnect } : await defaultDeps()
    disconnect = deps.disconnect
    const result = await deps.run({ apply: args.apply, confirm: args.confirm })
    out(args.json ? JSON.stringify(result, null, 2) : renderEuVatSeedText(result, args.apply))
    return euVatSeedExitCode(result)
  } catch {
    err('The EU VAT seed failed before it reached an outcome: INTERNAL. Run the dry run again to see what state the rates are in.')
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEuVatSeedCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
