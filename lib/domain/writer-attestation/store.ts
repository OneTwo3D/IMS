import { logActivityPersisted } from '@/lib/activity-log'
import {
  ATTESTATION_GUARDED_SETTINGS,
  WRITER_ATTESTATION_ACTION,
  WRITER_ATTESTATION_LABEL,
  WRITER_ATTESTATION_NOTE_MAX,
  WRITER_ATTESTATION_REFUSAL_ACTION,
  attestationRefusalText,
  isWriterAttestationKind,
  type WriterAttestationKind,
} from '@/lib/security/writer-attestation-constants'

/** The slice of the database this module uses, so tests hand in a double. */
export type AttestationDb = {
  writerAttestation: {
    create(args: { data: { kind: string; userId: string; note: string; payload: object } }): Promise<{ id: string; kind: string; attestedAt: Date }>
    findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' } }): Promise<{ id: string; kind: string; attestedAt: Date; userId: string } | null>
  }
}

export type RecordAttestationInput = { kind: string; userId: string; note?: string; payload?: object }
export type RecordAttestationResult =
  | { ok: true; id: string; kind: WriterAttestationKind; attestedAt: Date }
  | { ok: false; error: string }

/** Record a confirmation. Append-only; the activity-log entry is part of the contract: when it cannot be persisted the confirmation is reported as failed. */
export async function recordWriterAttestation(db: AttestationDb, input: RecordAttestationInput): Promise<RecordAttestationResult> {
  if (!isWriterAttestationKind(input.kind)) return { ok: false, error: 'Unknown confirmation kind.' }
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  if (userId === '') return { ok: false, error: 'A confirmation needs the user who gives it.' }
  const note = (input.note ?? '').trim()
  if (note.length > WRITER_ATTESTATION_NOTE_MAX) return { ok: false, error: `The note is longer than ${WRITER_ATTESTATION_NOTE_MAX} characters.` }
  const row = await db.writerAttestation.create({ data: { kind: input.kind, userId, note, payload: input.payload ?? {} } })
  const logged = await logActivityPersisted({
    entityType: 'SETTING',
    entityId: row.id,
    action: WRITER_ATTESTATION_ACTION,
    tag: 'settings',
    level: 'WARNING',
    description: `Owner confirmation recorded: ${WRITER_ATTESTATION_LABEL[input.kind]}`,
    metadata: { kind: input.kind, attestedAt: row.attestedAt.toISOString(), note },
    userId: userId.startsWith('cli:') ? null : userId,
    resolveUser: false,
  })
  if (!logged) return { ok: false, error: 'The confirmation was stored but its audit-log entry could not be written. Check the activity log before relying on it.' }
  return { ok: true, id: row.id, kind: input.kind, attestedAt: row.attestedAt }
}

export async function latestWriterAttestation(db: AttestationDb, kind: WriterAttestationKind): Promise<{ id: string; attestedAt: Date; userId: string } | null> {
  const row = await db.writerAttestation.findFirst({ where: { kind }, orderBy: { attestedAt: 'desc' } })
  return row ? { id: row.id, attestedAt: row.attestedAt, userId: row.userId } : null
}

/**
 * THE SETTING-WRITER GUARD. Given the values a save is about to write, returns the refusal text for the first guarded setting being turned ON without
 * a matching attestation, or null. `currentValue` says what is stored now: a setting that is ALREADY on is not a transition and is not refused (an
 * installation that was switched on before this guard existed keeps working; only a new switch-on needs the confirmation). Anything that cannot be
 * read is a refusal: an unreadable attestation is not consent.
 */
export async function refuseGuardedSettingWithoutAttestation(
  data: Record<string, unknown>,
  deps: { db: AttestationDb; currentValue: (key: string) => Promise<string | null | undefined> },
): Promise<string | null> {
  for (const [setting, kind] of Object.entries(ATTESTATION_GUARDED_SETTINGS)) {
    if (data[setting] !== 'true') continue
    if ((await deps.currentValue(setting)) === 'true') continue
    let found: unknown = null
    try {
      found = await latestWriterAttestation(deps.db, kind)
    } catch {
      found = null
    }
    if (found !== null) continue
    try {
      await logActivityPersisted({
        entityType: 'SETTING', action: WRITER_ATTESTATION_REFUSAL_ACTION, tag: 'settings', level: 'WARNING',
        description: `Refused to turn on ${setting}: no owner confirmation (${kind})`, metadata: { setting, kind },
      })
    } catch { /* the refusal stands without its log line */ }
    return attestationRefusalText(setting, kind)
  }
  return null
}
