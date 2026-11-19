import { pathToFileURL } from 'node:url'

import {
  DecisionRefusedError,
  LEGACY_IMPORT_EXIT,
  renderLegacyImportReport,
  withHistoryStatuses,
  runLegacyBridgeImport,
  type HistoryWindow,
  type LegacyImportOptions,
  type LegacyImportPorts,
  type LegacyImportReport,
} from '@/lib/connectors/mintsoft/legacy-bridge-import/run'
import { RESOLUTION_DECISIONS, type ResolutionDecision } from '@/lib/connectors/mintsoft/legacy-bridge-import/state'

/**
 * `npm run cutover:legacy-import [-- --apply --bridge-stopped --bridge-fence-cleared --by <name>] [-- --verify-mintsoft] [-- --statuses a,b] [-- --connector id] [-- --verify-max N] [-- --json]`
 * `npm run cutover:legacy-import -- --resolve <wcOrderId>[,<id>...] --as <ours|not-ours|cancelled> [--apply --bridge-stopped]`
 *
 * A full `--apply` also needs `--bridge-fence-cleared --by <name>` (an attestation, recorded in the apply audit, that on the bridge host `var/manual_reconcile.json` is resolved and empty and
 * `var/minted_orders.json` holds no `intent` / `intent-unseen` entry; IMS cannot read the bridge host). A `--resolve` / grouped apply does not need it.
 *
 * Imports the legacy bridge's `_mintsoft_*` order state into IMS's own link rows (o3d-zvec.22) and prints the Step M precondition report.
 * DRY RUN BY DEFAULT: nothing is written without --apply. WooCommerce is only ever read (GET). Mintsoft is not called at all unless
 * --verify-mintsoft is given, and then only read. Exit 0: the precondition is met and the OrderNumber check was proved against Mintsoft; 1: the run
 * failed; 2: usage; 3: the precondition is not met (a non-empty order prefix, an OrderNumber mismatch, a conflict, a verify-pending / verify-exhausted
 * order, a queued bridge update or cancel with a Mintsoft order, no orders read, an unimported order, a historic-queued order or an open merge item, or a
 * preview); 4: no blocker, but the OrderNumber check is UNVERIFIED (it compared the bridge's own meta only: rerun with --verify-mintsoft); 5: a --resolve or
 * grouped decision was REFUSED by a guard (a Mintsoft mismatch, a live order, a wrong decision): nothing was recorded, and it is not a crash. In --json the same is
 * `gate.status` ('met' | 'met-unverified' | 'met-if-recorded' | 'not-met') and `gate.verified`; `met-if-recorded` (exit 3, `report.preview` true) is a dry run that
 * carries a requested decision nobody has recorded: it is never MET.
 *
 * CANCELLED / REFUNDED HISTORY: only orders modified inside a window are LINKED or GROUPED: `--history-days N` (default 60) or `--history-since YYYY-MM-DD`. The window
 * never hides a queued bridge action: the WHOLE older cancelled / refunded history is also read (paced, with a minimal `_fields` list: a smaller response, not a lighter server-side load), and an order outside the window that
 * carries `_mintsoft_sync_pending` with a Mintsoft id, a verify id with no trusted id, or an id-less fenced shape (a queued update / cancel, `_mintsoft_verify_pending` or `_mintsoft_dead_letter` with no Mintsoft id) is a gate blocker of its own kind, `historic-queued`,
 * never linked, cleared by `--resolve <wcOrderId> --as cancelled` after the Mintsoft order is cancelled (read-checked; an order with no id is looked up by order number: cancelled when Mintsoft has none or holds it CANCELLED). The same id-less shapes block inside the window too. The report previews the counts.
 * `--statuses` is always unioned with cancelled and refunded. An in-window cancelled / refunded order with a Mintsoft order that IMS will not link (no IMS order,
 * IMS does not show it cancelled, or it is fully refunded and still PROCESSING) is ONE grouped gate blocker, cleared by ONE decision:
 * `--resolve-all-historic-cancelled --as cancelled --reason "<why>" [--apply --bridge-stopped]` (each member is re-read in Mintsoft: cancelled or despatched; a member
 * that is live there, a merge survivor holding another order, or only found by number is LEFT OUT and resolved on its own: `--resolve <wcOrderId> --as cancelled`, or
 * `--as ours` for a merge survivor whose other order is live). Historic orders IMS still holds as PROCESSING are flagged in the report: they stay out of creation only
 * while the step M create floor (paidNotBefore; PRODUCER_HOLD_ENFORCED_DESTINATIONS covering mintsoft) is in force.
 *
 * READ COST: the outside-window history is read FIRST, then each status set is walked twice (the second walk, ids only, is the id-set drift check anchored on the set's high-water id). `--no-drift-check` skips the second walk for a READ-ONLY PREVIEW (the report then fails the gate); `--apply` refuses it.
 *
 * `--resolve` records the operator's decision, taken after checking the Mintsoft order BY HAND, for a blocked order (verify-pending, verify-exhausted,
 * a queued bridge update or cancel left by a stopped bridge, or a cancelled WooCommerce order IMS never imported): `ours` (the Mintsoft order is this
 * order's: SYNCED link), `not-ours` (it is not: no link, IMS creates the order afresh) or `cancelled` (it was cancelled in Mintsoft: CANCELLED link).
 * `not-ours` is refused when the bridge PROVED the id (and, on a cancelled / refunded order, unless both the id and the number search say absent), and `ours` / `cancelled` are checked read-only against Mintsoft (order number; status; an order with no id by its number) first: any mismatch refuses. A merge survivor adopted with `ours` is always MERGED (Mintsoft's "a+b" number or MergedOrder flag decides, not the WooCommerce flag).
 * Without --apply it only shows what would happen (the gate then reads "MET IF RECORDED", exit 3, never MET); with --apply (and --bridge-stopped) it records the decision in the activity log and writes ONLY
 * those orders' links. A recorded decision clears the blocker on every later run, until the order's bridge state changes.
 */

const DISCONNECT_TIMEOUT_MS = 5_000
const USAGE = 'Usage: npm run cutover:legacy-import [-- --apply --bridge-stopped --bridge-fence-cleared --by <name>] [-- --verify-mintsoft] [-- --verify-max N] [-- --statuses a,b,c] [-- --connector id] [-- --history-days N | --history-since YYYY-MM-DD] [-- --no-drift-check] [-- --json] | -- --resolve <wcOrderId>[,<id>...] --as <ours|not-ours|cancelled> [--apply --bridge-stopped] | -- --resolve-all-historic-cancelled --as cancelled --reason "<why>" [--apply --bridge-stopped]'

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
/** The default window for cancelled / refunded history. */
export const DEFAULT_HISTORY_DAYS = 60

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
  let bridgeFenceCleared = false
  let by: string | undefined
  let verifyMintsoft = false
  let json = false
  let noDriftCheck = false
  let verifyMax: number | undefined
  let connector: string | undefined
  let statuses: string[] | undefined
  let resolveIds: string[] | undefined
  let resolveAs: ResolutionDecision | undefined
  let resolveAllHistoric = false
  let reason: string | undefined
  let historyDays: number | undefined
  let historySince: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--bridge-stopped') { bridgeStopped = true; continue }
    if (arg === '--bridge-fence-cleared') { bridgeFenceCleared = true; continue }
    if (arg === '--by') {
      const raw = (args[index + 1] ?? '').trim()
      if (raw.length < 2 || raw.length > 80 || raw.startsWith('--')) { stderr.error(`--by needs the operator's name (2 to 80 characters). ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      by = raw
      index += 1
      continue
    }
    if (arg === '--verify-mintsoft') { verifyMintsoft = true; continue }
    if (arg === '--json') { json = true; continue }
    if (arg === '--no-drift-check') { noDriftCheck = true; continue }
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
    if (arg === '--resolve-all-historic-cancelled') { resolveAllHistoric = true; continue }
    if (arg === '--reason') {
      const raw = (args[index + 1] ?? '').trim()
      if (raw.length < 5 || raw.length > 500 || raw.startsWith('--')) { stderr.error(`--reason needs a sentence (5 to 500 characters). ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      reason = raw
      index += 1
      continue
    }
    if (arg === '--history-days') {
      const raw = args[index + 1]
      if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw)) { stderr.error(`--history-days needs a whole number of days. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      historyDays = Number(raw)
      index += 1
      continue
    }
    if (arg === '--history-since') {
      const raw = args[index + 1]
      if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) { stderr.error(`--history-since needs a date, YYYY-MM-DD. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
      historySince = raw
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

  if (resolveAllHistoric) {
    if (resolveIds !== undefined) { stderr.error(`--resolve-all-historic-cancelled and --resolve are separate decisions: run them one at a time. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
    if (resolveAs !== 'cancelled') { stderr.error(`--resolve-all-historic-cancelled needs --as cancelled. ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
    if (reason === undefined) { stderr.error(`--resolve-all-historic-cancelled needs a --reason (it is recorded in the activity log). ${USAGE}`); return LEGACY_IMPORT_EXIT.usage }
  } else if (reason !== undefined) {
    stderr.error(`--reason belongs to --resolve-all-historic-cancelled. ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  } else if ((resolveIds === undefined) !== (resolveAs === undefined)) {
    stderr.error(`--resolve and --as go together. ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }
  if (historyDays !== undefined && historySince !== undefined) {
    stderr.error(`--history-days and --history-since are alternatives: give one. ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }
  const resolve: LegacyImportOptions['resolve'] = !resolveAllHistoric && resolveIds !== undefined && resolveAs !== undefined ? { wcOrderIds: resolveIds, decision: resolveAs } : undefined
  const resolveAllHistoricCancelled: LegacyImportOptions['resolveAllHistoricCancelled'] = resolveAllHistoric && reason !== undefined ? { reason } : undefined
  const nowDate = (options.now ?? (() => new Date()))()
  const historyWindow: HistoryWindow = historySince !== undefined
    ? { modifiedAfter: `${historySince}T00:00:00.000Z`, days: null, since: historySince }
    : { modifiedAfter: new Date(nowDate.getTime() - (historyDays ?? DEFAULT_HISTORY_DAYS) * 86_400_000).toISOString(), days: historyDays ?? DEFAULT_HISTORY_DAYS, since: null }

  if (apply && !bridgeStopped) {
    stderr.error(`--apply refuses without --bridge-stopped: pass it only once the bridge has stopped creating, merging, verifying and syncing orders (design step 3). ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }

  if (apply && noDriftCheck) {
    stderr.error(`--no-drift-check is for a read-only preview: --apply refuses it (the drift check proves the read skipped no order). ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }

  if (bridgeFenceCleared !== (by !== undefined)) {
    stderr.error(`--bridge-fence-cleared and --by <name> go together (the attestation names who made it). ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }
  if (apply && resolve === undefined && resolveAllHistoricCancelled === undefined && !bridgeFenceCleared) {
    stderr.error(`--apply refuses without --bridge-fence-cleared --by <name>: on the bridge host, resolve and empty var/manual_reconcile.json and clear the intent / intent-unseen entries of var/minted_orders.json first (runbook, step M). ${USAGE}`)
    return LEGACY_IMPORT_EXIT.usage
  }

  try {
    const ports = options.ports
      ? await options.ports({ verifyMintsoft, connector })
      : (await import('@/lib/connectors/mintsoft/legacy-bridge-import/ports')).createLegacyImportPorts({ verifyMintsoft, connector })
    // cancelled and refunded are ALWAYS read: an explicit --statuses never drops them (a queued bridge cancel on one would be invisible).
    const resolvedStatuses = withHistoryStatuses(statuses ?? await (options.defaultStatuses ?? defaultStatuses)())
    const report: LegacyImportReport = await runLegacyBridgeImport(ports, { apply, bridgeStopped, ...(bridgeFenceCleared && by !== undefined ? { bridgeFenceCleared: { by } } : {}), verifyMintsoft, verifyMax, resolve, resolveAllHistoricCancelled, historyWindow, driftCheck: !noDriftCheck, statuses: resolvedStatuses, now: options.now })
    if (json) stdout.log(JSON.stringify(report, null, 2))
    else {
      stdout.log(renderLegacyImportReport(report))
      stdout.log(`Exit code ${report.gate.exitCode}.`)
    }
    return report.gate.exitCode
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return error instanceof DecisionRefusedError ? LEGACY_IMPORT_EXIT.refused : LEGACY_IMPORT_EXIT.failed
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
