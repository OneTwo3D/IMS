import { pathToFileURL } from 'node:url'

import { buildWritersCheckReport, renderWritersCheckText, type WritersCheckReport } from '@/lib/ops/writers-check'
import {
  WRITERS_CHECK_COMMAND,
  WRITERS_CHECK_DEFAULT_WINDOW_DAYS,
  WRITERS_CHECK_EXIT_CODES,
  WRITERS_CHECK_MAX_WINDOW_DAYS,
} from '@/lib/security/writers-check-constants'

/**
 * `npm run writers:check [-- --window-days N] [-- --json]`
 *
 * The coexistence interlock. Read-only: the environment and IMS's own database, no vendor call, no write. Exits non-zero
 * unless it found no double claim in the evidence IMS holds. The exit-code table is defined once in
 * lib/security/writers-check-constants.ts and rendered into docs/installation.md from there.
 */

const DISCONNECT_TIMEOUT_MS = 5_000
const exitOf = (name: string) => WRITERS_CHECK_EXIT_CODES.find((row) => row.name === name)!.code

type Logger = Pick<typeof console, 'log' | 'error'>

export type WritersCheckCliOptions = {
  argv?: string[]
  build?: (input: { windowDays: number }) => Promise<WritersCheckReport>
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

/** The window argument: a whole number of days from 1 to the maximum, and nothing else. */
export function parseWindowDays(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 && value <= WRITERS_CHECK_MAX_WINDOW_DAYS ? value : null
}

export async function runWritersCheckCli(options: WritersCheckCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const usage = `Usage: ${WRITERS_CHECK_COMMAND} [-- --window-days N (1-${WRITERS_CHECK_MAX_WINDOW_DAYS}, default ${WRITERS_CHECK_DEFAULT_WINDOW_DAYS})] [-- --json]`

  let json = false
  let windowDays = WRITERS_CHECK_DEFAULT_WINDOW_DAYS
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--window-days') {
      const parsed = parseWindowDays(args[index + 1])
      if (parsed === null) { stderr.error(`--window-days needs a whole number of days. ${usage}`); return exitOf('usage') }
      windowDays = parsed
      index += 1
      continue
    }
    stderr.error(`Unknown argument ${arg}. ${usage}`)
    return exitOf('usage')
  }

  try {
    const report = await (options.build ?? ((input) => buildWritersCheckReport(input)))({ windowDays })
    if (json) stdout.log(JSON.stringify(report, null, 2))
    else {
      stdout.log(renderWritersCheckText(report))
      stdout.log(`Exit code ${report.exitCode}.`)
    }
    return report.exitCode
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return exitOf('failed')
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWritersCheckCli()
    .then((code) => { process.exit(code) })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(exitOf('failed'))
    })
}
