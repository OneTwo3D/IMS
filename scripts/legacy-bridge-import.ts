import { pathToFileURL } from 'node:url'

import {
  LEGACY_IMPORT_EXIT,
  renderLegacyImportReport,
  runLegacyBridgeImport,
  type LegacyImportOptions,
  type LegacyImportPorts,
  type LegacyImportReport,
} from '@/lib/connectors/mintsoft/legacy-bridge-import/run'
import { RESOLUTION_DECISIONS, type ResolutionDecision } from '@/lib/connectors/mintsoft/legacy-bridge-import/state'

/**
 * `npm run cutover:legacy-import [-- --apply --bridge-stopped] [-- --verify-mintsoft] [-- --statuses a,b] [-- --connector id] [-- --verify-max N] [-- --json]`
 * `npm run cutover:legacy-import -- --resolve <wcOrderId>[,<id>...] --as <ours|not-ours|cancelled> [--apply --bridge-stopped]`
 *
 * Imports the legacy bridge's `_mintsoft_*` order state into IMS's own link rows (o3d-zvec.22) and prints the Step M precondition report.
 * DRY RUN BY DEFAULT: nothing is written without --apply. WooCommerce is only ever read (GET). Mintsoft is not called at all unless
 * --verify-mintsoft is given, and then only read. Exit 0: the precondition is met and the OrderNumber check was proved against Mintsoft; 1: the run
 * failed; 2: usage; 3: the precondition is not met (a non-empty order prefix, an OrderNumber mismatch, a conflict, a verify-pending / verify-exhausted
 * order, a queued bridge update or cancel with a Mintsoft order, no orders read, an unimported order or an open merge item); 4: no blocker, but the
 * OrderNumber check is UNVERIFIED (it compared the bridge's own meta only: rerun with --verify-mintsoft). In --json the same is `gate.status`
 * ('met' | 'met-unverified' | 'not-met') and `gate.verified`.
 *
 * `--resolve` records the operator's decision, taken after checking the Mintsoft order BY HAND, for a blocked order (verify-pending, verify-exhausted,
 * a queued bridge update or cancel left by a stopped bridge, or a cancelled WooCommerce order IMS never imported): `ours` (the Mintsoft order is this
 * order's: SYNCED link), `not-ours` (it is not: no link, IMS creates the order afresh) or `cancelled` (it was cancelled in Mintsoft: CANCELLED link).
 * Without --apply it only shows what would happen; with --apply (and --bridge-stopped) it records the decision in the activity log and writes ONLY
 * those orders' links. A recorded decision clears the blocker on every later run, until the order's bridge state changes.
 */

const DISCONNECT_TIMEOUT_MS = 5_000
const USAGE = 'Usage: npm run cutover:legacy-import [-- --apply --bridge-stopped] [-- --verify-mintsoft] [-- --verify-max N] [-- --statuses a,b,c] [-- --connector id] [-- --json] | -- --resolve <wcOrderId>[,<id>...] --as <ours|not-ours|cancelled> [--apply --bridge-stopped]'

type Logger = Pick<typeof console, 'log' | 'error'>

export type LegacyImportCliOptions = {
  argv?: string[]
  ports?: (flags: { verifyMintsoft: boolean; connector?: string }) => Promise<LegacyImportPorts> | LegacyImportPorts
  defaultStatuses?: () => Promise<string[]>
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
  now?: () => Date
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

/**
 * The statuses a bridge order can be in: the configured pull statuses, processing, on-hold, both spellings of the bridge's partial-shipped status, the
 * withdrawal-submitted status, and CANCELLED and REFUNDED. A customer who cancels keeps a queued bridge cancel (the bridge leaves it queued while a verify id
 * is unproved or the cancel keeps failing), and the WooCommerce REST API cannot filter orders by meta, so the bridge's status-independent queues
 * (`_mintsoft_sync_pending`, `_mintsoft_verify_order_id`, `_mintsoft_dead_letter`) are reached by reading those statuses too.
 */
export function bridgeOrderStatuses(pulled: readonly string[], withdrawalSubmitted: string): string[] {
  return [...new Set([...pulled, 'processing', 'on-hold', 'partial-shipped', 'partially-shipped', withdrawalSubmitted, 'cancelled', 'refunded'])].filter((s) => s !== '')
}

async function defaultStatuses(): Promise<string[]> {
  const { getWcPullStatuses } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { getWithdrawalStatuses } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  const [pulled, withdrawal] = await Promise.all([getWcPullStatuses('reconcile'), getWithdrawalStatuses()])
  return bridgeOrderStatuses(pulled, withdrawal.submitted)
}

export async function runLegacyImportCli(options: LegacyImportCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)

  let apply = false
  let bridgeStopped = false
  let verifyMintsoft = false
  let json = false
  let verifyMax: number | undefined
  let connector: string | undefined
  let statuses: string[] | undefined
  let resolveIds: string[] | undefined
  let resolveAs: ResolutionDecision | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--bridge-stopped') { bridgeStopped = true; continue }
    if (arg === '--verify-mintsoft') { verifyMintsoft = true; continue }
    if (arg === '--json') { json = true; continue }
    if (arg === '--verify-max') {
      const raw = args[index + 1]
      if (raw === undefined || !/^[1-9][0-9]{0,5}$/.test(raw)) { stderr.error(`--verify-max needs a whole number. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      verifyMax = Number(raw)
      index += 1
      continue
    }
    if (arg === '--connector') {
      const raw = args[index + 1]
      if (raw === undefined || !/^[a-z0-9-]{1,40}$/.test(raw)) { stderr.error(`--connector needs a connector id. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      connector = raw
      index += 1
      continue
    }
    if (arg === '--resolve') {
      const parsed = (args[index + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (parsed.length === 0 || parsed.some((id) => !/^[0-9]{1,15}$/.test(id))) { stderr.error(`--resolve needs one or more WooCommerce order ids (the "id" the report prints), comma separated. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      resolveIds = [...new Set(parsed)]
      index += 1
      continue
    }
    if (arg === '--as') {
      const raw = args[index + 1]
      if (raw === undefined || !(RESOLUTION_DECISIONS as readonly string[]).includes(raw)) { stderr.error(`--as needs one of ${RESOLUTION_DECISIONS.join(', ')}. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      resolveAs = raw as ResolutionDecision
      index += 1
      continue
    }
    if (arg === '--statuses') {
      const raw = args[index + 1]
      const parsed = (raw ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^wc-/, '')).filter(Boolean)
      if (parsed.length === 0 || parsed.some((s) => !/^[a-z0-9_-]{1,40}$/.test(s))) { stderr.error(`--statuses needs a comma-separated list of order statuses. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      statuses = parsed
      index += 1
      continue
    }
    stderr.error(`Unknown argument ${arg}. ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }

  if ((resolveIds === undefined) !== (resolveAs === undefined)) {
    stderr.error(`--resolve and --as go together. ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }
  const resolve: LegacyImportOptions['resolve'] = resolveIds !== undefined && resolveAs !== undefined ? { wcOrderIds: resolveIds, decision: resolveAs } : undefined

  if (apply && !bridgeStopped) {
    stderr.error(`--apply refuses without --bridge-stopped: pass it only once the bridge has stopped creating, merging, verifying and syncing orders (design step 3). ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }

  try {
    const ports = options.ports
      ? await options.ports({ verifyMintsoft, connector })
      : (await import('@/lib/connectors/mintsoft/legacy-bridge-import/ports')).createLegacyImportPorts({ verifyMintsoft, connector })
    const resolvedStatuses = statuses ?? await (options.defaultStatuses ?? defaultStatuses)()
    const report: LegacyImportReport = await runLegacyBridgeImport(ports, { apply, bridgeStopped, verifyMintsoft, verifyMax, resolve, statuses: resolvedStatuses, now: options.now })
    if (json) stdout.log(JSON.stringify(report, null, 2))
    else {
      stdout.log(renderLegacyImportReport(report))
      stdout.log(`Exit code ${report.gate.exitCode}.`)
    }
    return report.gate.exitCode
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return LEGACY_IMPORT_EXIT.failed
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLegacyImportCli()
    .then((code) => { process.exit(code) })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(LEGACY_IMPORT_EXIT.failed)
    })
}
