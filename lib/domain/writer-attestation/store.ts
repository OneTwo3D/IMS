import { logActivityInTransaction, logActivityPersisted } from '@/lib/activity-log'
import { bridgePayloadFromReport, bridgeStatusFreshnessError, parseBridgeStatusOutput } from '@/lib/domain/writer-attestation/bridge-status'
import {
  ATTESTATION_GUARDED_SETTINGS,
  WRITER_ATTESTATION_ACTION,
  WRITER_ATTESTATION_LABEL,
  WRITER_ATTESTATION_NOTE_MAX,
  WRITER_ATTESTATION_REFUSAL_ACTION,
  WRITER_ATTESTATION_REPORT_KINDS,
  attestationRefusalText,
  isWriterAttestationKind,
  type WriterAttestationKind,
} from '@/lib/security/writer-attestation-constants'

/** What a transaction of this module touches: the confirmation row and its audit-log row. */
export type AttestationTx = {
  writerAttestation: {
    create(args: { data: { kind: string; userId: string; note: string; payload: object } }): Promise<{ id: string; kind: string; attestedAt: Date }>
  }
  activityLog: Parameters<typeof logActivityInTransaction>[0]['activityLog']
}

/** The slice of the database this module uses, so tests hand in a double. */
export type AttestationDb = {
  writerAttestation: {
    findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' } }): Promise<{ id: string; kind: string; attestedAt: Date; userId: string } | null>
  }
  $transaction<T>(fn: (tx: AttestationTx) => Promise<T>): Promise<T>
}

/** `output`: the pasted host report, required for the kinds in WRITER_ATTESTATION_REPORT_KINDS (and refused for the others). `now` is for tests. */
export type RecordAttestationInput = { kind: string; userId: string; note?: string; payload?: object; output?: string; now?: Date }
export type RecordAttestationResult =
  | { ok: true; id: string; kind: WriterAttestationKind; attestedAt: Date }
  | { ok: false; error: string }

/**
 * Record a confirmation. Append-only. THE ROW AND ITS AUDIT-LOG ENTRY ARE ONE TRANSACTION: a confirmation lets IMS start writing to a live system, so it
 * takes effect only together with the record of who gave it. When the audit row cannot be written the confirmation is rolled back and reported as failed,
 * so a refused confirmation can never be in force.
 */
export async function recordWriterAttestation(db: AttestationDb, input: RecordAttestationInput): Promise<RecordAttestationResult> {
  if (!isWriterAttestationKind(input.kind)) return { ok: false, error: 'Unknown confirmation kind.' }
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  if (userId === '') return { ok: false, error: 'A confirmation needs the user who gives it.' }
  const note = (input.note ?? '').trim()
  if (note.length > WRITER_ATTESTATION_NOTE_MAX) return { ok: false, error: `The note is longer than ${WRITER_ATTESTATION_NOTE_MAX} characters.` }
  const kind = input.kind
  let payload: object = input.payload ?? {}
  let reportSummary: Record<string, unknown> = {}
  if ((WRITER_ATTESTATION_REPORT_KINDS as readonly string[]).includes(kind)) {
    // A host report is parsed STRICTLY and must be fresh: the confirmation is the report, not the administrator's word that it was fine. Whether the
    // units are masked is NOT judged here (the history keeps a failing report too); the check judges the newest one.
    const parsed = parseBridgeStatusOutput(input.output ?? '')
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const stale = bridgeStatusFreshnessError(parsed.report, input.now ?? new Date())
    if (stale !== null) return { ok: false, error: stale }
    payload = bridgePayloadFromReport(parsed.report, input.output ?? '')
    reportSummary = { host: parsed.report.host, generatedAt: parsed.report.generatedAt, lastTriggerAt: parsed.report.lastTriggerAt }
  } else if (input.output !== undefined) {
    return { ok: false, error: 'This confirmation does not take a pasted report.' }
  }
  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.writerAttestation.create({ data: { kind, userId, note, payload } })
      await logActivityInTransaction(tx, {
        entityType: 'SETTING',
        entityId: created.id,
        action: WRITER_ATTESTATION_ACTION,
        tag: 'settings',
        level: 'WARNING',
        description: `Owner confirmation recorded: ${WRITER_ATTESTATION_LABEL[kind]}`,
        metadata: { kind, attestedAt: created.attestedAt.toISOString(), note, ...reportSummary },
        userId: userId.startsWith('cli:') ? null : userId,
      })
      return created
    })
    return { ok: true, id: row.id, kind, attestedAt: row.attestedAt }
  } catch {
    return { ok: false, error: 'The confirmation could not be recorded together with its audit-log entry, so nothing was stored. Try again.' }
  }
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
