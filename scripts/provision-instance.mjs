#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import bcrypt from 'bcryptjs'
import nodemailer from 'nodemailer'
import pg from 'pg'

import { pgConnectionConfig, pinClientToMeasuredBackend } from '../lib/db/database-url-schema.mjs'

const { Client } = pg

/**
 * THE CLIENT THIS SCRIPT SEEDS THROUGH, ON THE SAME SCHEMA THE APPLICATION RUNS ON
 * (o3d-2k5r r12, Codex HIGH).
 *
 * Every statement below names its tables UNQUALIFIED — `settings`, `users` — so the schema they
 * land in is whatever search path the connection was opened with. This used to be
 * `new Client({ connectionString: databaseUrl })`, and `?schema=` is a PRISMA-ONLY query
 * parameter: node-postgres discards it. On a `?schema=TenantA` deployment the runtime is pinned to
 * `TenantA` and this writer went to the login role's default search path instead — the admin
 * account, the SMTP settings and the plaintext WooCommerce consumer secret seeded into one schema
 * while the application reads another. On a multi-schema database that is one tenant's credentials
 * written into another tenant's schema; on a single-tenant one it is an installation that reports
 * success and then presents an unconfigured connector and no admin to log in as.
 *
 * `pgConnectionConfig()` is the one place that decision is made, for all four runtime consumers
 * (see lib/db/database-url-schema.mjs). It is spread FIRST and carries the connection string with
 * it: `pg` parses `connectionString` after the surrounding config, so an `options=` left inside the
 * URL would overwrite a search path set beside it.
 *
 * THE IMPORT IS STATIC ON PURPOSE. `scripts/install.sh` falls back to a bare
 * `/root/provision-instance.mjs` when the application directory has no copy; a standalone file
 * cannot reach the shared resolver (nor `pg`, which it already imports from the app's
 * node_modules), so it now fails to load instead of connecting unpinned. Refusing to run is the
 * correct outcome for a seeder that cannot know which schema it is seeding.
 *
 * @param {string} databaseUrl
 * @returns {import('pg').Client}
 */
export function provisioningClient(databaseUrl) {
  // `pinClientToMeasuredBackend` wraps `connect()` so a seeder cannot write into a schema resolved
  // by a backend the deployment probe is not about (o3d-2k5r r22). It is a no-op for an ASCII pin,
  // and it is applied HERE rather than at the caller so the one place that builds this client is
  // also the one place that guards it.
  const config = pgConnectionConfig(databaseUrl)
  return pinClientToMeasuredBackend(new Client({ ...config }), config)
}

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

/**
 * Write a setting ONLY if it does not exist yet (o3d-ecbj, o3d-esha).
 *
 * A seed is not an override. `upsertSetting` above overwrites, which is correct for a
 * first-run bootstrap but wrong for anything an operator can edit afterwards: re-running
 * the installer against an existing instance would silently undo their change. Insert-only
 * means the environment supplies the value once and the Settings UI owns it from then on.
 */
export async function seedSetting(db, key, value) {
  if (!value) return false
  const result = await db.query(
    `
      insert into settings (key, value, "updatedAt")
      values ($1, $2, now())
      on conflict (key) do nothing
    `,
    [key, value],
  )
  return result.rowCount > 0
}

/**
 * The WooCommerce store URL as the app stores it: origin + path, no trailing
 * slash (wcFetch appends `/wp-json/wc/v3/...`). Returns '' for anything that is
 * not an http(s) URL, so a mistyped installer answer is skipped rather than
 * seeded into a connector that would then fail every call.
 */
export function normaliseStoreUrl(raw) {
  if (!raw) return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
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

  // Install-time SEED only, never an override: WC_STORE_URL is written into
  // every .env by scripts/install.sh, so treating it as a runtime override would
  // repoint an upgraded installation at whatever store it was first installed
  // against (o3d-esha; see lib/settings-store.ts).
  const wcStoreUrl = normaliseStoreUrl(getEnv('WC_STORE_URL'))

  const db = provisioningClient(databaseUrl)
  await db.connect()

  try {
    if (publicAppUrl) {
      await upsertSetting(db, 'public_app_url', publicAppUrl)
    }

    // Install-time SEED only, never a runtime override (o3d-ecbj; see the note in
    // lib/settings-store.ts). scripts/install.sh PROMPTS for these two and writes them into
    // every .env, so treating them as overrides pinned an installation to the credentials
    // typed at install time — and only half of the connector honoured them, so an operator
    // who rotated the key in Settings had orders importing under one credential while stock
    // pushed under the other.
    //
    // The secret is seeded in PLAINTEXT: this script has no access to the app's
    // settings-encryption key. `wc_consumer_secret` is a SENSITIVE_SETTING_KEY, so the
    // settings store re-writes it as ciphertext on the first read once SETTINGS_ENCRYPTION_KEY
    // is present (migrateEncryptedSettingValue), and decryption tolerates a plaintext row
    // until then. Do not switch this to upsertSetting: that would re-plaintext a rotated,
    // encrypted secret on every installer re-run.
    for (const [key, envName] of [
      ['wc_consumer_key', 'WC_CONSUMER_KEY'],
      ['wc_consumer_secret', 'WC_CONSUMER_SECRET'],
    ]) {
      const value = getEnv(envName)
      if (!value) continue
      const seeded = await seedSetting(db, key, value)
      console.log(
        seeded
          ? `[INFO] WooCommerce ${key} seeded from ${envName}.`
          : `[INFO] WooCommerce ${key} already set in Settings; ${envName} left unapplied.`,
      )
    }

    // AND THE STORE URL, seeded HERE and only here (o3d-esha). o3d-ecbj deliberately left this
    // out and said so: `wc_url` had no environment fallback then, and the seed belonged to the
    // change that owns WC_STORE_URL. This is that change, so the seed lands here — one seed, one
    // normalisation (`normaliseStoreUrl` above). Two independent seeds for the same setting, with
    // two independent ideas of how to normalise a URL, is the drift both issues were about.
    if (wcStoreUrl) {
      const seeded = await seedSetting(db, 'wc_url', wcStoreUrl)
      console.log(
        seeded
          ? `[INFO] WooCommerce store URL seeded from WC_STORE_URL: ${wcStoreUrl}.`
          : '[INFO] WooCommerce store URL already set in Settings; WC_STORE_URL left unapplied.',
      )
    }

    // The credentials can still be present while the URL is not — a mistyped WC_STORE_URL is
    // skipped by `normaliseStoreUrl` rather than seeded — which reads to an operator as a
    // configured connector that silently cannot reach anything. So say so.
    const wcRows = await db.query(
      `select key from settings where key in ('wc_url', 'wc_consumer_key', 'wc_consumer_secret')`,
    )
    const present = new Set(wcRows.rows.map((row) => row.key))
    if (present.has('wc_consumer_key') && !present.has('wc_url')) {
      console.log(
        '[WARN] WooCommerce credentials are stored but no store URL is. The connector cannot reach '
        + 'the store until Settings -> Sync -> WooCommerce -> Connection has the store URL.',
      )
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

// Only provision when run as a script. Exporting the helpers above lets the
// seed rules be unit-tested without a database; without this guard the import
// alone would try to connect to one.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('[ERROR]', error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
