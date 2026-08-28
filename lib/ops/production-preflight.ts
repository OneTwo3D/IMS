import { stat, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  INSTANCE_ROLE_ENV_VAR,
  instanceRoleOptions,
  invalidInstanceRoleRefusal,
  readInstanceIdentity,
  undeclaredInstanceNotice,
} from '@/lib/ops/instance-identity'
import { checkFileScanHealth, type FileScanResult } from '@/lib/security/file-scan'
import { RETIRED_ENV_VARS } from '@/lib/ops/retired-env-vars'
import {
  missingWmsPushStates,
  pgConnectionConfig,
  WMS_PUSH_STATE_COLUMN,
  WMS_PUSH_STATE_ENUM,
  WMS_PUSH_STATE_ENUM_LABELS_SQL,
  WMS_PUSH_STATE_TABLE,
  wmsPushStateSchemaRefusal,
} from '@/lib/domain/wms/push-state-schema-gate'

export type PreflightStatus = 'pass' | 'fail' | 'warn'

export type PreflightCheck = {
  id: string
  name: string
  status: PreflightStatus
  message: string
}

export type PreflightResult = {
  ok: boolean
  checks: PreflightCheck[]
}

type Env = Record<string, string | undefined>

type PreflightOptions = {
  env?: Env
  scanHealth?: (env: Env) => Promise<FileScanResult>
  dbConnect?: (databaseUrl: string) => Promise<void>
  /**
   * o3d-1izw: the database's OWN labels for the type `wms_order_push_links.state` is declared as.
   * Injected so the check is testable without a server; the default asks the SHARED, column-
   * anchored statement over the same connection string the connectivity check uses.
   */
  readWmsPushStates?: (databaseUrl: string) => Promise<readonly string[]>
}

const PLACEHOLDER_SUBSTRING_PATTERN = /(change[-_ ]?(me|this|it|in[-_ ]?production)|please[-_ ]?change|(^|[-_ ])(dev|test|sample|placeholder|dummy|changeme)[-_ ]?secret|replace[-_ ]?me|example|yourdomain\.com|your[-_ ]?(secret|password|token)|<[^>]+>|\[[^\]]+\]|__[^_]+__)/i
const PLACEHOLDER_EXACT_VALUES = new Set(['secret', 'password', 'password123', 'admin', 'test', 'todo'])

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function add(checks: PreflightCheck[], status: PreflightStatus, id: string, name: string, message: string): void {
  checks.push({ id, name, status, message })
}

function envValue(env: Env, name: string): string {
  return env[name]?.trim() ?? ''
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  return PLACEHOLDER_SUBSTRING_PATTERN.test(trimmed)
    || PLACEHOLDER_EXACT_VALUES.has(normalized)
    || /^x{3,}$/.test(normalized)
}

function hasUsableSecret(env: Env, names: readonly string[], minLength = 32): boolean {
  return names.some((name) => {
    const value = envValue(env, name)
    return value.length >= minLength && !isPlaceholderValue(value)
  })
}

function checkSecret(checks: PreflightCheck[], env: Env, id: string, names: readonly string[], label: string, minLength = 32): void {
  if (hasUsableSecret(env, names, minLength)) {
    add(checks, 'pass', id, names.join('/'), `${label} is configured.`)
    return
  }
  add(checks, 'fail', id, names.join('/'), `${label} is missing, too short, or still uses a placeholder value.`)
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0
}

function checkSettingsEncryptionKey(checks: PreflightCheck[], env: Env): void {
  const value = envValue(env, 'SETTINGS_ENCRYPTION_KEY')
  if (!value || isPlaceholderValue(value)) {
    add(checks, 'fail', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is missing or still uses a placeholder value.')
    return
  }

  if (Buffer.byteLength(value, 'utf8') === 32) {
    add(checks, 'pass', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is configured as a 32-byte raw key.')
    return
  }

  // audit-gzz2: a 64-char hex key (openssl rand -hex 32) is 32 bytes. Checked
  // before base64 because hex chars are also valid base64 (but decode to 48 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    add(checks, 'pass', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is configured as a 64-character hex (32-byte) key.')
    return
  }

  if (looksLikeBase64(value)) {
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === 32) {
      add(checks, 'pass', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is configured as a 32-byte base64 key.')
      return
    }
    add(checks, 'fail', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key looks like base64 but does not decode to 32 bytes; use openssl rand -base64 32.')
    return
  }

  if (value.length >= 32) {
    add(checks, 'fail', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key must be exactly 32 raw bytes or base64 that decodes to 32 bytes.')
  } else {
    add(checks, 'fail', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is too short.')
  }
}

function parseRequiredUrl(checks: PreflightCheck[], env: Env, name: string): URL | null {
  const raw = envValue(env, name)
  const id = name === 'AUTH_URL' ? 'auth-url' : 'app-url'
  if (!raw) {
    add(checks, 'fail', id, name, `${name} is required in production.`)
    return null
  }
  if (isPlaceholderValue(raw)) {
    add(checks, 'fail', id, name, `${name} still uses a placeholder value.`)
    return null
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    add(checks, 'fail', id, name, `${name} must be an absolute URL.`)
    return null
  }

  if (url.protocol !== 'https:') {
    add(checks, 'fail', id, name, `${name} must use https in production.`)
    return null
  }
  add(checks, 'pass', id, name, `${name} is configured.`)
  return url
}

function checkDatabaseUrl(checks: PreflightCheck[], env: Env): string | null {
  const raw = envValue(env, 'DATABASE_URL')
  if (!raw) {
    add(checks, 'fail', 'database-url', 'DATABASE_URL', 'DATABASE_URL is required in production.')
    return null
  }
  if (isPlaceholderValue(raw)) {
    add(checks, 'fail', 'database-url', 'DATABASE_URL', 'DATABASE_URL still uses a placeholder value.')
    return null
  }

  try {
    const url = new URL(raw)
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
      add(checks, 'fail', 'database-url', 'DATABASE_URL', 'DATABASE_URL must be a PostgreSQL connection URL.')
      return null
    }
    const dbName = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    if (!url.hostname || !dbName) {
      add(checks, 'fail', 'database-url', 'DATABASE_URL', 'DATABASE_URL must include a host and database name.')
      return null
    }
    if (dbName === 'postgres' || dbName === 'template1') {
      add(checks, 'warn', 'database-url', 'DATABASE_URL', `DATABASE_URL points at the '${dbName}' admin database; verify this is intentional.`)
      return raw
    }
    add(checks, 'pass', 'database-url', 'DATABASE_URL', 'DATABASE_URL is configured.')
    return raw
  } catch {
    add(checks, 'fail', 'database-url', 'DATABASE_URL', 'DATABASE_URL must be a valid PostgreSQL connection URL.')
    return null
  }
}

async function checkDatabaseConnectivity(
  checks: PreflightCheck[],
  env: Env,
  databaseUrl: string | null,
  dbConnect?: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  if (!isTruthy(env.PREFLIGHT_DB_CONNECT)) return
  if (!databaseUrl) {
    add(checks, 'fail', 'database-connectivity', 'PREFLIGHT_DB_CONNECT', 'Database connectivity check requested but DATABASE_URL is invalid.')
    return
  }

  try {
    if (dbConnect) {
      await dbConnect(databaseUrl)
    } else {
      const { Client } = await import('pg')
      const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 })
      try {
        await client.connect()
        await client.query('SELECT 1')
      } finally {
        await client.end().catch(() => undefined)
      }
    }
    add(checks, 'pass', 'database-connectivity', 'PREFLIGHT_DB_CONNECT', 'Database connectivity check passed.')
  } catch {
    add(checks, 'fail', 'database-connectivity', 'PREFLIGHT_DB_CONNECT', 'Database connectivity check failed.')
  }
}

/**
 * o3d-1izw — CAN THIS BUILD WRITE WHAT IT IS ABOUT TO WRITE?
 *
 * Asked of the COLUMN the value would be written to, via the one statement the runtime gate and the
 * deploy check also use. Identifying the enum by name would let a same-named type in an unrelated
 * schema pass all three at once — the gates are only independent if the question is right.
 *
 * A deploy that applied its migrations cannot fail this. A deploy that skipped them can, and so can
 * an environment served straight from a working tree — the two ways this branch reaches a database
 * that has never heard of `AMBIGUOUS_CREATE`. Without it the discovery is made by Postgres, inside
 * the create claim that writes the value, once per sweep for ever.
 *
 * Rides on PREFLIGHT_DB_CONNECT because it needs the same live connection, and fails rather than
 * warns: the WMS order-push sweep refuses to run at all in this state, which is an outage of
 * fulfilment, not a nit.
 */
async function checkWmsPushStateSchema(
  checks: PreflightCheck[],
  env: Env,
  databaseUrl: string | null,
  readWmsPushStates?: (databaseUrl: string) => Promise<readonly string[]>,
): Promise<void> {
  if (!isTruthy(env.PREFLIGHT_DB_CONNECT)) return
  if (!databaseUrl) return

  let labels: readonly string[]
  try {
    if (readWmsPushStates) {
      labels = await readWmsPushStates(databaseUrl)
    } else {
      // o3d-2k5r r19 — settle the non-ASCII startup-byte question against THIS server before the
      // connection config is composed from the URL. A URL with no such bytes opens nothing; where
      // there are some, the verdict this leaves behind is what pgConnectionConfig() consults, so a
      // schema this deployment cannot carry is reported here with the rename procedure attached
      // rather than as an opaque "could not read the catalogue".
      const { establishStartupOptionByteSafety, nonAsciiStartupOptionCharacters } = await import(
        '../db/database-url-schema.mjs'
      )
      if (nonAsciiStartupOptionCharacters(databaseUrl) !== '') {
        await establishStartupOptionByteSafety(databaseUrl)
      }

      const { Client } = await import('pg')
      // The search path is aligned with Prisma's deliberately: this check opens its OWN connection,
      // and the shared statement resolves the table through whatever search path the asking
      // connection has. A preflight that resolved `wms_order_push_links` to a different table from
      // the application it is vouching for would be answering about the wrong object.
      // The spread comes FIRST and carries the connection string with it: `pg` parses
      // `connectionString` after the surrounding config, so an `options=` left inside the URL
      // would overwrite the search path composed beside it (o3d-2k5r r10).
      const client = new Client({
        ...pgConnectionConfig(databaseUrl),
        connectionTimeoutMillis: 5_000,
      })
      try {
        await client.connect()
        const result = await client.query<{ enumlabel: string }>(
          WMS_PUSH_STATE_ENUM_LABELS_SQL,
          [WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN],
        )
        labels = result.rows.map((row) => row.enumlabel)
      } finally {
        await client.end().catch(() => undefined)
      }
    }
  } catch (error) {
    // An unreadable catalogue is not a clean one — and neither is a DATABASE_URL that names two
    // schemas, which throws from the config composition above rather than picking one. The reason
    // is carried through, because "could not read the catalogue" would send an operator looking at
    // the database for a fault that is in the URL.
    const because = error instanceof Error && error.message ? ` (${error.message})` : ''
    add(checks, 'fail', 'wms-push-state-schema', WMS_PUSH_STATE_ENUM, `Could not read the enum ${WMS_PUSH_STATE_TABLE}.${WMS_PUSH_STATE_COLUMN} is declared as, so ${WMS_PUSH_STATE_ENUM} cannot be confirmed to carry what this build writes${because}. Release gate: o3d-1izw.`)
    return
  }

  const missing = missingWmsPushStates(labels)
  if (missing.length > 0) {
    add(checks, 'fail', 'wms-push-state-schema', WMS_PUSH_STATE_ENUM, wmsPushStateSchemaRefusal(missing))
    return
  }
  add(checks, 'pass', 'wms-push-state-schema', WMS_PUSH_STATE_ENUM, `The enum ${WMS_PUSH_STATE_TABLE}.${WMS_PUSH_STATE_COLUMN} is declared as carries every value this build writes.`)
}

async function checkWritableDirectory(checks: PreflightCheck[], label: string, directory: string): Promise<void> {
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) {
      add(checks, 'fail', label, label, `${label} is not a directory: ${directory}`)
      return
    }
  } catch {
    add(checks, 'fail', label, label, `${label} does not exist or is not readable: ${directory}`)
    return
  }

  const probe = path.join(directory, `.ims-preflight-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    await writeFile(probe, 'ok', { flag: 'wx' })
    await unlink(probe)
    add(checks, 'pass', label, label, `${label} exists and is writable.`)
  } catch {
    try {
      await unlink(probe)
    } catch {
      // Best effort cleanup only.
    }
    add(checks, 'fail', label, label, `${label} is not writable by the application process: ${directory}`)
  }
}

function getPreflightStorageDirectories(env: Env): Array<{ label: string; directory: string }> {
  const privateRoot = path.resolve(envValue(env, 'UPLOAD_STORAGE_DIR') || path.join(process.cwd(), 'uploads'))
  const publicRoot = path.resolve(envValue(env, 'PUBLIC_UPLOAD_STORAGE_DIR') || path.join(process.cwd(), 'public', 'uploads'))
  const invoicePdfRoot = path.resolve(envValue(env, 'INVOICE_PDF_STORAGE_DIR') || path.join(process.cwd(), 'data', 'invoices'))
  const backupRoot = path.resolve(envValue(env, 'BACKUP_DIR') || '/var/lib/onetwoinventory/backups')

  return [
    { label: 'avatarUploads', directory: path.join(publicRoot, 'avatars') },
    { label: 'brandingUploads', directory: path.join(publicRoot, 'branding') },
    { label: 'invoiceUploads', directory: path.join(privateRoot, 'invoices') },
    { label: 'invoiceQuarantineUploads', directory: path.join(privateRoot, 'quarantine', 'invoices') },
    { label: 'invoicePdfStorage', directory: invoicePdfRoot },
    { label: 'backupStorage', directory: backupRoot },
  ]
}

function parseProxyEntries(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function isValidCidr(value: string): boolean {
  const [ip, bitsRaw] = value.split('/')
  if (!ip || bitsRaw == null) return false
  const family = isIP(ip)
  if (!family) return false
  const bits = Number(bitsRaw)
  const maxBits = family === 4 ? 32 : 128
  return Number.isInteger(bits) && bits > 0 && bits <= maxBits
}

function checkTrustedProxyConfig(checks: PreflightCheck[], env: Env): void {
  const ips = parseProxyEntries(env.TRUSTED_PROXY_IPS)
  const cidrs = parseProxyEntries(env.TRUSTED_PROXY_CIDRS)
  const proxyRequired = isTruthy(env.REQUIRE_TRUSTED_PROXY_CONFIG) || isTruthy(env.BEHIND_PROXY)

  const invalidIps = ips.filter((entry) => !isIP(entry))
  const invalidCidrs = cidrs.filter((entry) => !isValidCidr(entry))
  if (invalidIps.length > 0 || invalidCidrs.length > 0) {
    add(checks, 'fail', 'trusted-proxy', 'TRUSTED_PROXY_IPS/TRUSTED_PROXY_CIDRS', 'Trusted proxy configuration contains invalid IP, invalid CIDR, or trust-everyone /0 CIDR entries.')
    return
  }

  if (proxyRequired && ips.length === 0 && cidrs.length === 0) {
    add(checks, 'fail', 'trusted-proxy', 'TRUSTED_PROXY_IPS/TRUSTED_PROXY_CIDRS', 'Trusted proxy configuration is required when deployment is marked as behind a proxy.')
    return
  }

  if (ips.length === 0 && cidrs.length === 0) {
    add(checks, 'warn', 'trusted-proxy', 'TRUSTED_PROXY_IPS/TRUSTED_PROXY_CIDRS', 'Trusted proxy configuration is empty; set REQUIRE_TRUSTED_PROXY_CONFIG=true for proxied production deployments.')
    return
  }

  add(checks, 'pass', 'trusted-proxy', 'TRUSTED_PROXY_IPS/TRUSTED_PROXY_CIDRS', 'Trusted proxy configuration is syntactically valid.')
}

async function checkFileScanner(checks: PreflightCheck[], env: Env, scanHealth: (env: Env) => Promise<FileScanResult>): Promise<void> {
  const mode = envValue(env, 'FILE_SCAN_MODE').toLowerCase()
  if (!mode) {
    add(checks, 'fail', 'file-scan-mode', 'FILE_SCAN_MODE', 'FILE_SCAN_MODE must be explicitly set to disabled or command in production.')
    return
  }
  if (mode !== 'disabled' && mode !== 'command') {
    add(checks, 'fail', 'file-scan-mode', 'FILE_SCAN_MODE', 'FILE_SCAN_MODE must be disabled or command.')
    return
  }
  if (mode === 'disabled') {
    add(checks, 'warn', 'file-scan-mode', 'FILE_SCAN_MODE', 'Invoice PDF scanning is explicitly disabled.')
    return
  }

  const result = await scanHealth(env)
  if (result.status === 'clean') {
    add(checks, 'pass', 'file-scan-mode', 'FILE_SCAN_MODE', 'File scanner health check passed.')
    return
  }
  add(checks, 'fail', 'file-scan-mode', 'FILE_SCAN_MODE', `File scanner health check failed with status ${result.status}${result.reason ? ` (${result.reason})` : ''}.`)
}

function checkRestoreFlags(checks: PreflightCheck[], env: Env): void {
  let anyEnabled = false
  if (isTruthy(env.ALLOW_DATABASE_RESTORE)) {
    add(checks, 'fail', 'database-restore', 'ALLOW_DATABASE_RESTORE', 'Database restore is enabled; production preflight requires it to remain disabled by default.')
    anyEnabled = true
  }
  if (isTruthy(env.ALLOW_DATABASE_RESTORE_UPLOAD)) {
    add(checks, 'fail', 'database-restore-upload', 'ALLOW_DATABASE_RESTORE_UPLOAD', 'Uploaded database restore is enabled; production preflight requires it to remain disabled by default.')
    anyEnabled = true
  }
  if (!anyEnabled) add(checks, 'pass', 'database-restore', 'ALLOW_DATABASE_RESTORE', 'Database restore flags are disabled.')
}

/**
 * Does this instance say what it is? (o3d-l89a)
 *
 * This preflight is the one place in the repo that already claims to know what a production instance
 * looks like — it fails on `NODE_ENV !== 'production'` at the top — so it is where the declaration
 * belongs. It is also the only place where asserting it costs a deploy step rather than a money path:
 * preflight is run deliberately, before a release, and never in a request.
 *
 * THE THREE VERDICTS, and why they are not all the same severity:
 *
 *  - Present and NOT `production`: FAIL. Running the production preflight on an instance that has
 *    declared itself stage is a mistake with no benign reading, and no existing host can hit it,
 *    because no existing host sets the variable at all. This is the fail-closed half that ships today.
 *  - Present and unrecognised, or contradicted by `E2E_TEST_MODE=1`: FAIL, for the same reason — the
 *    operator stated something, and what they stated does not say "production".
 *  - ABSENT: WARN. Every instance alive when this shipped is in this state, production included, so
 *    failing here would break the release it is supposed to protect. This is step 1 of the two-step
 *    rollout described in lib/ops/instance-identity.ts; the warning is the thing that gets the line
 *    into production's .env so that step 2 can fail closed on absence.
 */
function checkInstanceRole(checks: PreflightCheck[], env: Env): void {
  const identity = readInstanceIdentity(env)

  if (identity.invalidDeclaration) {
    add(checks, 'fail', 'instance-role', INSTANCE_ROLE_ENV_VAR, invalidInstanceRoleRefusal(identity))
    return
  }

  if (identity.undeclared) {
    add(checks, 'warn', 'instance-role', INSTANCE_ROLE_ENV_VAR, undeclaredInstanceNotice(identity))
    return
  }

  if (identity.e2eTestMode) {
    add(
      checks,
      'fail',
      'instance-role',
      INSTANCE_ROLE_ENV_VAR,
      `${INSTANCE_ROLE_ENV_VAR}=${identity.rawDeclaration} but E2E_TEST_MODE=1 — an end-to-end test rig `
        + 'is never the production instance. Unset E2E_TEST_MODE on the production server, or run this '
        + 'preflight somewhere else.',
    )
    return
  }

  if (identity.declaredRole !== 'production') {
    add(
      checks,
      'fail',
      'instance-role',
      INSTANCE_ROLE_ENV_VAR,
      `${INSTANCE_ROLE_ENV_VAR}=${identity.declaredRole} — this instance has declared itself something `
        + `other than production, so the production preflight does not apply to it. Allowed values: `
        + `${instanceRoleOptions()}.`,
    )
    return
  }

  add(checks, 'pass', 'instance-role', INSTANCE_ROLE_ENV_VAR, 'Instance is declared as production.')
}

function checkRetiredEnvVars(checks: PreflightCheck[], env: Env): void {
  const present = Object.keys(RETIRED_ENV_VARS).filter((name) => envValue(env, name) !== '')
  if (present.length === 0) {
    add(checks, 'pass', 'retired-env-vars', 'Retired environment variables', 'No retired environment variables are set.')
    return
  }
  for (const name of present) {
    add(
      checks,
      'warn',
      `retired-env-var:${name}`,
      name,
      `${name} is set but nothing reads it, so it is not in force. ${RETIRED_ENV_VARS[name]} Remove the line from .env to avoid implying a control that does not exist.`,
    )
  }
}

export async function runProductionPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const env = { ...process.env, ...options.env }
  const checks: PreflightCheck[] = []

  if (env.NODE_ENV !== 'production') {
    add(checks, 'fail', 'node-env', 'NODE_ENV', 'NODE_ENV must be production for production preflight.')
  } else {
    add(checks, 'pass', 'node-env', 'NODE_ENV', 'NODE_ENV is production.')
  }

  checkInstanceRole(checks, env)

  checkSecret(checks, env, 'auth-secret', ['AUTH_SECRET', 'NEXTAUTH_SECRET'], 'Auth session secret')
  checkSecret(checks, env, 'cron-secret', ['CRON_SECRET'], 'Cron bearer secret')
  checkSettingsEncryptionKey(checks, env)
  const databaseUrl = checkDatabaseUrl(checks, env)
  await checkDatabaseConnectivity(checks, env, databaseUrl, options.dbConnect)
  await checkWmsPushStateSchema(checks, env, databaseUrl, options.readWmsPushStates)

  const appUrl = parseRequiredUrl(checks, env, 'NEXT_PUBLIC_APP_URL')
  const authUrl = parseRequiredUrl(checks, env, 'AUTH_URL')
  if (appUrl && authUrl) {
    if (appUrl.origin !== authUrl.origin) {
      add(checks, 'fail', 'auth-url-origin', 'AUTH_URL origin', 'AUTH_URL must have the same origin as NEXT_PUBLIC_APP_URL.')
    } else {
      add(checks, 'pass', 'auth-url-origin', 'AUTH_URL origin', 'AUTH_URL and NEXT_PUBLIC_APP_URL origins match.')
    }
  }

  if (!envValue(env, 'UPLOAD_STORAGE_DIR')) {
    add(checks, 'fail', 'upload-storage-dir', 'UPLOAD_STORAGE_DIR', 'UPLOAD_STORAGE_DIR must be explicitly configured in production.')
  }
  if (!envValue(env, 'PUBLIC_UPLOAD_STORAGE_DIR')) {
    add(checks, 'fail', 'public-upload-storage-dir', 'PUBLIC_UPLOAD_STORAGE_DIR', 'PUBLIC_UPLOAD_STORAGE_DIR must be explicitly configured in production.')
  }
  if (!envValue(env, 'INVOICE_PDF_STORAGE_DIR')) {
    add(checks, 'fail', 'invoice-pdf-storage-dir', 'INVOICE_PDF_STORAGE_DIR', 'INVOICE_PDF_STORAGE_DIR must be explicitly configured in production.')
  }
  if (!envValue(env, 'BACKUP_DIR')) {
    add(checks, 'fail', 'backup-dir', 'BACKUP_DIR', 'BACKUP_DIR must be explicitly configured in production.')
  }

  await Promise.all(
    getPreflightStorageDirectories(env).map(({ label, directory }) => checkWritableDirectory(checks, label, directory)),
  )

  checkTrustedProxyConfig(checks, env)
  await checkFileScanner(checks, env, options.scanHealth ?? ((scanEnv) => checkFileScanHealth({ env: scanEnv })))
  checkRestoreFlags(checks, env)
  checkRetiredEnvVars(checks, env)

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checks,
  }
}

export function formatPreflightResult(result: PreflightResult): string {
  const lines = ['Production preflight results:']
  for (const check of result.checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'
    lines.push(`- ${marker} ${check.name}: ${check.message}`)
  }
  lines.push(result.ok ? 'Production preflight passed.' : 'Production preflight failed.')
  return lines.join(os.EOL)
}
