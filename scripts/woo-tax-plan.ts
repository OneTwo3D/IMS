#!/usr/bin/env tsx
/**
 * THE IMS TO WOOCOMMERCE TAX-RATE PLAN AND WRITER (npm run woo:tax-plan): see lib/connectors/woocommerce/tax-rate-writer.ts for the model. Without --apply it is a read-only preview that
 * prints the plan and its digest; with --apply --confirm <digest> it applies that plan behind the producer hold (while held: shadows only, nothing is sent). WooCommerce is read with the GET-only
 * transport of the reconciliation pack; the only way it is ever written is the tax-rate port, behind the hold's seam and last barrier.
 *
 * HARDENING (as scripts/tax-rekey.ts). The process environment is REPLACED by a short whitelist before the application's database client is imported (the producer-hold variables are kept
 * and also handed to the decision explicitly); the account must be root or the checkout's owner (by uid); an argument that looks like a credential is refused; what is printed about a
 * refusal is a closed code. Exit codes: see lib/connectors/woocommerce/tax-rate-writer-cli.ts (0 nothing to do / applied, 1 plan lists work, 2 refused, 3 internal).
 */

import { lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  WOO_TAX_PLAN_CLI_CODES, accountAllowed, buildWooTaxPlanEnv, parseWooTaxPlanArgs, pickWooHoldEnv, renderWooTaxPlanText, renderWooTaxPlanUsage, wooTaxPlanExitCode, wooTaxPlanJson, renderWooAdoptionText,
  type WooTaxPlanCliCode, type WooTaxPlanRun,
} from '../lib/connectors/woocommerce/tax-rate-writer-cli.ts'
import type { WooAdoptionPreview, WooAdoptionResult, WooTaxApplyResult, WooTaxHold, WooTaxPreview } from '../lib/connectors/woocommerce/tax-rate-writer.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DISCONNECT_TIMEOUT_MS = 5_000

export type WooTaxPlanDeps = {
  /** Previews, and applies when `confirm` is given, with the application's modules loaded AFTER the environment was replaced. */
  run: (input: { confirm: string | null; adopt?: boolean; holdEnv: Record<string, string> }) => Promise<{
    preview: WooTaxPreview | null
    applied: WooTaxApplyResult | null
    adoptionPreview?: WooAdoptionPreview | null
    adopted?: WooAdoptionResult | null
    hold: WooTaxHold
  }>
  disconnect: () => Promise<void>
}
export type WooTaxPlanCliOptions = {
  argv: readonly string[]
  env?: Record<string, string | undefined>
  keepProcessEnv?: boolean
  uid?: number | null
  checkoutOwnerUid?: number | null
  repoRoot?: string
  deps?: Partial<WooTaxPlanDeps>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  onKeptEnv?: (kept: Readonly<Record<string, string>>) => void
}

function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

async function defaultDeps(): Promise<WooTaxPlanDeps> {
  const [writer, session, api, { db }] = await Promise.all([
    import('../lib/connectors/woocommerce/tax-rate-writer.ts'),
    import('../lib/connectors/woocommerce/tax-rate-session.ts'),
    import('../lib/connectors/woocommerce/api.ts'),
    import('../lib/db/index.ts'),
  ])
  return {
    run: async ({ confirm, adopt, holdEnv }) => {
      // ONE credential resolution for the whole run: the reads and the writes all use it (lib/connectors/woocommerce/tax-rate-session.ts), and the configured store is compared with it before each send.
      const pinned = await api.getWcCredentials().catch(() => null)
      const deps = session.createWooTaxWriterDeps({ pinned, configured: () => api.getWcCredentials(), context: { env: holdEnv } })
      const hold = writer.wooTaxHold({ env: holdEnv })
      if (adopt === true) {
        return confirm === null
          ? { preview: null, applied: null, adoptionPreview: await writer.readWooAdoptionPlan(deps), hold }
          : { preview: null, applied: null, adopted: await writer.applyWooAdoption(deps, { confirm }), hold }
      }
      if (confirm === null) return { preview: await writer.readWooTaxPlan(deps), applied: null, hold }
      return { preview: null, applied: await writer.applyWooTaxPlan(deps, { confirm }), hold }
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
export async function runWooTaxPlanCli(options: WooTaxPlanCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`) })
  const err = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`) })
  const refuse = (code: WooTaxPlanCliCode): number => { err(`Refused: ${code}\n${WOO_TAX_PLAN_CLI_CODES[code]}\n(run with --help for the usage and the exit codes)`); return 3 }
  let disconnect: (() => Promise<void>) | null = null
  try {
    const args = parseWooTaxPlanArgs(options.argv)
    if ('code' in args) return refuse(args.code)
    if (args.help) { out(renderWooTaxPlanUsage()); return 0 }
    const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null
    const owner = options.checkoutOwnerUid !== undefined ? options.checkoutOwnerUid : ownerUid(options.repoRoot ?? REPO_ROOT)
    if (!accountAllowed(uid, owner)) return refuse('ACCOUNT_NOT_ALLOWED')
    const parent = options.env ?? process.env
    if (!parent.DATABASE_URL) return refuse('DATABASE_URL_MISSING')
    // Captured BEFORE the environment is replaced; before anything imports the application's database client.
    const holdEnv = pickWooHoldEnv(parent)
    const kept = buildWooTaxPlanEnv(parent, parent.HOME ?? '/tmp')
    if (options.env === undefined && options.keepProcessEnv !== true) replaceProcessEnv(kept)
    options.onKeptEnv?.(kept)
    const given = options.deps
    const deps: WooTaxPlanDeps = given?.run !== undefined && given.disconnect !== undefined ? { run: given.run, disconnect: given.disconnect } : await defaultDeps()
    disconnect = deps.disconnect
    const done = await deps.run({ confirm: args.confirm, ...(args.adopt ? { adopt: true } : {}), holdEnv })
    const run: WooTaxPlanRun = { args, preview: done.preview, applied: done.applied, adoptionPreview: done.adoptionPreview ?? null, adopted: done.adopted ?? null }
    out(args.json ? JSON.stringify(wooTaxPlanJson(run, done.hold), null, 2) : args.adopt ? renderWooAdoptionText(run) : renderWooTaxPlanText(run, done.hold))
    return wooTaxPlanExitCode(run)
  } catch {
    err('The WooCommerce tax-rate plan failed before it reached an outcome: INTERNAL. Run the preview again to see what state the rates are in.')
    return 3
  } finally {
    if (disconnect) await disconnect().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWooTaxPlanCli({ argv: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code },
    () => { process.exitCode = 3 },
  )
}
