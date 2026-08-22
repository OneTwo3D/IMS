/**
 * o3d-9kek r7 finding 1 — THE ROUTE FORWARD for a posted accounting document whose local
 * back-reference the unique index refused.
 *
 * WHEN YOU NEED THIS. A document posted successfully to the accounting ledger, and the write of its
 * external id onto the local record was rejected because another local record of the SAME TYPE
 * already holds that id. The commonest cause is a QuickBooks realm switch: company B reissues an
 * integer a retired company A's bill still carries.
 *
 * WHAT THE ROW LOOKS LIKE depends on the connector, and both are handled:
 *   • QUICKBOOKS quarantines it — a `quickbooks_backreference_id_conflict` activity entry, and the
 *     sync row keeps `status = SYNCED` with the same text in `errorMessage`. It is left SYNCED on
 *     purpose: a row out of SYNCED stops suppressing its own re-enqueue and the document posts twice.
 *   • XERO does not quarantine — the refusal propagates, the row retries, and after the last retry
 *     it lands on `status = FAILED` with the refusal text in `errorMessage`. It still carries the
 *     external id, which is written before the back-reference is ever attempted. A FAILED row is
 *     therefore the NORMAL shape of a Xero conflict, not a broken one.
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
 *   4. Re-run with --apply. The claim is cleared from the blocking record, the external id is written
 *      onto the document that actually posted it, and the activity-log record of the whole thing is
 *      written — all in ONE TRANSACTION, so either every part of it happened or none of it did.
 *
 * The release, the re-link AND THE AUDIT ENTRY are one atomic unit on purpose (r8 finding 1, r9
 * finding 3 — the audit used to be written afterwards through a logger that swallows its own write
 * failures, so a completed release could leave no durable record that anyone had ever run this).
 * Clearing the id and
 * stopping leaves the ledger document attached to nothing at all — for QuickBooks, permanently,
 * because no repair sweep runs there — and it is not recoverable by re-running, because the holder
 * no longer holds the id and your confirmation stops matching anything. So anything short of a
 * completed re-link rolls the release back, and the recovery procedure for ANY failure of this
 * command — including a crash or a lost connection mid-way — is to run it again.
 *
 * Every fact it acts on is re-verified inside that transaction, against the state at write time
 * rather than the state you read: the sync row must still be the row you named (same external id,
 * same document, still repairable, still carrying the conflict marker), the blocking record must
 * still be the one you confirmed and must still hold exactly that id, and the destination must still
 * LACK a back-reference — a destination that has acquired a newer, valid id in the meantime is
 * refused, never overwritten. Nothing here bypasses a guard; it only removes the ONE obstacle a
 * human has confirmed is stale.
 */
import { config } from 'dotenv'

import {
  BACK_REFERENCE_REPAIRABLE_STATUSES,
  backReferenceHolder,
  backReferenceIsMissing,
  findExternalDocumentIdClaim,
  recoverPostedBusinessDate,
  releaseAndRelinkExternalDocumentId,
  type ExternalDocumentIdReleaseRecorder,
} from '../lib/domain/accounting/back-reference'
import { isOperatorAssertedSettlement } from '../lib/domain/accounting/sync-row-settlement'

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
  // The REDACTORS, not the writer (r9 finding 3). logActivity/logActivityPersisted write through the
  // global `db`, so an entry made by them could not join the release's transaction — and logActivity
  // additionally swallows its own persistence errors, which is how a destructive release could
  // complete with no durable record that it happened. The audit row is written by the release itself,
  // on its own transaction, and these two are the sanitising the activity log would otherwise have
  // applied.
  const { redactActivityLogText, sanitizeActivityLogMetadata } = await import('../lib/activity-log')

  const row = await db.accountingSyncLog.findUnique({
    where: { id: syncLogId },
    select: {
      id: true, connector: true, type: true, referenceType: true, referenceId: true,
      externalTransactionId: true, status: true, errorMessage: true,
      backReferenceAmbiguousLoggedAt: true, backReferenceEvidenceCompactedAt: true,
      // o3d-anu8: read so the DRY RUN can refuse an operator-asserted row. The transaction re-reads
      // it and refuses too — that is the check that counts — but a dry run that printed
      // "conflict marker: errorMessage on the sync row" and then invited --apply is how an operator
      // is walked into destroying a real link.
      settlementBasis: true,
      // o3d-r5pj: read for ONE thing — the business date the document was posted with, so this
      // relink reproduces it instead of re-dating the sale to whenever an operator ran the command.
      payload: true,
    },
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
    // A RELINK IS A REPAIR, and a repair must not invent a business date (o3d-r5pj). Passed
    // explicitly — as the posted date when the payload still records it and as `null` when it does
    // not (a retention tombstone's payload is `{}`) — because OMITTING it is what selects
    // applyBackReference's live-path default of `new Date()`. That default would stamp the sale with
    // the date somebody happened to run this command, moving it into that VAT period; writing
    // nothing leaves whatever invoice date the order already had, which on this path is the date its
    // invoice number was generated with.
    invoicedAt: recoverPostedBusinessDate((row.payload ?? {}) as Record<string, unknown>),
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

  // ALREADY DONE is answered before anything is refused. A successful --apply clears the sync row's
  // quarantine text, so re-running the exact same command would otherwise be met with the
  // no-conflict-marker refusal below — a refusal that writes nothing, but that reads as "you have
  // the wrong row" when the truth is "this is already finished".
  if (claim && claim.id === row.referenceId && row.referenceType === holder.model) {
    console.log(`\nThe id is already on ${row.referenceType} ${row.referenceId}. Nothing to release, nothing to do.`)
    return
  }

  // THE ROW MUST STILL BE A REPAIRABLE ONE (r8 finding 2). Re-checked inside the transaction too —
  // that is the check that counts — but refused here as well so a mistyped or stale --sync-log is
  // named by the DRY RUN, before an operator has been told to re-run with --apply.
  //
  // SYNCED **or** FAILED, from the one shared definition the repair sweep and data retention read.
  // Restating it as "SYNCED only" here would have refused every Xero conflict there is, since Xero
  // never quarantines and its refusals exhaust their retries to FAILED — the tool would have been
  // sound and useless. PENDING/PROCESSING means a sync is in flight that may post again under a
  // different id; CANCELLED means the row was deliberately abandoned.
  if (!BACK_REFERENCE_REPAIRABLE_STATUSES.includes(row.status)) {
    throw new Error(
      `Sync row ${syncLogId} is ${row.status}, which is not a repairable status `
      + `(${BACK_REFERENCE_REPAIRABLE_STATUSES.join(' or ')}). PENDING/PROCESSING means a sync is in flight that may post again `
      + 'under a different id, and CANCELLED means this row was deliberately abandoned — releasing another record\'s claim on '
      + 'its behalf would be a guess either way.',
    )
  }
  // The row must carry SOME durable record that its back-reference was refused. Four things count,
  // and the fourth is the retention tombstone: compaction NULLS errorMessage, and for a QuickBooks
  // conflict (no repair sweep, so no deferred-refusal stamp either) that would otherwise erase the
  // last marker and close this route for good at the retention horizon.
  // AN OPERATOR-SETTLED ROW HAS NO CONFLICT TO RESOLVE (o3d-anu8). Refused before the marker is
  // even computed, because on such a row the marker IS the settlement note: `buildSettlementData`
  // writes "Settled by operator: verified POSTED as <id>." into errorMessage, which the first branch
  // below reports as durable evidence that a back-reference was refused. It is nothing of the kind,
  // and the operation it authorises NULLs a genuinely posted document's id and its provenance.
  if (isOperatorAssertedSettlement(row.settlementBasis)) {
    throw new Error(
      `Sync row ${syncLogId} was SETTLED BY AN OPERATOR, not written back by ${row.connector}. Its status and its external `
      + `id (${row.externalTransactionId}) are a human's assertion that IMS verified nothing about — no call was made and no `
      + 'document was read — and the only "conflict evidence" on it is the note the settlement itself wrote into errorMessage. '
      + 'Releasing another record\'s claim on the strength of that would clear a genuinely posted document\'s link and its '
      + 'provenance, after which nothing in IMS names that ledger document at all. Establish from the ACCOUNTING SYSTEM which '
      + 'document holds this id before releasing anything.',
    )
  }
  const marker = row.errorMessage ? 'errorMessage on the sync row'
    : row.backReferenceAmbiguousLoggedAt ? 'deferred-refusal stamp from the repair sweep'
    : row.backReferenceEvidenceCompactedAt ? 'retention tombstone (payload and error text compacted away; attribution kept)'
    : null
  if (!marker) {
    throw new Error(
      `Sync row ${syncLogId} carries no record of a refused back-reference (no errorMessage, no deferred-refusal stamp, no `
      + 'retention tombstone). Nothing here is evidence that this id was ever blocked, so there is nothing to release — find the '
      + 'row the conflict was actually reported on.',
    )
  }
  console.log(`conflict marker: ${marker}`)
  // And the DESTINATION, which is the half a dry run used to say nothing about: a document that has
  // since acquired its own back-reference does not need this one, and the apply will refuse rather
  // than overwrite it (r8 finding 2). Better to see that here than to be told it after --apply.
  const destinationNeedsLink = await backReferenceIsMissing(db, params)
  console.log(`destination:     ${row.referenceType} ${row.referenceId} — `
    + (destinationNeedsLink ? 'still unlinked' : 'ALREADY LINKED or gone; --apply will refuse'))

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once you have confirmed the holder above is stale.')
    return
  }

  /**
   * THE AUDIT ROW, written on the release's own transaction (r9 finding 3).
   *
   * This is the only operation in IMS that deliberately clears a live accounting link, and the
   * previous version wrote this entry AFTER the transaction committed, through `logActivity` — which
   * deliberately swallows database errors and returns void. A successful release could therefore
   * leave the holder detached, the destination linked, and no durable record anywhere that anyone had
   * done it. Re-running did not recover the record either: the second run answers `already-correct`
   * and exits before it would be written. Now it lands with the release or not at all.
   *
   * `userId: null` on purpose: this is a shell command, there is no session to resolve, and the
   * accountable party is the operator named in the shell history — the description says what was done
   * and to what, which is what a later reader needs.
   */
  const recordRelease: ExternalDocumentIdReleaseRecorder = async (tx, release) => {
    await tx.activityLog.create({
      data: {
        userId: null,
        entityType: 'SYSTEM',
        entityId: row.id,
        action: 'accounting_external_id_claim_released',
        tag: 'sync',
        level: 'WARNING',
        description: redactActivityLogText(
          `Operator released the ${row.connector} external id ${row.externalTransactionId} from ${holder.model} `
          + `${release.releasedFrom} and linked it to ${release.appliedTo.referenceType} ${release.appliedTo.referenceId}. `
          + `${holder.model} ${release.releasedFrom} now has NO ${holder.column} — if that was not a retired-realm document, `
          + 'this needs reversing by hand.',
        ),
        metadata: JSON.parse(JSON.stringify(sanitizeActivityLogMetadata({
          syncLogId: row.id,
          connector: row.connector,
          externalId: row.externalTransactionId,
          releasedModel: holder.model,
          releasedFrom: release.releasedFrom,
          appliedTo: release.appliedTo,
        }))),
      },
    })
  }

  const result = await releaseAndRelinkExternalDocumentId(db, { ...params, syncLogId: row.id, confirmedHolderId }, recordRelease)
  console.log(`\noutcome: ${result.outcome}`)

  switch (result.outcome) {
    case 'relinked':
      console.log(`released ${holder.model} ${result.releasedFrom}; linked ${result.appliedTo.referenceType} ${result.appliedTo.referenceId}`)
      // NOTE: both the audit entry and the clearing of the quarantine text on the sync row happen
      // INSIDE the release's transaction — a resolved conflict must not survive as an
      // unresolved-looking marker, and a record of a destructive act must not be able to fail on its
      // own. Reaching this line means all three landed together.
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
    case 'source-refused':
      // The row you named is not the row you read. Nothing was written.
      console.error(`REFUSED: sync row ${row.id} is no longer the quarantined conflict you named (${result.reason}).`)
      if (result.reason === 'OPERATOR_ASSERTED_ID') {
        // o3d-anu8. Reachable even past the pre-flight above: the row can be settled between the
        // dry run and the apply, which is exactly why the transaction re-reads it.
        console.error('That row was settled BY AN OPERATOR — its status and its external id are an assertion IMS verified nothing '
          + 'about, and the note on it was written by the settlement, not by a refused back-reference. Nothing was written.')
      }
      console.error('Nothing was written. Re-read the row and the activity entry — if it re-posted, its external id has changed and this '
        + 'release is about an id that row no longer owns.')
      process.exitCode = 1
      break
    case 'destination-refused':
      // The half r8 finding 2 is about: the destination acquired a valid link while the warning sat
      // unread, and the older id would have overwritten it.
      console.error(`REFUSED: ${row.referenceType} ${row.referenceId} does not need this link (${result.reason}).`)
      console.error('Nothing was written, and nothing was released. A destination that already carries a back-reference is NEVER '
        + 'overwritten from here — check which id it holds and why before doing anything else.')
      process.exitCode = 1
      break
    case 'not-relinked':
      // NOT a half-state: the release and the re-link are one transaction, so a re-link that would
      // not land takes the release down with it.
      console.error(`REFUSED: the re-link would not have landed (${result.applyOutcome}), so the release was rolled back.`)
      // The unique index's own explanation, when there was one — it names which document holds the
      // id and what to do about it, which "ambiguous" on its own does not.
      if (result.conflictMessage) console.error(result.conflictMessage)
      console.error(`${holder.model} ${confirmedHolderId} still holds ${row.externalTransactionId} and nothing was changed. `
        + 'Resolve the apply outcome above, then run this command again.')
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
    // Worth saying out loud, because the previous version of this command COULD leave something
    // half-done and the habit of assuming so is expensive: the release and the re-link are one
    // transaction, so a failure anywhere — including a dropped connection between the two writes —
    // rolls back to the state before the command ran.
    console.error('\nFAILED — and nothing was written: the release and the re-link are one transaction, so the blocking record still '
      + 'holds the id. Fix the cause above and run the command again.')
    process.exitCode = 1
  })
