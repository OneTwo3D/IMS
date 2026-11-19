import { pathToFileURL } from 'node:url'

import { listHandBackCandidates, runHandBack, type HandBackDeps, type HandBackCandidate } from '@/lib/connectors/mintsoft/switchover/hand-back'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import { PRODUCER_STEP_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * `npm run switchover:hand-back [-- --since <ISO UTC>] [-- --apply] [-- --json]`  (rollback of step M, see lib/connectors/mintsoft/switchover/hand-back.ts)
 * Writes `_mintsoft_order_id` and `_mintsoft_order_number` onto the open WooCommerce orders IMS created in Mintsoft, so the resumed bridge adopts them.
 * DRY RUN by default: it reads and reports, writes nothing. `--apply` writes. S is MINTSOFT_WRITES_LIVE_FROM unless --since is given.
 * Exit codes: 0 done, 1 something needs a person (a conflict, an unreadable or held order, a failed write), 3 usage, 4 preflight refused, 5 failed.
 *
 * ORDER (rollback of step M): HAND BACK FIRST, THEN UNSET. The hand-back writes through the ordinary WooCommerce write path, which the producer-side hold keeps
 * unless step M's live-from is set and reached; the hold is deliberately NOT loosened for it (no special mode that normal writers could share). So `--apply`
 * is refused unless (1) MINTSOFT_WRITES_LIVE_FROM is set in the environment and has been reached (a `--since` does not count: it would leave the hold shut and
 * every write `held`), and (2) the operator states with `--writers-stopped` that IMS's other step-M writers (the push sweeps, the completion and tracking
 * jobs, the withdrawal-outcome writer) are stopped, so unsetting the live-from afterwards re-arms nothing. Only after it ends clean are the live-from and
 * the grant unset and the bridge resumed. An applied run leaves an audit entry (`switchover_hand_back_applied`).
 */
export type HandBackCliOptions = {
  argv?: string[]
  env?: Record<string, string | undefined>
  load?: (since: Date) => Promise<{ candidates: HandBackCandidate[]; deps: HandBackDeps }>
  stdout?: Pick<typeof console, 'log'>
  stderr?: Pick<typeof console, 'error'>
  disconnect?: () => Promise<void>
  /** Test seam: the audit entry of an applied run. Absent = the activity log. */
  audit?: (entry: AuditEntry) => Promise<void>
  now?: () => Date
}

async function liveLoad(since: Date): Promise<{ candidates: HandBackCandidate[]; deps: HandBackDeps }> {
  const { db } = await import('@/lib/db')
  const { wcFetch, wcPut } = await import('@/lib/connectors/woocommerce/api')
  return {
    candidates: await listHandBackCandidates({ since, db: db as never }),
    deps: {
      readOrder: async (id) => {
        const result = await wcFetch(`/orders/${id}`, { _fields: 'id,status,meta_data' })
        const data = result.data as { status?: unknown; meta_data?: Array<{ key?: unknown; value?: unknown }> } | null
        if (result.error || !data || typeof data.status !== 'string') return null
        const metas: Record<string, string | null> = {}
        for (const meta of data.meta_data ?? []) if (typeof meta.key === 'string') metas[meta.key] = meta.value === null || meta.value === undefined ? null : String(meta.value)
        return { status: data.status, metas }
      },
      writeMetas: async (id, metas) => {
        const result = await wcPut(`/orders/${id}`, { meta_data: Object.entries(metas).map(([key, value]) => ({ key, value })) })
        return { ok: !result.error, held: result.held }
      },
    },
  }
}

type AuditEntry = { phase: 'intent' | 'completed'; since: string; candidates: number; counts?: Record<string, number> }

/** Two rows per applied run: the INTENT is written before any storefront write, the completion (with the counts) after it. */
async function auditApplied(entry: AuditEntry): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM', entityId: 'switchover-hand-back',
    action: entry.phase === 'intent' ? 'switchover_hand_back_intent' : 'switchover_hand_back_applied', tag: 'sync', level: 'WARNING',
    description: entry.phase === 'intent' ? `Switchover hand-back about to write ${entry.candidates} open order(s) since ${entry.since}.` : `Switchover hand-back applied for ${entry.candidates} open order(s) since ${entry.since}.`,
    metadata: entry, resolveUser: false,
  })
}

export async function runHandBackCli(options: HandBackCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const usage = 'Usage: npm run switchover:hand-back [-- --since <ISO UTC>] [-- --apply --writers-stopped] [-- --json]'
  let since: string | undefined
  let apply = false
  let writersStopped = false
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--apply') apply = true
    else if (arg === '--writers-stopped') writersStopped = true
    else if (arg === '--json') json = true
    else if (arg === '--since') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(usage); return 3 }
      since = value
      i += 1
    } else { stderr.error(`Unknown argument ${arg}. ${usage}`); return 3 }
  }
  const cutoff = parseProducerCutoff(since ?? env[PRODUCER_STEP_ENV.mintsoft])
  if (!cutoff.ok) { stderr.error(`S is not readable (${PRODUCER_STEP_ENV.mintsoft} or --since must be an ISO UTC instant).`); return 3 }
  if (apply) {
    // PREFLIGHT: the exact order, enforced. The hold is not weakened; the script refuses to run in the wrong state.
    const live = parseProducerCutoff(env[PRODUCER_STEP_ENV.mintsoft])
    if (since !== undefined || !live.ok || live.at.getTime() > (options.now ?? (() => new Date()))().getTime()) {
      stderr.error(`Refused: --apply must run while ${PRODUCER_STEP_ENV.mintsoft} is still set (from the environment, not --since) and reached. Hand back FIRST, then unset the live-from and the grant. Unsetting first leaves every write held.`)
      return 4
    }
    if (!writersStopped) {
      stderr.error('Refused: pass --writers-stopped to confirm IMS\'s other step-M writers (push sweeps, completion and tracking jobs, withdrawal-outcome) are stopped. Unsetting the live-from afterwards must re-arm nothing.')
      return 4
    }
  }
  try {
    const { candidates, deps } = await (options.load ?? liveLoad)(cutoff.at)
    const audit = options.audit ?? auditApplied
    // The audit row comes BEFORE the writes: if it cannot be written nothing is written, and a crash after the writes still leaves the intent on record.
    if (apply) await audit({ phase: 'intent', since: cutoff.at.toISOString(), candidates: candidates.length })
    const { counts, results } = await runHandBack(candidates, apply, deps)
    if (apply) {
      // The writes are done: a failing completion row is reported, never turned into a "failed" run that hides the counts.
      await audit({ phase: 'completed', since: cutoff.at.toISOString(), candidates: candidates.length, counts: { ...counts } })
        .catch((error: unknown) => { stderr.error(`The hand-back was applied but its completion audit row could not be written (${error instanceof Error ? error.message : String(error)}); the intent row is on record. Counts: ${JSON.stringify(counts)}`) })
    }
    if (json) stdout.log(JSON.stringify({ apply, since: cutoff.at.toISOString(), candidates: candidates.length, counts, results }, null, 2))
    else {
      stdout.log(`${apply ? 'APPLY' : 'DRY RUN'}: hand-back of ${candidates.length} open order(s) IMS created since ${cutoff.at.toISOString()}`)
      for (const [name, count] of Object.entries(counts)) if (count > 0) stdout.log(`  ${name}: ${count}`)
      for (const r of results) if (!['written', 'would-write', 'already-set', 'closed'].includes(r.outcome)) stdout.log(`  needs a person: ${r.reference} (${r.outcome})`)
      if (counts.held > 0) stdout.log('  The producer-side hold kept the write: unset nothing before the hand-back: re-set the live-from and run it again with --writers-stopped.')
    }
    return counts.conflict + counts.unreadable + counts.held + counts.failed > 0 ? 1 : 0
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return 5
  } finally {
    await (options.disconnect ?? (async () => { const { db } = await import('@/lib/db'); await db.$disconnect() }))().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHandBackCli().then((code) => { process.exit(code) }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(5) })
}
