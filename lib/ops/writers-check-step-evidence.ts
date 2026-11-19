import {
  STEP_EVIDENCE_ATTESTATION_KIND,
  STEP_EVIDENCE_KINDS,
  type StepEvidenceKind,
  type StepEvidenceReading,
} from '@/lib/security/writers-check-constants'
import { isWriterAttestationKind } from '@/lib/security/writer-attestation-constants'

/**
 * THE READERS OF THE STEP EVIDENCE (what shows an incumbent has stopped, beyond the marks on imported orders).
 *
 * Each kind has exactly one reader. A kind whose source does not exist yet is registered as `not-built`; the evaluator then FAILS the phases that
 * require it with an "evidence source not built" finding. A reader never answers "fine" for a source it cannot read: it answers `not-built`,
 * `not-probed`, or `unreadable`. When a source is built, replace its entry here and nothing else changes.
 */

type AttestationReaderDb = {
  writerAttestation: { findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' }; select: { attestedAt: true } }): Promise<{ attestedAt: Date } | null> }
}

export type StepEvidenceReader = (ctx: { db: AttestationReaderDb; now: Date }) => Promise<StepEvidenceReading>

const notBuilt: StepEvidenceReader = async () => ({ state: 'not-built' })

function attestationReader(kind: string): StepEvidenceReader {
  return async ({ db }) => {
    if (!isWriterAttestationKind(kind)) return { state: 'unreadable' }
    const row = await db.writerAttestation.findFirst({ where: { kind }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true } })
    return row ? { state: 'present', at: row.attestedAt.toISOString() } : { state: 'absent' }
  }
}

export const STEP_EVIDENCE_READERS: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = {
  // Source: scripts/bridge_writers_status.py in the bridge repository, recorded as an attestation. Not built.
  BRIDGE_ATTESTATION: notBuilt,
  // Source: the companion plugin's /incumbents route and its client. Not built.
  BRIDGE_PROBE: notBuilt,
  // Source: a Mintsoft read of orders for the client that IMS has no link for. Not built.
  MINTSOFT_FOREIGN_ORDER: notBuilt,
  QOBLEX_STOCK_PUSH_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_STOCK_PUSH_STOPPED!),
  // Source: the stock-drift observer. Not built.
  STOCK_DRIFT: notBuilt,
  QOBLEX_XERO_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_XERO_STOPPED!),
  // Source: import-time evidence of a Xeroom-written note, dated. Not built.
  XEROOM_NOTE: notBuilt,
}

/** Read every kind. A reader that throws gives `unreadable` for that kind alone. */
export async function readStepEvidence(ctx: { db: AttestationReaderDb; now: Date }, readers: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = STEP_EVIDENCE_READERS): Promise<Record<StepEvidenceKind, StepEvidenceReading>> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  for (const kind of STEP_EVIDENCE_KINDS) {
    try {
      out[kind] = await readers[kind](ctx)
    } catch {
      out[kind] = { state: 'unreadable' }
    }
  }
  return out
}
