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
 *
 * The next full-chain run would also self-heal (acquire() recovers a stale lock before
 * doing anything else), but that is no use if nobody runs the suite for a week.
 *
 * If NO lock is held it also reports stage's current connector state, so it doubles as
 * "is stage actually armed right now?".
 */
import { Client } from 'pg'
import { release, status } from '../e2e/full-chain/harness/quiesce.ts'

const STATUS_ONLY = process.argv.includes('--status')

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

  console.log('\nReleasing…')
  await release()
  await reportStage()
  console.log('\nDone. Re-check that stage resumed importing (its wc-reconcile / accounting-sync crons run every 5 min).')
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1) })
