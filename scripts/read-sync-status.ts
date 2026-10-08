import { pathToFileURL } from 'node:url'

import {
  buildReadSyncStatusReport,
  readSyncStatusExitCode,
  renderReadSyncStatusText,
  type ReadSyncReport,
} from '@/lib/ops/read-sync-status'
import { READ_SYNC_STATUS_COMMAND, READ_SYNC_STATUS_EXIT_CODES } from '@/lib/ops/read-sync-liveness-constants'

/**
 * `npm run read-sync:status [-- --json]`
 *
 * "Is IMS staying current?" Prints, for every read feed, the time of its last SUCCESSFUL run, its age and
 * its limit. Reads the database only; no network, no writes. The exit-code table is defined once in
 * lib/ops/read-sync-liveness-constants.ts (READ_SYNC_STATUS_EXIT_CODES) and rendered into
 * docs/installation.md from there.
 */

const DISCONNECT_TIMEOUT_MS = 5_000

type Logger = Pick<typeof console, 'log' | 'error'>

export type ReadSyncStatusCliOptions = {
  argv?: string[]
  build?: () => Promise<ReadSyncReport>
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
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

const USAGE_EXIT_CODE = READ_SYNC_STATUS_EXIT_CODES.find((row) => row.name === 'usage')!.code
const FAILED_EXIT_CODE = READ_SYNC_STATUS_EXIT_CODES.find((row) => row.name === 'failed')!.code

export async function runReadSyncStatusCli(options: ReadSyncStatusCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)

  const unknown = args.filter((arg) => arg !== '--json')
  if (unknown.length > 0) {
    stderr.error(`Unknown argument(s): ${unknown.join(' ')}. Usage: ${READ_SYNC_STATUS_COMMAND} [-- --json]`)
    return USAGE_EXIT_CODE
  }

  try {
    const report = await (options.build ?? (() => buildReadSyncStatusReport()))()
    const code = readSyncStatusExitCode(report)
    if (args.includes('--json')) {
      stdout.log(JSON.stringify({ ...report, exitCode: code }, null, 2))
    } else {
      stdout.log(renderReadSyncStatusText(report))
      stdout.log(`Exit code ${code}.`)
    }
    return code
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return FAILED_EXIT_CODE
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReadSyncStatusCli()
    .then((code) => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(FAILED_EXIT_CODE)
    })
}
