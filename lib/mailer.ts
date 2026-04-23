import nodemailer from 'nodemailer'
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
}

type SendEmailResult = {
  success: boolean
  error?: string
  permanent?: boolean
  invalidRecipient?: boolean
}

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

export async function sendEmailWithSmtpSettings(
  smtpInput: SmtpSettingsInput,
  opts: EmailOptions,
): Promise<SendEmailResult> {
  try {
    const smtp = normalizeSmtpSettings(smtpInput)
    if (!smtp.fromEmail) {
      return { success: false, error: 'From email is required.' }
    }

    const fromEmail = validateEmailAddress(smtp.fromEmail, 'from')
    const toEmail = validateEmailAddress(opts.to, 'to')
    const replyToEmail = smtp.replyTo ? validateEmailAddress(smtp.replyTo, 'reply-to') : undefined
    const fromName = sanitizeDisplayName(smtp.fromName)

    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure === 'ssl',
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      tls: smtp.secure === 'tls' ? { rejectUnauthorized: true } : undefined,
    })

    await transport.sendMail({
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

    return { success: true }
  } catch (e) {
    const error = e as {
      code?: string
      responseCode?: number
      command?: string
      message?: string
    }
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
}

export async function sendEmail(opts: EmailOptions): Promise<SendEmailResult> {
  try {
    const smtp = await getSmtpSettings()
    if (!smtp.host || !smtp.fromEmail) {
      return { success: false, error: 'SMTP not configured. Go to Settings → Company → Email/SMTP.' }
    }
    return await sendEmailWithSmtpSettings(smtp, opts)
  } catch (e) {
    const error = e as {
      code?: string
      responseCode?: number
      command?: string
      message?: string
    }
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
}
