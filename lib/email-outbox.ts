import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { sendEmail } from '@/lib/mailer'
import { prepareQueuedEmail } from '@/lib/order-email'

const EMAIL_MAX_ATTEMPTS = 5
const EMAIL_CLAIM_STALE_MS = 15 * 60 * 1000
const EMAIL_BACKOFF_BASE_MS = 60_000
const EMAIL_BACKOFF_MAX_MS = 60 * 60 * 1000
const EMAIL_BATCH_SIZE = 25

type QueuedAttachment = {
  filename: string
  contentBase64: string
  contentType?: string
}

type QueueEmailInput = {
  kind: string
  to: string
  subject: string
  html: string
  attachments?: { filename: string; content: Buffer; contentType?: string }[]
  referenceType?: string
  referenceId?: string
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function getBackoffMs(attempts: number): number {
  return Math.min(EMAIL_BACKOFF_BASE_MS * 2 ** attempts, EMAIL_BACKOFF_MAX_MS)
}

export async function queueEmail(input: QueueEmailInput): Promise<void> {
  const attachments: QueuedAttachment[] | undefined = input.attachments?.map((attachment) => ({
    filename: attachment.filename,
    contentBase64: attachment.content.toString('base64'),
    contentType: attachment.contentType,
  }))

  await db.emailOutbox.create({
    data: {
      kind: input.kind,
      toEmail: normalizeEmail(input.to),
      subject: input.subject,
      html: input.html,
      attachments: attachments as never,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
    },
  })
}

export async function processPendingEmailOutbox(): Promise<{ processed: number; sent: number; failed: number }> {
  const staleCutoff = new Date(Date.now() - EMAIL_CLAIM_STALE_MS)
  const result = { processed: 0, sent: 0, failed: 0 }

  const pending = await db.emailOutbox.findMany({
    where: {
      attempts: { lt: EMAIL_MAX_ATTEMPTS },
      OR: [
        {
          status: 'PENDING',
          availableAt: { lte: new Date() },
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleCutoff },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: EMAIL_BATCH_SIZE,
  })

  for (const email of pending) {
    const normalizedRecipient = normalizeEmail(email.toEmail)
    const suppression = await db.emailSuppression.findUnique({
      where: { email: normalizedRecipient },
      select: { id: true, reason: true },
    })
    if (suppression) {
      await db.emailOutbox.update({
        where: { id: email.id },
        data: {
          status: 'FAILED',
          lastError: `Suppressed recipient: ${suppression.reason}`,
          processingStartedAt: null,
        },
      })
      result.processed++
      result.failed++
      continue
    }

    const claim = await db.emailOutbox.updateMany({
      where: {
        id: email.id,
        attempts: { lt: EMAIL_MAX_ATTEMPTS },
        OR: [
          {
            status: 'PENDING',
            availableAt: { lte: new Date() },
          },
          {
            status: 'PROCESSING',
            processingStartedAt: { lt: staleCutoff },
          },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    })
    if (claim.count === 0) continue

    result.processed++

    try {
      const prepared = await prepareQueuedEmail(email.kind, email.referenceType, email.referenceId)
      const attachments = prepared?.attachments ?? ((email.attachments as QueuedAttachment[] | null) ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType,
      }))

      const sendResult = await sendEmail({
        to: prepared?.to ?? email.toEmail,
        subject: prepared?.subject ?? email.subject,
        html: prepared?.html ?? email.html,
        attachments,
      })

      if (sendResult.success) {
        await db.emailOutbox.update({
          where: { id: email.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            lastError: null,
            processingStartedAt: null,
          },
        })
        result.sent++
        continue
      }

      const attempts = email.attempts + 1
      const permanentFailure = !!sendResult.permanent || attempts >= EMAIL_MAX_ATTEMPTS
      if (sendResult.invalidRecipient) {
        await db.emailSuppression.upsert({
          where: { email: normalizedRecipient },
          create: {
            email: normalizedRecipient,
            reason: sendResult.error ?? 'Invalid recipient rejected by SMTP provider',
            source: 'smtp',
            lastHitAt: new Date(),
          },
          update: {
            reason: sendResult.error ?? 'Invalid recipient rejected by SMTP provider',
            source: 'smtp',
            lastHitAt: new Date(),
          },
        })
      }
      await db.emailOutbox.update({
        where: { id: email.id },
        data: {
          status: permanentFailure ? 'FAILED' : 'PENDING',
          attempts,
          lastError: sendResult.error ?? 'Unknown email error',
          availableAt: permanentFailure ? email.availableAt : new Date(Date.now() + getBackoffMs(email.attempts)),
          processingStartedAt: null,
        },
      })
      result.failed++
    } catch (error) {
      const attempts = email.attempts + 1
      const permanentFailure = attempts >= EMAIL_MAX_ATTEMPTS
      await db.emailOutbox.update({
        where: { id: email.id },
        data: {
          status: permanentFailure ? 'FAILED' : 'PENDING',
          attempts,
          lastError: String(error),
          availableAt: permanentFailure ? email.availableAt : new Date(Date.now() + getBackoffMs(email.attempts)),
          processingStartedAt: null,
        },
      })
      result.failed++
    }
  }

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'email_outbox_processed',
      tag: 'system',
      description: `Email outbox: ${result.sent} sent, ${result.failed} failed out of ${result.processed} processed`,
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
