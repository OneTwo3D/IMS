import { pathToFileURL } from 'node:url'

import {
  LEGACY_IMPORT_EXIT,
  renderLegacyImportReport,
  runLegacyBridgeImport,
  type LegacyImportPorts,
  type LegacyImportReport,
} from '@/lib/connectors/mintsoft/legacy-bridge-import/run'

/**
 * `npm run cutover:legacy-import [-- --apply] [-- --verify-mintsoft] [-- --statuses a,b] [-- --connector id] [-- --verify-max N] [-- --json]`
 *
 * Imports the legacy bridge's `_mintsoft_*` order state into IMS's own link rows (o3d-zvec.22) and prints the Step M precondition report.
 * DRY RUN BY DEFAULT: nothing is written without --apply. WooCommerce is only ever read (GET). Mintsoft is not called at all unless
 * --verify-mintsoft is given, and then only read. Exit 0: the precondition is met; 1: the run failed; 2: usage; 3: the precondition is
 * not met (an OrderNumber mismatch, a conflict, an unimported order or an open merge item).
 */

const DISCONNECT_TIMEOUT_MS = 5_000
const USAGE = 'Usage: npm run cutover:legacy-import [-- --apply] [-- --verify-mintsoft] [-- --verify-max N] [-- --statuses a,b,c] [-- --connector id] [-- --json]'

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

/** The statuses an open bridge order can be in: the configured pull statuses, on-hold, the bridge's partial-shipped, and the withdrawal-submitted status. */
async function defaultStatuses(): Promise<string[]> {
  const { getWcPullStatuses } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { getWithdrawalStatuses } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  const [pulled, withdrawal] = await Promise.all([getWcPullStatuses('reconcile'), getWithdrawalStatuses()])
  return [...new Set([...pulled, 'processing', 'on-hold', 'partial-shipped', withdrawal.submitted])].filter((s) => s !== '')
}

export async function runLegacyImportCli(options: LegacyImportCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)

  let apply = false
  let verifyMintsoft = false
  let json = false
  let verifyMax: number | undefined
  let connector: string | undefined
  let statuses: string[] | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--apply') { apply = true; continue }
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

  try {
    const ports = options.ports
      ? await options.ports({ verifyMintsoft, connector })
      : (await import('@/lib/connectors/mintsoft/legacy-bridge-import/ports')).createLegacyImportPorts({ verifyMintsoft, connector })
    const resolvedStatuses = statuses ?? await (options.defaultStatuses ?? defaultStatuses)()
    const report: LegacyImportReport = await runLegacyBridgeImport(ports, { apply, verifyMintsoft, verifyMax, statuses: resolvedStatuses, now: options.now })
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
