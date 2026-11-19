'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireAdmin, requireFreshAdmin } from '@/lib/auth/server'
import { latestWriterAttestation, recordWriterAttestation, type AttestationDb } from '@/lib/domain/writer-attestation/store'
import {
  WRITER_ATTESTATION_KINDS,
  WRITER_ATTESTATION_LABEL,
  WRITER_ATTESTATION_STATEMENT,
  isWriterAttestationKind,
  type WriterAttestationKind,
} from '@/lib/security/writer-attestation-constants'

export type WriterConfirmationRow = {
  kind: WriterAttestationKind
  label: string
  statement: string
  confirmedAt: string | null
  confirmedBy: string | null
}

/** The confirmations in force (the newest of each kind). ADMIN only. */
export async function getWriterConfirmations(): Promise<WriterConfirmationRow[]> {
  await requireAdmin()
  const rows: WriterConfirmationRow[] = []
  for (const kind of WRITER_ATTESTATION_KINDS) {
    const latest = await latestWriterAttestation(db as unknown as AttestationDb, kind)
    rows.push({
      kind,
      label: WRITER_ATTESTATION_LABEL[kind],
      statement: WRITER_ATTESTATION_STATEMENT[kind],
      confirmedAt: latest ? latest.attestedAt.toISOString() : null,
      confirmedBy: latest ? latest.userId : null,
    })
  }
  return rows
}

/**
 * The owner's confirmation that an incumbent writer is stopped. ADMIN only, with a recent sign-in (a confirmation lets IMS start writing to a live
 * system), audit-logged. `acknowledged` must be true: the screen's statement was read and accepted.
 */
export async function confirmWriterStopped(input: { kind: string; note?: string; acknowledged: boolean }): Promise<{ success: boolean; error?: string; code?: string; reason?: string }> {
  let userId: string
  try {
    const session = await requireFreshAdmin()
    userId = session.user.id
  } catch (e) {
    const fresh = freshAuthFailureResult(e)
    if (fresh) return fresh
    throw e
  }
  if (!isWriterAttestationKind(input.kind)) return { success: false, error: 'Unknown confirmation.' }
  if (input.acknowledged !== true) return { success: false, error: 'Tick the box to confirm the statement.' }
  const result = await recordWriterAttestation(db as unknown as AttestationDb, { kind: input.kind, userId, note: input.note ?? '' })
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/sync/writer-confirmations')
  return { success: true }
}
