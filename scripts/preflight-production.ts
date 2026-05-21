#!/usr/bin/env tsx

import { stat, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkFileScanHealth, type FileScanResult } from '../lib/security/file-scan.ts'

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
}

const PLACEHOLDER_SUBSTRING_PATTERN = /(change[-_ ]?me|replace[-_ ]?me|example|yourdomain\.com|your[-_ ]?(secret|password|token)|<[^>]+>|\[[^\]]+\]|__[^_]+__)/i
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

  if (looksLikeBase64(value)) {
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === 32) {
      add(checks, 'pass', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is configured as a 32-byte base64 key.')
      return
    }
    add(checks, 'warn', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key looks like base64 but does not decode to 32 bytes; use openssl rand -base64 32 for new installs.')
    return
  }

  if (value.length >= 32) {
    add(checks, 'warn', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key will use the legacy sha256 derivation fallback; prefer a 32-byte base64 key.')
    return
  }

  add(checks, 'fail', 'settings-encryption-key', 'SETTINGS_ENCRYPTION_KEY', 'Settings encryption key is too short.')
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
  const backupRoot = path.resolve(envValue(env, 'BACKUP_DIR') || '/var/lib/onetwoinventory/backups')

  return [
    { label: 'avatarUploads', directory: path.join(publicRoot, 'avatars') },
    { label: 'brandingUploads', directory: path.join(publicRoot, 'branding') },
    { label: 'invoiceUploads', directory: path.join(privateRoot, 'invoices') },
    { label: 'invoiceQuarantineUploads', directory: path.join(privateRoot, 'quarantine', 'invoices') },
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

function checkLogLevel(checks: PreflightCheck[], env: Env): void {
  if (envValue(env, 'LOG_LEVEL').toLowerCase() === 'debug') {
    add(checks, 'warn', 'log-level', 'LOG_LEVEL', 'LOG_LEVEL is debug in production; revert after incident triage to avoid excessive sensitive metadata in logs.')
    return
  }
  add(checks, 'pass', 'log-level', 'LOG_LEVEL', 'LOG_LEVEL is not debug.')
}

export async function runProductionPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const env = { ...process.env, ...options.env }
  const checks: PreflightCheck[] = []

  if (env.NODE_ENV !== 'production') {
    add(checks, 'fail', 'node-env', 'NODE_ENV', 'NODE_ENV must be production for production preflight.')
  } else {
    add(checks, 'pass', 'node-env', 'NODE_ENV', 'NODE_ENV is production.')
  }

  checkSecret(checks, env, 'auth-secret', ['AUTH_SECRET', 'NEXTAUTH_SECRET'], 'Auth session secret')
  checkSecret(checks, env, 'cron-secret', ['CRON_SECRET'], 'Cron bearer secret')
  checkSettingsEncryptionKey(checks, env)
  const databaseUrl = checkDatabaseUrl(checks, env)
  await checkDatabaseConnectivity(checks, env, databaseUrl, options.dbConnect)

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
  if (!envValue(env, 'BACKUP_DIR')) {
    add(checks, 'fail', 'backup-dir', 'BACKUP_DIR', 'BACKUP_DIR must be explicitly configured in production.')
  }

  await Promise.all(
    getPreflightStorageDirectories(env).map(({ label, directory }) => checkWritableDirectory(checks, label, directory)),
  )

  checkTrustedProxyConfig(checks, env)
  await checkFileScanner(checks, env, options.scanHealth ?? ((scanEnv) => checkFileScanHealth({ env: scanEnv })))
  checkRestoreFlags(checks, env)
  checkLogLevel(checks, env)

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

async function main(): Promise<void> {
  const result = await runProductionPreflight()
  const output = formatPreflightResult(result)
  if (result.ok) {
    console.log(output)
  } else {
    console.error(output)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
