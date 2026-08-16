/**
 * o3d-9kek r7 finding 1 — THE ROUTE FORWARD for a posted accounting document whose local
 * back-reference the unique index refused.
 *
 * WHEN YOU NEED THIS. A document posted successfully to the accounting ledger, and the write of its
 * external id onto the local record was rejected because another local record of the SAME TYPE
 * already holds that id. The commonest cause is a QuickBooks realm switch: company B reissues an
 * integer a retired company A's bill still carries. You will have seen a
 * `quickbooks_backreference_id_conflict` activity entry, and the sync row itself carries the same
 * text in `errorMessage` while staying SYNCED.
 *
 * WHY IT CANNOT BE DONE BY HAND, and why it is not automatic either. "Link the document by hand" is
 * not a remedy: the same unique index refuses a manual link for exactly the same reason. And nothing
 * in the database distinguishes a retired realm's stale id from a live, correct link — none of the
 * four holder models has a provenance column for the accounting id (that is o3d-gt8r/o3d-s36z). So
 * the decision is a human's, and this script exists to carry it out safely once it is made.
 *
 * WHAT AN OPERATOR ACTUALLY DOES
 *
 *   1. Read the activity entry (or the sync row's errorMessage). It names the BLOCKING record —
 *      model and id — and this command with both ids already filled in.
 *   2. Open that blocking record in IMS and confirm it is stale: it belongs to a QuickBooks company
 *      this system is no longer connected to, or to a ledger document that no longer exists.
 *      IF IT IS A LIVE, CORRECTLY LINKED DOCUMENT, STOP — releasing it detaches a good link, and
 *      that is strictly worse than the refusal you started with.
 *   3. Dry-run, which reads and reports and writes nothing:
 *        tsx scripts/release-accounting-external-id-claim.ts --sync-log <id> --holder <id>
 *   4. Re-run with --apply. The claim is cleared from the blocking record and the external id is
 *      written onto the document that actually posted it, in one step. Both halves are logged.
 *
 * The release and the re-link are ONE operation on purpose. Clearing the id and stopping leaves the
 * ledger document attached to nothing at all — for QuickBooks, permanently, because no repair sweep
 * runs there. Whoever takes an id off one document must put it on the other in the same breath.
 *
 * The clear is conditional on the named record still holding exactly that id, and the re-link is the
 * ordinary applyBackReference, so a PO-keyed row is still re-resolved under its advisory lock and
 * can still refuse. Nothing here bypasses a guard; it only removes the ONE obstacle a human has
 * confirmed is stale.
 */
import { config } from 'dotenv'

import {
  backReferenceHolder,
  findExternalDocumentIdClaim,
  releaseAndRelinkExternalDocumentId,
} from '../lib/domain/accounting/back-reference'

// .env MUST load before lib/db is imported: that module builds its pg Pool from
// process.env.DATABASE_URL at IMPORT time, so a static import would construct a pool with no
// connection string and fail with an opaque SASL "client password must be a string".
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
  // Arguments FIRST, database second: importing lib/db constructs a pg Pool from the environment, so
  // a mistyped invocation would otherwise fail with a connection error instead of the usage line.
  const syncLogId = arg('sync-log')
  const confirmedHolderId = arg('holder')
  const apply = hasFlag('apply')
  if (!syncLogId || !confirmedHolderId) {
    throw new Error('Usage: tsx scripts/release-accounting-external-id-claim.ts --sync-log <id> --holder <id> [--apply]')
  }

  const { db } = await import('../lib/db/index')
  const { logActivity } = await import('../lib/activity-log')

  const row = await db.accountingSyncLog.findUnique({
    where: { id: syncLogId },
    select: { id: true, connector: true, type: true, referenceType: true, referenceId: true, externalTransactionId: true, status: true },
  })
  if (!row) throw new Error(`No accounting sync row ${syncLogId}`)
  if (!row.externalTransactionId) {
    throw new Error(`Sync row ${syncLogId} carries no external id — nothing posted, so there is no claim to release`)
  }
  const holder = backReferenceHolder(row.type, row.referenceType)
  if (!holder) {
    throw new Error(`Sync row ${syncLogId} (${row.type}/${row.referenceType}) does not write a back-reference at all`)
  }

  const params = {
    connector: row.connector,
    type: row.type,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalId: row.externalTransactionId,
  }

  console.log(`sync row:        ${row.id} (${row.connector} ${row.type} ${row.referenceType} ${row.referenceId}, ${row.status})`)
  console.log(`external id:     ${row.externalTransactionId}`)
  console.log(`holder model:    ${holder.model}.${holder.column}`)

  // Read the CURRENT holder before doing anything, so a dry run reports the same decision the
  // apply will make — and so a stale --holder from an old activity entry is caught here rather
  // than clearing a record nobody confirmed.
  const claim = await findExternalDocumentIdClaim(db, { holder, externalId: row.externalTransactionId })
  console.log(`current holder:  ${claim ? `${holder.model} ${claim.id}` : '(none — nothing is blocking)'}`)
  console.log(`you confirmed:   ${holder.model} ${confirmedHolderId}`)

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once you have confirmed the holder above is stale.')
    return
  }

  const result = await releaseAndRelinkExternalDocumentId(db, { ...params, confirmedHolderId })
  console.log(`\noutcome: ${result.outcome}`)

  switch (result.outcome) {
    case 'relinked':
      console.log(`released ${holder.model} ${result.releasedFrom}; linked ${result.appliedTo.referenceType} ${result.appliedTo.referenceId}`)
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_external_id_claim_released',
        tag: 'sync',
        level: 'WARNING',
        description: `Operator released the ${row.connector} external id ${row.externalTransactionId} from ${holder.model} `
          + `${result.releasedFrom} and linked it to ${result.appliedTo.referenceType} ${result.appliedTo.referenceId}. `
          + `${holder.model} ${result.releasedFrom} now has NO ${holder.column} — if that was not a retired-realm document, `
          + 'this needs reversing by hand.',
        metadata: {
          syncLogId: row.id,
          connector: row.connector,
          externalId: row.externalTransactionId,
          releasedModel: holder.model,
          releasedFrom: result.releasedFrom,
          appliedTo: result.appliedTo,
        },
      })
      // The conflict is resolved, so the quarantine text must not outlive it — a stale errorMessage
      // on a SYNCED row is exactly the marker something else may act on later.
      await db.accountingSyncLog.update({ where: { id: row.id }, data: { errorMessage: null } })
      break
    case 'holder-mismatch':
      console.error(`REFUSED: ${holder.model} ${result.currentHolderId} holds the id, not the ${confirmedHolderId} you confirmed.`)
      console.error('Nothing was written. Re-check the blocking record and confirm THAT one.')
      process.exitCode = 1
      break
    case 'no-claim':
      console.log('Nothing holds this id any more, so nothing is blocking the write. Re-run the connector sync instead.')
      break
    case 'already-correct':
      console.log('The id is already on the document this sync row names. Nothing to do.')
      break
    case 'contended':
      console.error(`REFUSED: ${holder.model} ${result.holderId} stopped holding the id between the read and the write. Nothing was written.`)
      process.exitCode = 1
      break
    case 'released-not-applied':
      // The dangerous half-state, and it must be shouted about: the id is now owned by nobody.
      console.error(`RELEASED ${holder.model} ${result.releasedFrom}, but the re-link did NOT land (${result.applyOutcome}).`)
      console.error('The external id is currently held by NO local record. Resolve this now — re-run once the apply outcome above is understood.')
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_external_id_claim_release_incomplete',
        tag: 'sync',
        level: 'ERROR',
        description: `Released the ${row.connector} external id ${row.externalTransactionId} from ${holder.model} ${result.releasedFrom}, `
          + `but could not link it to ${row.referenceType} ${row.referenceId} (${result.applyOutcome}). The ledger document is now `
          + 'linked to NOTHING locally.',
        metadata: {
          syncLogId: row.id,
          connector: row.connector,
          externalId: row.externalTransactionId,
          releasedModel: holder.model,
          releasedFrom: result.releasedFrom,
          applyOutcome: result.applyOutcome,
        },
      })
      process.exitCode = 1
      break
    case 'not-applicable':
      console.error('This sync row does not write a back-reference.')
      process.exitCode = 1
      break
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
