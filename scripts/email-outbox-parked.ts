/**
 * o3d-hpeg — list, release or cancel email outbox rows PARKED at the send cap.
 *
 * WHEN YOU NEED THIS. The activity log has an ERROR entry `email_outbox_parked_send_cap` naming an
 * email outbox row. That row's send was claimed, reclaimed once after its holder went stale, and then
 * went stale AGAIN, so the drain has stopped trying: the sender has been entered at least twice for
 * it, and a copy may already have reached the customer. Nothing sends it again until you decide.
 *
 * WHAT TO DO
 *   1. List parked rows (read-only):
 *        tsx scripts/email-outbox-parked.ts
 *   2. For the row, look at your mail server or email provider's log for the recipient and subject
 *      shown, and establish whether a copy went out.
 *   3. Then EITHER release it (it did not go out, or you want it sent anyway — the next drain sends it
 *      once):
 *        tsx scripts/email-outbox-parked.ts --row <id> --release          (dry run: shows what it would do)
 *        tsx scripts/email-outbox-parked.ts --row <id> --release --apply
 *      OR cancel it (it went out, or should not):
 *        tsx scripts/email-outbox-parked.ts --row <id> --cancel --apply
 *
 * Each --apply is one transaction that only changes a row still PARKED_SEND_CAP and writes the
 * activity-log record of the decision with it. See lib/email-outbox-parked.ts.
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported: that module builds its pg Pool from process.env at
// IMPORT time (see scripts/release-accounting-external-id-claim.ts for the same rule).
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const { db } = await import('../lib/db')
  const { listParkedEmails, resolveParkedEmail } = await import('../lib/email-outbox-parked')
  const client = db as unknown as Parameters<typeof listParkedEmails>[0]

  const row = arg('row')
  const release = hasFlag('release')
  const cancel = hasFlag('cancel')

  if (!row) {
    if (release || cancel) throw new Error('--release and --cancel need --row <id>')
    const parked = await listParkedEmails(client)
    if (parked.length === 0) {
      console.log('No email outbox rows are parked at the send cap.')
      return
    }
    for (const email of parked) {
      console.log([
        `${email.id}  ${email.kind}  to ${email.toEmail}`,
        `  subject: ${email.subject}`,
        `  reference: ${email.referenceType ?? '-'} ${email.referenceId ?? ''}`.trimEnd(),
        `  queued ${email.createdAt.toISOString()}, parked ${email.updatedAt.toISOString()}, `
          + `${email.attempts} attempt(s), ${email.staleReclaimCount} reclaim(s)`,
        `  ${email.lastError ?? ''}`,
      ].join('\n'))
    }
    return
  }

  if (release === cancel) throw new Error('say exactly one of --release or --cancel')
  const action = release ? 'release' : 'cancel'

  const [current] = (await listParkedEmails(client)).filter((email) => email.id === row)
  if (!current) {
    console.log(`email_outbox row ${row} is not parked at the send cap; nothing to do.`)
    process.exitCode = 1
    return
  }
  console.log(`${action.toUpperCase()} ${current.id} (${current.kind} to ${current.toEmail}, "${current.subject}")`)
  console.log(action === 'release'
    ? '  -> PENDING, available now: the next drain sends it ONCE.'
    : '  -> FAILED: it will not be sent; the reference is freed for a deliberate re-send.')
  if (!hasFlag('apply')) {
    console.log('Dry run: nothing changed. Re-run with --apply to do it.')
    return
  }

  const operator = process.env.USER ? `operator ${process.env.USER} (scripts/email-outbox-parked.ts)` : 'scripts/email-outbox-parked.ts'
  const outcome = await resolveParkedEmail(client, { id: row, action, operator, now: new Date() })
  if (!outcome.resolved) {
    console.error(outcome.reason)
    process.exitCode = 1
    return
  }
  console.log(`Done: ${row} ${action === 'release' ? 'released' : 'cancelled'}, and recorded in the activity log.`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    const { db } = await import('../lib/db')
    await db.$disconnect()
  })
