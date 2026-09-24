/**
 * o3d-hpeg — WHAT AN OPERATOR DOES WITH AN EMAIL ROW PARKED AT THE SEND CAP.
 *
 * The drain parks a row (`PARKED_SEND_CAP`) when its claim has gone stale after it was already
 * reclaimed `EMAIL_MAX_STALE_RECLAIMS` times: the sender has been entered at least twice for it, and
 * nothing in the table says whether either copy reached the customer. The drain never selects a parked
 * row again, and the partial unique index keeps a fresh row for the same reference from being queued
 * behind it (migration 20260918090100). Moving it on is a human decision, made after reading the mail
 * server or provider log, and these are the only two ways to make it:
 *
 *   RELEASE — the operator has established the email did NOT go out (or wants it sent regardless). The
 *     row returns to PENDING, available now, with its claim cleared, and the next drain sends it once.
 *     `attempts` and `staleReclaimCount` are left as they are: the release is not a fresh row, so a
 *     release that stalls again is parked again rather than reclaimed.
 *   CANCEL — the email went out, or should not. The row becomes FAILED with the reason recorded, which
 *     frees the reference so a deliberate re-send can be queued later through the normal buttons.
 *
 * Each is ONE conditional UPDATE that only matches a row still PARKED_SEND_CAP — a row that already
 * moved (another operator got there first) is refused, never overwritten — and the activity-log record
 * of it is written in the SAME transaction, so the change and its audit trail happen together or not
 * at all. `scripts/email-outbox-parked.ts` is the command-line front for these; nothing calls them
 * automatically.
 */
import { EMAIL_OUTBOX_PARKED_STATUS } from '@/lib/email-outbox'

export type ParkedEmailAction = 'release' | 'cancel'

export type ParkedEmailRow = {
  id: string
  kind: string
  toEmail: string
  subject: string
  referenceType: string | null
  referenceId: string | null
  attempts: number
  staleReclaimCount: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

type ParkedEmailTx = {
  emailOutbox: { updateMany(args: unknown): Promise<{ count: number }> }
  activityLog: { create(args: unknown): Promise<unknown> }
}

export type ParkedEmailClient = {
  emailOutbox: { findMany(args: unknown): Promise<ParkedEmailRow[]> }
  $transaction<T>(fn: (tx: ParkedEmailTx) => Promise<T>): Promise<T>
}

const PARKED_ROW_SELECT = {
  id: true,
  kind: true,
  toEmail: true,
  subject: true,
  referenceType: true,
  referenceId: true,
  attempts: true,
  staleReclaimCount: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const

/** Every parked row, oldest first. Read-only. */
export async function listParkedEmails(client: ParkedEmailClient): Promise<ParkedEmailRow[]> {
  return client.emailOutbox.findMany({
    where: { status: EMAIL_OUTBOX_PARKED_STATUS },
    orderBy: { createdAt: 'asc' },
    select: PARKED_ROW_SELECT,
  })
}

export type ParkedEmailResolution =
  | { resolved: true; action: ParkedEmailAction; id: string }
  | { resolved: false; id: string; reason: string }

/**
 * Release or cancel ONE parked row, and record who did it, atomically. Refuses — changes nothing and
 * records nothing — when the row is not (or no longer) PARKED_SEND_CAP.
 */
export async function resolveParkedEmail(
  client: ParkedEmailClient,
  params: { id: string; action: ParkedEmailAction; operator: string; now: Date },
): Promise<ParkedEmailResolution> {
  return client.$transaction(async (tx) => {
    const data = params.action === 'release'
      ? {
          status: 'PENDING',
          availableAt: params.now,
          processingStartedAt: null,
          lockedBy: null,
          lastError: `Released from PARKED_SEND_CAP by ${params.operator} (o3d-hpeg)`,
        }
      : {
          status: 'FAILED',
          processingStartedAt: null,
          lockedBy: null,
          lastError: `Cancelled from PARKED_SEND_CAP by ${params.operator} (o3d-hpeg)`,
        }
    const updated = await tx.emailOutbox.updateMany({
      where: { id: params.id, status: EMAIL_OUTBOX_PARKED_STATUS },
      data,
    })
    if (updated.count === 0) {
      return {
        resolved: false as const,
        id: params.id,
        reason: `email_outbox row ${params.id} is not PARKED_SEND_CAP (it does not exist, or it has already been `
          + 'released or cancelled); nothing was changed',
      }
    }
    await tx.activityLog.create({
      data: {
        entityType: 'SYSTEM',
        entityId: params.id,
        action: params.action === 'release' ? 'email_outbox_parked_released' : 'email_outbox_parked_cancelled',
        tag: 'system',
        level: 'WARNING',
        description: params.action === 'release'
          ? `Email outbox row ${params.id} RELEASED from PARKED_SEND_CAP by ${params.operator}: the next drain sends it once (o3d-hpeg)`
          : `Email outbox row ${params.id} CANCELLED from PARKED_SEND_CAP by ${params.operator}: it will not be sent (o3d-hpeg)`,
        metadata: { emailOutboxId: params.id, action: params.action, operator: params.operator },
      },
    })
    return { resolved: true as const, action: params.action, id: params.id }
  })
}
