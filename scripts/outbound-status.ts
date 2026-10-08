import { pathToFileURL } from 'node:url'

import {
  buildOutboundStatusReport,
  outboundStatusExitCode,
  renderOutboundStatusText,
  type OutboundStatusReport,
} from '@/lib/ops/outbound-status'
import { OUTBOUND_STATUS_COMMAND, OUTBOUND_STATUS_EXIT_CODES } from '@/lib/security/outbound-write-hold-constants'

/**
 * `npm run outbound:status [-- --json] [-- --expect-held]`
 *
 * "Is IMS writing to anything?" Reads the environment and the activity log; no network, no writes.
 * The exit-code table is defined once in lib/security/outbound-write-hold-constants.ts
 * (OUTBOUND_STATUS_EXIT_CODES) and rendered into docs/installation.md from there.
 */

const DISCONNECT_TIMEOUT_MS = 5_000

type Logger = Pick<typeof console, 'log' | 'error'>

export type OutboundStatusCliOptions = {
  argv?: string[]
  build?: () => Promise<OutboundStatusReport>
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

const USAGE_EXIT_CODE = OUTBOUND_STATUS_EXIT_CODES.find((row) => row.name === 'usage')!.code
const FAILED_EXIT_CODE = OUTBOUND_STATUS_EXIT_CODES.find((row) => row.name === 'failed')!.code

export async function runOutboundStatusCli(options: OutboundStatusCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)

  const known = new Set(['--json', '--expect-held'])
  const unknown = args.filter((arg) => !known.has(arg))
  if (unknown.length > 0) {
    stderr.error(`Unknown argument(s): ${unknown.join(' ')}. Usage: ${OUTBOUND_STATUS_COMMAND} [-- --json] [-- --expect-held]`)
    return USAGE_EXIT_CODE
  }

  try {
    const report = await (options.build ?? (() => buildOutboundStatusReport()))()
    const expectHeld = args.includes('--expect-held')
    const code = outboundStatusExitCode(report, { expectHeld })
    if (args.includes('--json')) {
      stdout.log(JSON.stringify({ ...report, exitCode: code }, null, 2))
    } else {
      stdout.log(renderOutboundStatusText(report))
      stdout.log(`Exit code ${code}.`)
    }
    return code
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOutboundStatusCli()
    .then((code) => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(FAILED_EXIT_CODE)
    })
}
