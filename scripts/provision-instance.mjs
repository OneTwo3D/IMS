#!/usr/bin/env node

import bcrypt from 'bcryptjs'
import nodemailer from 'nodemailer'
import pg from 'pg'

const { Client } = pg

function getEnv(name, { required = false, fallback = '' } = {}) {
  const raw = process.env[name]
  const value = raw && String(raw).trim() ? raw : fallback
  if (required && !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return String(value).trim()
}

function maskEmail(value) {
  if (!value.includes('@')) return value
  const [local, domain] = value.split('@')
  if (local.length <= 2) return `${local[0] ?? '*'}*@${domain}`
  return `${local.slice(0, 2)}***@${domain}`
}

async function upsertSetting(db, key, value) {
  if (!value) return
  await db.query(
    `
      insert into settings (key, value, "updatedAt")
      values ($1, $2, now())
      on conflict (key)
      do update set value = excluded.value, "updatedAt" = now()
    `,
    [key, value],
  )
}

async function provisionDefaultAdmin(db, options) {
  const passwordHash = await bcrypt.hash(options.password, 12)
  const existing = await db.query(
    'select id from users where lower(email) = lower($1) limit 1',
    [options.email],
  )

  if (existing.rowCount) {
    await db.query(
      `
        update users
        set name = $2,
            "passwordHash" = $3,
            role = 'ADMIN',
            active = true,
            "updatedAt" = now()
        where id = $1
      `,
      [existing.rows[0].id, options.name, passwordHash],
    )
    return { created: false }
  }

  await db.query(
    `
      insert into users (
        id, email, name, "passwordHash", role, active, "createdAt", "updatedAt"
      ) values (
        $1, lower($2), $3, $4, 'ADMIN', true, now(), now()
      )
    `,
    [crypto.randomUUID().replace(/-/g, '').slice(0, 25), options.email, options.name, passwordHash],
  )

  return { created: true }
}

async function sendProvisioningEmail(options) {
  if (!options.smtp.host || !options.smtp.fromEmail || !options.notificationEmail) {
    console.log('[WARN] Skipping provisioning email because SMTP or notification details are incomplete.')
    return
  }

  const transport = nodemailer.createTransport({
    host: options.smtp.host,
    port: Number(options.smtp.port || 587),
    secure: options.smtp.secure === 'ssl',
    auth: options.smtp.user ? { user: options.smtp.user, pass: options.smtp.pass } : undefined,
    tls: options.smtp.secure === 'tls' ? { rejectUnauthorized: true } : undefined,
  })

  const loginUrl = options.appUrl ? `${options.appUrl.replace(/\/+$/, '')}/login` : ''
  const subject = `IMS ready: ${options.domain}`
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin-bottom:12px">IMS deployment complete</h2>
      <p>A fresh IMS instance is ready.</p>
      <table cellpadding="6" cellspacing="0" border="0">
        <tr><td><strong>Domain</strong></td><td>${options.domain}</td></tr>
        <tr><td><strong>Login URL</strong></td><td>${loginUrl || options.appUrl || options.domain}</td></tr>
        <tr><td><strong>User</strong></td><td>${options.admin.email}</td></tr>
        <tr><td><strong>Password</strong></td><td>${options.admin.password}</td></tr>
      </table>
      <p>Change this password after first login.</p>
    </div>
  `

  await transport.sendMail({
    from: options.smtp.fromName
      ? { name: options.smtp.fromName, address: options.smtp.fromEmail }
      : options.smtp.fromEmail,
    replyTo: options.smtp.replyTo || undefined,
    to: options.notificationEmail,
    subject,
    html,
  })
}

async function main() {
  const databaseUrl = getEnv('DATABASE_URL', { required: true })
  const defaultAdminEmail = getEnv('DEFAULT_ADMIN_EMAIL')
  const defaultAdminName = getEnv('DEFAULT_ADMIN_NAME', { fallback: 'IMS Admin' })
  const defaultAdminPassword = getEnv('DEFAULT_ADMIN_PASSWORD')
  const notificationEmail = getEnv('NOTIFICATION_EMAIL')
  const publicAppUrl = getEnv('PUBLIC_APP_URL')
  const domain = getEnv('APP_DOMAIN', { fallback: publicAppUrl.replace(/^https?:\/\//, '') })

  const smtp = {
    host: getEnv('SMTP_HOST'),
    port: getEnv('SMTP_PORT', { fallback: '587' }),
    user: getEnv('SMTP_USER'),
    pass: getEnv('SMTP_PASS'),
    secure: getEnv('SMTP_SECURE', { fallback: 'tls' }),
    fromName: getEnv('SMTP_FROM_NAME', { fallback: 'IMS' }),
    fromEmail: getEnv('SMTP_FROM_EMAIL'),
    replyTo: getEnv('SMTP_REPLY_TO'),
  }

  const db = new Client({ connectionString: databaseUrl })
  await db.connect()

  try {
    if (publicAppUrl) {
      await upsertSetting(db, 'public_app_url', publicAppUrl)
    }

    if (smtp.host && smtp.fromEmail) {
      await upsertSetting(db, 'email_smtp_host', smtp.host)
      await upsertSetting(db, 'email_smtp_port', smtp.port)
      await upsertSetting(db, 'email_smtp_user', smtp.user)
      await upsertSetting(db, 'email_smtp_pass', smtp.pass)
      await upsertSetting(db, 'email_smtp_secure', smtp.secure)
      await upsertSetting(db, 'email_from_name', smtp.fromName)
      await upsertSetting(db, 'email_from_email', smtp.fromEmail)
      await upsertSetting(db, 'email_reply_to', smtp.replyTo)
      console.log(`[INFO] SMTP settings stored for ${maskEmail(smtp.fromEmail)}.`)
    }

    if (!defaultAdminEmail || !defaultAdminPassword) {
      console.log('[INFO] No default admin credentials supplied; skipping admin bootstrap.')
      return
    }

    const adminResult = await provisionDefaultAdmin(db, {
      email: defaultAdminEmail,
      name: defaultAdminName,
      password: defaultAdminPassword,
    })

    console.log(
      `[INFO] Default admin ${adminResult.created ? 'created' : 'updated'}: ${maskEmail(defaultAdminEmail)}.`,
    )

    await sendProvisioningEmail({
      smtp,
      notificationEmail,
      publicAppUrl,
      appUrl: publicAppUrl,
      domain,
      admin: {
        email: defaultAdminEmail,
        password: defaultAdminPassword,
      },
    })

    if (notificationEmail) {
      console.log(`[INFO] Provisioning email sent to ${maskEmail(notificationEmail)}.`)
    }
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error('[ERROR]', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
