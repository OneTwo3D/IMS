import { pathToFileURL } from 'node:url'

import {
  applyHeldBacklogRetirement,
  effectiveRetirementCutoff,
  planHeldBacklogRetirement,
  resolveRetirementCutoffs,
  RETIREMENT_DEFAULT_LIMIT,
  type RetirementApplyResult,
  type RetirementPlan,
  type RetirementScope,
} from '@/lib/domain/outbound-shadow/retire-held-backlog'
import { OUTBOUND_CONNECTORS, type OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import { RETIRE_HELD_BACKLOG_COMMAND, RETIRE_HELD_BACKLOG_EXIT_CODES } from '@/lib/security/producer-disposition-constants'

/**
 * `npm run retire:held-backlog [-- --destination xero|mintsoft|woocommerce|all] [-- --cutoff <ISO-8601 UTC with Z>]
 *    [-- --all-queued] [-- --limit N] [-- --json] [-- --apply --confirm-database <name>]`
 *
 * DRY RUN BY DEFAULT: it reads the queues and prints what each queued row would become, changing nothing. `--apply` writes, and is for a
 * scratch or development database run by the coordinator; it is never run against a live installation. It will not run unless
 * `--confirm-database` names the database it is connected to, the way the scratch-database stamp does, so a wrong DATABASE_URL does not
 * apply anything by accident.
 *
 * Which rows: those queued BEFORE a destination's cut-off (`--cutoff` for all selected destinations, otherwise that destination's own
 * live-from variable when it is readable), or every queued row with `--all-queued`. What happens to them, and the proof that decides it,
 * is lib/domain/outbound-shadow/retire-held-backlog.ts. The exit codes are in RETIRE_HELD_BACKLOG_EXIT_CODES, documented once.
 */

type Logger = Pick<typeof console, 'log' | 'error'>

export type RetireCliOptions = {
  argv?: string[]
  env?: Record<string, string | undefined>
  plan?: (scope: RetirementScope) => Promise<RetirementPlan>
  apply?: (plan: RetirementPlan, scope: RetirementScope) => Promise<RetirementApplyResult>
  currentDatabase?: () => Promise<string>
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
}

const exit = (name: string): number => {
  const found = RETIRE_HELD_BACKLOG_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`retire exit code ${name} is not in the table`)
  return found.code
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function defaultCurrentDatabase(): Promise<string> {
  const { db } = await import('@/lib/db')
  const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`
  return rows[0]?.name ?? ''
}

async function disconnectDb(): Promise<void> {
  const { db } = await import('@/lib/db')
  await Promise.race([db.$disconnect(), new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())])
}

export async function runRetireHeldBacklogCli(options: RetireCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const usage = `Usage: ${RETIRE_HELD_BACKLOG_COMMAND} [-- --destination xero|mintsoft|woocommerce|all] [-- --cutoff <ISO-8601 UTC with Z>] [-- --all-queued] [-- --limit N] [-- --json] [-- --apply --confirm-database <name>]`

  const valued = new Set(['--destination', '--cutoff', '--limit', '--confirm-database'])
  const bare = new Set(['--all-queued', '--json', '--apply'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (valued.has(arg)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(`${arg} needs a value. ${usage}`); return exit('usage') }
      index += 1
      continue
    }
    if (!bare.has(arg)) { stderr.error(`Unknown argument: ${arg}. ${usage}`); return exit('usage') }
  }

  const destinationArg = valueOf(args, '--destination') ?? 'all'
  let destinations: OutboundConnector[]
  if (destinationArg === 'all') destinations = [...OUTBOUND_CONNECTORS]
  else if ((OUTBOUND_CONNECTORS as readonly string[]).includes(destinationArg)) destinations = [destinationArg as OutboundConnector]
  else { stderr.error(`Unknown destination ${destinationArg}. ${usage}`); return exit('usage') }

  const cutoffArg = valueOf(args, '--cutoff')
  const explicit: Partial<Record<OutboundConnector, Date>> = {}
  if (cutoffArg !== undefined) {
    const parsed = parseProducerCutoff(cutoffArg)
    if (!parsed.ok) { stderr.error(`--cutoff must be one UTC instant in ISO-8601 with an explicit Z. ${usage}`); return exit('usage') }
    for (const destination of destinations) explicit[destination] = parsed.at
  }

  const limitArg = valueOf(args, '--limit')
  const limit = limitArg === undefined ? RETIREMENT_DEFAULT_LIMIT : Number(limitArg)
  if (!Number.isInteger(limit) || limit < 1) { stderr.error(`--limit must be a whole number of at least 1. ${usage}`); return exit('usage') }

  const apply = args.includes('--apply')
  const confirm = valueOf(args, '--confirm-database')
  if (apply && confirm === undefined) { stderr.error(`--apply needs --confirm-database naming the database to change. ${usage}`); return exit('usage') }
  if (!apply && confirm !== undefined) { stderr.error(`--confirm-database is only meaningful with --apply. ${usage}`); return exit('usage') }

  const scope: RetirementScope = { destinations, cutoffs: resolveRetirementCutoffs(explicit, env), allQueued: args.includes('--all-queued'), limit }
  try {
    if (apply) {
      const database = await (options.currentDatabase ?? defaultCurrentDatabase)()
      if (confirm !== database) {
        stderr.error(`REFUSING to apply: --confirm-database ${JSON.stringify(confirm)} is not the database this command is connected to. Nothing was changed.`)
        return exit('apply-refused')
      }
    }

    const plan = await (options.plan ?? ((s) => planHeldBacklogRetirement(s)))(scope)
    const result = apply ? await (options.apply ?? ((p, s) => applyHeldBacklogRetirement(p, s)))(plan, scope) : null

    const tally = new Map<string, number>()
    for (const item of plan.items) {
      const key = `${item.destination} ${item.kind} ${item.classification.disposition}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    if (args.includes('--json')) {
      stdout.log(JSON.stringify({
        mode: apply ? 'apply' : 'dry-run',
        generatedAt: plan.generatedAt.toISOString(),
        cutoffs: Object.fromEntries(destinations.map((d) => [d, effectiveRetirementCutoff(scope, d)?.toISOString() ?? null])),
        configuredCutoffsIgnored: scope.allQueued && Object.keys(scope.cutoffs).length > 0,
        allQueued: scope.allQueued,
        unscoped: plan.unscoped,
        truncated: plan.truncated,
        tally: Object.fromEntries(tally),
        items: plan.items.map((item) => ({
          destination: item.destination, kind: item.kind, id: item.id, subject: item.subject, status: item.status,
          createdAt: item.createdAt.toISOString(), disposition: item.classification.disposition, reason: item.classification.reason,
        })),
        ...(result ? { applied: result.counts, outcomes: result.outcomes.map((o) => ({ id: o.item.id, kind: o.item.kind, result: o.result, detail: o.detail })) } : {}),
      }, null, 2))
    } else {
      stdout.log(apply ? 'APPLY (rows are changed, one transaction each)' : 'DRY RUN (nothing is changed)')
      for (const destination of destinations) {
        const cutoff = effectiveRetirementCutoff(scope, destination)
        stdout.log(`${destination}: ${scope.allQueued ? `every queued row (--all-queued; ${scope.cutoffs[destination] ? `the configured cut-off ${scope.cutoffs[destination]!.toISOString()} is ignored` : 'no cut-off applies'})` : cutoff ? `queued before ${cutoff.toISOString()}` : 'no cut-off given or readable: nothing selected'}`)
      }
      for (const [key, count] of [...tally.entries()].sort()) stdout.log(`  ${key}: ${count}`)
      for (const item of plan.items) {
        stdout.log(`  ${item.classification.disposition.padEnd(6)} ${item.destination} ${item.kind} ${item.id} (${item.subject}, ${item.status}, queued ${item.createdAt.toISOString()}): ${item.classification.reason}`)
      }
      for (const cut of plan.truncated) stdout.log(`  TRUNCATED: more ${cut.kind} rows for ${cut.destination} than --limit ${limit}; run it again`)
      if (result) stdout.log(`Applied: ${JSON.stringify(result.counts)}`)
    }

    if (plan.items.length === 0 && plan.unscoped.length === destinations.length) return exit('nothing-in-scope')
    const incomplete = plan.truncated.length > 0
      || (result !== null && (result.counts.changed_since_plan > 0 || result.counts.left_alone > 0))
    return incomplete ? exit('incomplete') : exit('ok')
  } finally {
    await (options.disconnect ?? disconnectDb)().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRetireHeldBacklogCli()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(exit('failed'))
    })
}
