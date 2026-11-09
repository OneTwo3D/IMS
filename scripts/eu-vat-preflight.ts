#!/usr/bin/env tsx
/**
 * THE EU IOSS / VOEC PREFLIGHT (npm run eu-vat:preflight): see lib/tax/eu-vat-preflight.ts. READ ONLY: it reads the database (IMS rates, storefront mappings, the cached chart, the settings) and the
 * stored copy of Xero's tax-rate list, and never calls Xero or WooCommerce and never writes.
 *
 * HARDENING (as scripts/tax-rekey.ts and scripts/vat-difference-report.ts): the process environment is REPLACED by a short whitelist before the application's database client is imported; the
 * account must be root or the checkout's owner; an argument that looks like a credential is refused; what is printed about a refusal is a closed code, never a value from a vendor.
 * Exit codes: see lib/tax/eu-vat-cli.ts (0 ready, 1 findings, 2 refused, 3 internal).
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { EU_VAT_CLI_CODES, accountAllowed, buildEuVatEnv, euVatPreflightExitCode, parseEuVatArgs, renderEuVatPreflightText, renderEuVatPreflightUsage, type EuVatCliCode } from '../lib/tax/eu-vat-cli.ts'
import type { PreflightResult } from '../lib/tax/eu-vat-preflight.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type EuVatPreflightDeps = { run: () => Promise<PreflightResult>; disconnect: () => Promise<void> }
export type EuVatPreflightCliOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<EuVatPreflightDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultDeps(): Promise<EuVatPreflightDeps> {
  const [{ readEuVatPreflightInput, evaluateEuVatPreflight }, { loadEuVatSeed }, { db }, { captureXeroConnection }, { getWcCredentials }, { normaliseStoreIdentity }] = await Promise.all([
    import('../lib/tax/eu-vat-preflight.ts'), import('../lib/tax/eu-vat-seed.ts'), import('../lib/db/index.ts'), import('../lib/connectors/xero/connection-fence.ts'),
    // Both only read the stored settings and normalise a URL: no request is made.
    import('../lib/connectors/woocommerce/api.ts'), import('../lib/connectors/woocommerce/tax-rate-plan.ts'),
  ])
  return {
    run: async () => {
      const seed = loadEuVatSeed()
      const connection = await captureXeroConnection()
      const creds = await getWcCredentials().catch(() => null)
      const storeIdentity = creds === null ? null : normaliseStoreIdentity(creds.url)
      const input = await readEuVatPreflightInput(db as unknown as Parameters<typeof readEuVatPreflightInput>[0], seed, new Date(), connection?.tenantId ?? null, storeIdentity)
      return evaluateEuVatPreflight(input)
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
export async function runEuVatPreflightCli(options: EuVatPreflightCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: EuVatCliCode): number => { err(`Refused: ${code}\n${EU_VAT_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseEuVatArgs(options.argv, false)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderEuVatPreflightUsage()); return 0 }
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Before anything imports the application's database client.
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(buildEuVatEnv(parent, parent.HOME ?? '/tmp'))
    const given = options.deps
    const deps: EuVatPreflightDeps = given?.run !== undefined && given.disconnect !== undefined ? { run: given.run, disconnect: given.disconnect } : await defaultDeps()
    disconnect = deps.disconnect
    const result = await deps.run()
    out(args.json ? JSON.stringify(result, null, 2) : renderEuVatPreflightText(result))
    return euVatPreflightExitCode(result)
  } catch {
    err('The EU VAT preflight failed before it reached an outcome: INTERNAL. Nothing was written (this command never writes).')
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEuVatPreflightCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
