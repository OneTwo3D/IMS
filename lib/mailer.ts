import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { z } from 'zod'
import { getSettingValues } from '@/lib/settings-store'

export type SmtpSettings = {
  host: string
  port: number
  user: string
  pass: string
  secure: 'tls' | 'ssl' | 'none'
  fromName: string
  fromEmail: string
  replyTo: string
}

export type SmtpSettingsInput = {
  host: string
  port: string | number
  user: string
  pass: string
  secure: string
  fromName: string
  fromEmail: string
  replyTo: string
}

type EmailOptions = {
  to: string
  subject: string
  html: string
  attachments?: { filename: string; content: Buffer; contentType?: string }[]
  /**
   * An explicit overall deadline for THIS send. Sets the transport's connection, greeting and socket timeouts and races the whole
   * send; at the deadline the transport is closed (its sockets destroyed) and the answer is a PERMANENT "outcome unknown" failure, because
   * the message may already have been accepted. Unset: no deadline, as before.
   */
  deadlineMs?: number
  /**
   * The message must reach the recipient AT MOST ONCE (a purchase order). Once delivery has begun (the DATA command was issued on an
   * established connection), any failure that is not a definite server answer, and any failure at or after `deadlineMs`, is the terminal
   * "outcome unknown" result (`permanent` + `unknownOutcome`): the server may have accepted the message with the final response lost, so
   * it is never requeued. Failures before delivery began (DNS, refused, auth, a server answer) keep their ordinary classification.
   */
  singleSend?: boolean
}

type SendEmailResult = {
  success: boolean
  error?: string
  permanent?: boolean
  invalidRecipient?: boolean
  /** The message may or may not have been delivered; the failure is terminal and an operator must check before re-sending. */
  unknownOutcome?: boolean
}

/** A failure at or within this much of the deadline is the deadline firing, whichever of our timer and the transport's socket timer got there first. */
const DEADLINE_TOLERANCE_MS = 1_000

/** Reason on a send that hit its deadline: the message may or may not have been accepted, so it is never retried automatically. */
export const SEND_DEADLINE_UNKNOWN_OUTCOME = 'Outcome unknown: the mail server did not answer before the send deadline, so the message may or may not have been delivered. Check before re-sending (Email PO).'

const emailSchema = z.email()
const RESERVED_EXAMPLE_DOMAIN_PATTERN = /\bexample\.(com|org|net)\b/i

function validateEmailAddress(value: string, label: string): string {
  const parsed = emailSchema.safeParse(value.trim())
  if (!parsed.success) {
    throw new Error(`Invalid ${label} email address.`)
  }
  return parsed.data
}

function sanitizeDisplayName(value: string): string {
  return value.replace(/[\r\n"]/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeMailError(message: string): string {
  if (
    /domains starting with ["']?example\.com["']? is not allowed/i.test(message)
    || RESERVED_EXAMPLE_DOMAIN_PATTERN.test(message)
  ) {
    return 'Reserved example domains like example.com, example.org, and example.net cannot receive mail. Use a real mailbox address.'
  }

  return message
}

function normalizeSmtpSettings(input: SmtpSettingsInput): SmtpSettings {
  const host = input.host.trim()
  if (!host) {
    throw new Error('SMTP host is required.')
  }

  const portValue = typeof input.port === 'number' ? input.port : Number.parseInt(input.port.trim(), 10)
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error('SMTP port must be a valid port number.')
  }

  const secure = input.secure.trim().toLowerCase()
  if (secure !== 'tls' && secure !== 'ssl' && secure !== 'none') {
    throw new Error('SMTP security must be TLS, SSL, or None.')
  }

  return {
    host,
    port: portValue,
    user: input.user.trim(),
    pass: input.pass,
    secure,
    fromName: input.fromName.trim(),
    fromEmail: input.fromEmail.trim(),
    replyTo: input.replyTo.trim(),
  }
}

async function getSmtpSettings(): Promise<SmtpSettingsInput> {
  const keys = ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_smtp_secure', 'email_from_name', 'email_from_email', 'email_reply_to']
  const map = await getSettingValues(keys)
  return {
    host: map.get('email_smtp_host') ?? '',
    port: map.get('email_smtp_port') ?? '587',
    user: map.get('email_smtp_user') ?? '',
    pass: map.get('email_smtp_pass') ?? '',
    secure: map.get('email_smtp_secure') ?? 'tls',
    fromName: map.get('email_from_name') ?? '',
    fromEmail: map.get('email_from_email') ?? '',
    replyTo: map.get('email_reply_to') ?? '',
  }
}

function classifySendFailure(e: unknown, unknownOutcome: boolean): SendEmailResult {
  if (unknownOutcome) return { success: false, permanent: true, unknownOutcome: true, error: SEND_DEADLINE_UNKNOWN_OUTCOME }
  const error = e as { code?: string; responseCode?: number }
  const message = normalizeMailError(String(e))
  const responseCode = typeof error.responseCode === 'number' ? error.responseCode : null
  const code = error.code ?? ''
  const invalidRecipient =
    responseCode === 550
    || responseCode === 551
    || responseCode === 553
    || responseCode === 554
    || code === 'EENVELOPE'
    || /recipient|mailbox unavailable|user unknown|no such user|invalid recipient/i.test(message)
  const permanent =
    invalidRecipient
    || (responseCode !== null && responseCode >= 500 && responseCode < 600)
  return { success: false, error: message, permanent, invalidRecipient }
}

export async function sendEmailWithSmtpSettings(
  smtpInput: SmtpSettingsInput,
  opts: EmailOptions,
): Promise<SendEmailResult> {
  let unknownOutcomeProbe: ((e: unknown) => boolean) | undefined
  try {
    const smtp = normalizeSmtpSettings(smtpInput)
    if (!smtp.fromEmail) {
      return { success: false, error: 'From email is required.' }
    }

    const fromEmail = validateEmailAddress(smtp.fromEmail, 'from')
    const toEmail = validateEmailAddress(opts.to, 'to')
    const replyToEmail = smtp.replyTo ? validateEmailAddress(smtp.replyTo, 'reply-to') : undefined
    const fromName = sanitizeDisplayName(smtp.fromName)

    const deadlineMs = opts.deadlineMs
    // singleSend: watch the transaction log for the DATA command (the first byte of the message). The log entry is read for that one
    // fact and discarded; nothing it carries (addresses, credentials) is kept.
    let dataStarted = false
    const startedAt = Date.now()
    if (opts.singleSend) {
      unknownOutcomeProbe = (e) => {
        const responseCode = (e as { responseCode?: unknown } | null)?.responseCode
        if (typeof responseCode === 'number') return false // a definite answer from the server: the ordinary classification applies
        const atDeadline = deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs - DEADLINE_TOLERANCE_MS
        return dataStarted || atDeadline
      }
    }
    const noop = () => undefined
    const transportOptions: SMTPTransport.Options = {
      ...(opts.singleSend ? {
        transactionLog: true,
        logger: {
          debug: (entry: { tnx?: string } | undefined, message?: unknown): void => {
            if (entry?.tnx === 'client' && typeof message === 'string' && message.trim().toUpperCase() === 'DATA') dataStarted = true
          },
          level: noop, trace: noop, info: noop, warn: noop, error: noop, fatal: noop,
        },
      } : {}),
      ...(deadlineMs ? { connectionTimeout: deadlineMs, greetingTimeout: deadlineMs, socketTimeout: deadlineMs } : {}),
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure === 'ssl',
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      tls: smtp.secure === 'tls' ? { rejectUnauthorized: true } : undefined,
    }
    const transport = nodemailer.createTransport(transportOptions)

    const sending = transport.sendMail({
      from: fromName ? { name: fromName, address: fromEmail } : fromEmail,
      replyTo: replyToEmail,
      to: toEmail,
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType ?? 'application/pdf',
      })),
    })
    if (deadlineMs) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        sending.then(() => 'sent' as const),
        new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs) }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      if (outcome === 'deadline') {
        sending.catch(() => undefined)
        transport.close()
        return classifySendFailure(null, true)
      }
    } else {
      await sending
    }

    return { success: true }
  } catch (e) {
    return classifySendFailure(e, unknownOutcomeProbe?.(e) ?? false)
  }
}

export async function sendEmail(opts: EmailOptions): Promise<SendEmailResult> {
  try {
    const smtp = await getSmtpSettings()
    if (!smtp.host || !smtp.fromEmail) {
      return { success: false, error: 'SMTP not configured. Go to Settings → Company → Email/SMTP.' }
    }
    return await sendEmailWithSmtpSettings(smtp, opts)
  } catch (e) {
    return classifySendFailure(e, false)
  }
}
