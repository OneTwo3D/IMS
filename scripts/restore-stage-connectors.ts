/**
 * Manual escape hatch for the full-chain quiesce lock (o3d-lgo.3).
 *
 * The lock disables stage's connectors for a run window and restores them after. If a
 * run dies in between — kill -9, a crashed CI box, a dropped SSH session — stage stays
 * disabled: it stops importing Woo orders and stops posting to Xero, silently, until
 * someone notices. This is the "run it and stage comes back" button.
 *
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts --status
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts --force
 *
 * The next full-chain run would also self-heal (acquire() recovers a stale lock before
 * doing anything else), but that is no use if nobody runs the suite for a week.
 *
 * IT REFUSES A LIVE LOCK unless you pass --force. Restoring stage under a running suite
 * puts both systems on the shared Woo store and Xero Demo org at once — the very fault
 * this script exists to fix, inflicted deliberately. A lock whose owner is demonstrably
 * gone is released without ceremony; one that still looks alive, or that cannot be judged,
 * needs you to say so (o3d-lgo.14).
 *
 * If NO lock is held it also reports stage's current connector state, so it doubles as
 * "is stage actually armed right now?".
 */
import { Client } from 'pg'
import { lockRecoveryDecision, release, status } from '../e2e/full-chain/harness/quiesce.ts'

const STATUS_ONLY = process.argv.includes('--status')
const FORCE = process.argv.includes('--force')

const STAGE_KEYS = [
  'wc_sync_enabled',
  'plugin_xero_enabled',
  'xero_sync_enabled',
  'xero_daily_batch_enabled',
  'xero_payment_polling_enabled',
]

async function reportStage() {
  const url = process.env.STAGE_DATABASE_URL
  if (!url) throw new Error('STAGE_DATABASE_URL is not set.')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const r = await db.query<{ key: string; value: string }>(
      `select key, value from settings where key = any($1) order by key`,
      [STAGE_KEYS],
    )
    const found = new Map(r.rows.map((x) => [x.key, x.value]))
    console.log('\nstage connector state:')
    for (const k of STAGE_KEYS) console.log(`  ${k.padEnd(30)} ${found.get(k) ?? '(absent)'}`)
    const allOff = STAGE_KEYS.every((k) => (found.get(k) ?? 'false') === 'false')
    if (allOff) {
      console.warn(
        '\nWARNING: every connector is off. That is expected DURING a run, but if no run is in\n' +
          'flight it means stage is not syncing — orders are not importing and nothing is posting.',
      )
    }
  } finally {
    await db.end()
  }
}

async function main() {
  const lock = await status()
  if (lock) {
    const ageMin = Math.round((Date.now() - Date.parse(lock.takenAt)) / 60000)
    console.log(`Lock HELD by run ${lock.runId}, taken ${lock.takenAt} (${ageMin} min ago)`)
    console.log(`  stage settings recorded: ${Object.entries(lock.stageSettings).map(([k, v]) => `${k}=${v ?? '(absent)'}`).join(', ')}`)
    console.log(`  webhooks created       : ${lock.createdWebhookIds.join(', ') || '(none)'}`)
    console.log(`  owner                  : ${lock.ownerHost ?? '(unrecorded)'} pid ${lock.ownerPid ?? '(unrecorded)'}`)
    console.log(`  lease                  : ${lock.heartbeatAt ? `last renewed ${lock.heartbeatAt}` : '(no heartbeat — pre-lease lock)'}`)
    const decision = lockRecoveryDecision(lock)
    console.log(`  verdict                : ${decision.action.toUpperCase()} — ${decision.reason}`)
    if (ageMin > 120) console.warn('  This lock is over 2h old — almost certainly stale.')
  } else {
    console.log('No lock held.')
  }

  if (STATUS_ONLY) { await reportStage(); return }

  if (!lock) {
    console.log('\nNothing to restore.')
    await reportStage()
    return
  }

  // REFUSE A LIVE LOCK BY DEFAULT. The verdict used to be printed as a warning and then ignored — every
  // non-status invocation forced. An operator following the documented one-liner during a healthy run
  // would re-enable stage under it and put both systems on the shared store and org at once, which is the
  // fault this script exists to fix (Codex, PR #560 round 2). Only a lock whose owner is demonstrably
  // gone is released without being asked twice.
  const verdict = lockRecoveryDecision(lock)
  if (verdict.action !== 'recover' && !FORCE) {
    console.error(
      `\nREFUSING to release: ${verdict.reason}.\n` +
        (verdict.action === 'held'
          ? 'That is a RUNNING suite. Restoring stage now would have it and the rig driving the shared Woo\n' +
            'store and Xero Demo org together. Stop the run first — the lock then recovers by itself.\n'
          : 'The holder cannot be judged from this host (it is another machine, or the lock predates lease\n' +
            'renewal). It auto-recovers once its lease expires; releasing now might land under a live run.\n') +
        '\nIf you KNOW the holder is gone, re-run with --force.',
    )
    await reportStage()
    process.exitCode = 1
    return
  }

  console.log(FORCE && verdict.action !== 'recover' ? '\nReleasing (--force, against the verdict)…' : '\nReleasing…')
  // force: release() is otherwise a no-op for a process that never acquired (o3d-lgo.14), and this script
  // is by definition run by someone who did not take the lock — that is the whole point of an escape hatch.
  await release({ force: true })
  await reportStage()
  console.log('\nDone. Re-check that stage resumed importing (its wc-reconcile / accounting-sync crons run every 5 min).')
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1) })
