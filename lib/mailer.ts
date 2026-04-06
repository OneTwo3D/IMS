import nodemailer from 'nodemailer'
import { db } from '@/lib/db'

type EmailOptions = {
  to: string
  subject: string
  html: string
  attachments?: { filename: string; content: Buffer; contentType?: string }[]
}

async function getSmtpSettings() {
  const keys = ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_smtp_secure', 'email_from_name', 'email_from_email', 'email_reply_to']
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    host: map.get('email_smtp_host') ?? '',
    port: parseInt(map.get('email_smtp_port') ?? '587'),
    user: map.get('email_smtp_user') ?? '',
    pass: map.get('email_smtp_pass') ?? '',
    secure: map.get('email_smtp_secure') ?? 'tls',
    fromName: map.get('email_from_name') ?? '',
    fromEmail: map.get('email_from_email') ?? '',
    replyTo: map.get('email_reply_to') ?? '',
  }
}

export async function sendEmail(opts: EmailOptions): Promise<{ success: boolean; error?: string }> {
  try {
    const smtp = await getSmtpSettings()
    if (!smtp.host || !smtp.fromEmail) {
      return { success: false, error: 'SMTP not configured. Go to Settings → Company → Email/SMTP.' }
    }

    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure === 'ssl',
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      tls: smtp.secure === 'tls' ? { rejectUnauthorized: false } : undefined,
    })

    await transport.sendMail({
      from: smtp.fromName ? `"${smtp.fromName}" <${smtp.fromEmail}>` : smtp.fromEmail,
      replyTo: smtp.replyTo || undefined,
      to: opts.to,
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
    return { success: false, error: String(e) }
  }
}
