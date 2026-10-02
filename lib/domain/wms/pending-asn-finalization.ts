/**
 * FINALIZING A PENDING ASN RESERVATION IS A COMPARE-AND-SET, NOT AN UNCONDITIONAL WRITE (o3d-papk, Codex round 2).
 *
 * THE DEFECT. Two requests can reserve the same CREATE_PENDING row before either claims it. One claims and starts
 * the remote create; the other's revalidation then fails (a quantity moved) and its discard retired the row —
 * shrinking every line's `expectedQty` to its credit and setting `closedAt`. The first request's finalizer then
 * wrote `closedAt: null` and the remote ASN's ids onto that row unconditionally: a reservation whose expectation
 * the retirement had rewritten was reopened and mapped to a live ASN created for different quantities.
 *
 * THE FIX IS TWO SIDED. (1) The discard only ever touches an UNCLAIMED OPEN reservation (status CREATE_PENDING and
 * `closedAt` null; the claim is what moves a row to CREATE_IN_FLIGHT), so a request that has claimed a row cannot
 * have it taken from under it. (2) Whatever still gets through — a stale-claim demotion, a recovery that adopts an
 * ASN for a row another request has since claimed — is caught here: the finalizer verifies, under the parent and
 * header locks, that the row is still the reservation it reserved (open, in the status its own step left it in,
 * its lines the same rows carrying the same quantities) BEFORE it writes anything, and otherwise FAILS CLOSED.
 *
 * WHAT FAILING CLOSED DOES ABOUT THE REMOTE ASN THAT WAS CREATED. Nothing is recorded against a row that no longer
 * describes it (that is the defect). The error carries the remote ASN's id and the creators' existing handling of
 * "an ASN exists at the warehouse and IMS recorded nothing for it" takes over: the id is retained on the failed
 * job's summary (`unrecordedExternalAsnId`) and on a WARNING activity entry, and the next create attempt is refused
 * BY NAME by the duplicate matcher (or adopts the ASN as a recovery if the row has since come to match it), so no
 * second ASN is created and the orphan is neither lost nor silently adopted. Removing it is `DELETE /api/ASN/{id}`
 * at the warehouse, by a person.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { toDecimal } from '@/lib/domain/math/decimal'
import type { PendingAsnParent } from '@/lib/domain/wms/pending-asn-retirement'

export class PendingAsnFinalizationConflictError extends Error {
  override readonly name = 'PendingAsnFinalizationConflictError'

  constructor(
    /** The id the WAREHOUSE gave the ASN it created: the operator's only handle on it. */
    readonly externalAsnId: string,
    readonly reason: string,
    /** True when IMS already holds a map row for that remote id (the conflict branch), so nothing is orphaned. */
    readonly alreadyRecorded: boolean,
  ) {
    super(
      `ASN ${externalAsnId} was created at the warehouse, but the reservation it was created for changed while the create was in flight `
      + `(${reason}), so IMS did not record it against that reservation. ${alreadyRecorded ? 'IMS already holds a record for it.' : 'It exists at the warehouse with no IMS record: retry the create (IMS will find it by its reference) or remove it at the warehouse.'}`,
    )
  }
}

export type ReservedLineExpectation = { asnLineMapId: string; expectedQty: number }

/**
 * Verify the reservation is still the one this request reserved. Call it under the parent lock and the header lock
 * (steps 2 and 3), before any write. Throws `PendingAsnFinalizationConflictError`; returns nothing.
 *
 * `expectedStatus`: a freshly created ASN is finalized from a row this request CLAIMED (CREATE_IN_FLIGHT); an ASN
 * adopted by duplicate recovery is finalized BEFORE any claim, from a row still CREATE_PENDING.
 */
export async function assertPendingAsnReservationStillOurs(
  tx: Prisma.TransactionClient,
  input: {
    parent: PendingAsnParent
    asnMapId: string
    expectedStatus: 'CREATE_PENDING' | 'CREATE_IN_FLIGHT'
    lines: ReadonlyArray<ReservedLineExpectation>
    remoteExternalAsnId: string
    alreadyRecorded: boolean
  },
): Promise<void> {
  const fail = (reason: string): never => {
    throw new PendingAsnFinalizationConflictError(input.remoteExternalAsnId, reason, input.alreadyRecorded)
  }

  const header = await tx.wmsAsnMap.findFirst({
    where: { id: input.asnMapId, sourceType: input.parent.kind, sourceId: input.parent.id },
    select: {
      status: true,
      closedAt: true,
      lines: { select: { id: true, expectedQty: true } },
    },
  })
  if (!header) return fail('the reservation no longer exists')
  if (header.closedAt !== null) return fail('the reservation was retired')
  if (header.status !== input.expectedStatus) return fail(`the reservation is ${header.status}, not ${input.expectedStatus}`)

  const reserved = new Map(input.lines.map((line) => [line.asnLineMapId, line.expectedQty]))
  if (header.lines.length !== reserved.size) return fail('the reservation\'s lines changed')
  for (const line of header.lines) {
    const expected = reserved.get(line.id)
    if (expected === undefined) return fail('the reservation\'s lines changed')
    if (toDecimal(line.expectedQty).toNumber() !== expected) {
      return fail(`a line now expects ${toDecimal(line.expectedQty).toNumber()} where ${expected} was reserved`)
    }
  }
}
