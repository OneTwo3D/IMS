#!/usr/bin/env tsx
/**
 * THE EU VAT SHADOW REPORT (npm run eu-vat:shadow): see lib/tax/eu-vat-shadow-cli.ts for the usage and lib/tax/eu-vat-shadow-live.ts for what it reads.
 *
 * READ ONLY. For the chosen EU orders it builds, in memory, the sales invoice IMS would post (the real builder, the treatment forced on for this build only) and compares it with the invoice Xero holds. It performs GET
 * requests only, and it never enqueues, writes, posts or stamps. It REQUIRES the explicit --live-read flag, because it reads the live Xero organisation and the live store: run it only when the owner has said to.
 *
 * HARDENING (as scripts/eu-vat-preflight.ts): the process environment is REPLACED by a short whitelist before the application's database client is imported; the account must be root or the checkout's owner; an
 * argument that looks like a credential is refused; what is printed about a refusal is a closed code, never a value from a vendor.
 * Exit codes: see lib/tax/eu-vat-shadow-cli.ts (0 all match, 1 not all match, 3 refused or internal).
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EU_VAT_SHADOW_CLI_CODES, accountAllowed, buildEuVatShadowEnv, euVatShadowExitCode, euVatShadowJson, parseEuVatShadowArgs, renderEuVatShadowText, renderEuVatShadowUsage,
  type EuVatShadowArgs, type EuVatShadowCliCode,
} from '../lib/tax/eu-vat-shadow-cli.ts'
import type { ShadowReport } from '../lib/tax/eu-vat-shadow-run.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type EuVatShadowDeps = { run: (args: EuVatShadowArgs) => Promise<ShadowReport>; disconnect: () => Promise<void> }
export type EuVatShadowCliOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<EuVatShadowDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultDeps(): Promise<EuVatShadowDeps> {
  const [{ runEuVatShadow }, { createLiveShadowPorts }, { db }] = await Promise.all([
    import('../lib/tax/eu-vat-shadow-run.ts'), import('../lib/tax/eu-vat-shadow-live.ts'), import('../lib/db/index.ts'),
  ])
  return {
    run: async (args) => {
      if (args.selection === null) throw new Error('no selection')
      const ports = await createLiveShadowPorts(new Date())
      return runEuVatShadow(ports, { selection: args.selection, maxOrders: args.maxOrders })
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
export async function runEuVatShadowCli(options: EuVatShadowCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: EuVatShadowCliCode): number => { err(`Refused: ${code}\n${EU_VAT_SHADOW_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseEuVatShadowArgs(options.argv)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderEuVatShadowUsage()); return 0 }
    // The explicit statement that reading the live Xero organisation and the live store is intended, checked BEFORE anything else is touched.
    if (!args.liveRead) return refuse('LIVE_READ_REQUIRED')
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Before anything imports the application's database client.
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(buildEuVatShadowEnv(parent, parent.HOME ?? '/tmp'))
    err('--live-read: this command performs GET requests only (Xero invoices, WooCommerce orders) and reads the IMS database. It writes, posts, enqueues and stamps nothing.')
    const given = options.deps
    const deps: EuVatShadowDeps = given?.run !== undefined && given.disconnect !== undefined ? { run: given.run, disconnect: given.disconnect } : await defaultDeps()
    disconnect = deps.disconnect
    const report = await deps.run(args)
    out(args.json ? JSON.stringify(euVatShadowJson(report), null, 2) : renderEuVatShadowText(report))
    return euVatShadowExitCode(report)
  } catch {
    err(`The EU VAT shadow report failed before it reached an outcome: INTERNAL. ${EU_VAT_SHADOW_CLI_CODES.INTERNAL}.`)
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEuVatShadowCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
