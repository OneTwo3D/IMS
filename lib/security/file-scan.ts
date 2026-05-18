import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type FileScanMode = 'disabled' | 'command'
export type FileScanStatus = 'skipped' | 'clean' | 'infected' | 'error'

export type FileScanResult = {
  mode: FileScanMode
  status: FileScanStatus
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  reason?: 'disabled' | 'missing-command' | 'invalid-command' | 'spawn-error' | 'timeout' | 'nonzero-exit'
  scannerId?: string
}

export type FileScanOptions = {
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

const DEFAULT_SCAN_TIMEOUT_MS = 30_000
const DEFAULT_SCAN_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'] as const
const FILE_SCAN_HEALTH_TIMEOUT_MS = 5_000

const warnedInvalidTimeoutValues = new Set<string>()

function fileScanMode(env: Record<string, string | undefined>): FileScanMode | 'invalid' {
  const raw = String(env.FILE_SCAN_MODE ?? 'disabled').trim().toLowerCase()
  if (raw === '' || raw === 'disabled') return 'disabled'
  if (raw === 'command') return 'command'
  return 'invalid'
}

function scanTimeoutMs(env: Record<string, string | undefined>, override?: number): number {
  if (override && Number.isFinite(override) && override > 0) return override
  const configured = Number.parseInt(String(env.FILE_SCAN_TIMEOUT_MS ?? ''), 10)
  if (Number.isFinite(configured) && configured > 0) return configured

  const raw = env.FILE_SCAN_TIMEOUT_MS?.trim()
  if (raw && !warnedInvalidTimeoutValues.has(raw)) {
    warnedInvalidTimeoutValues.add(raw)
    console.warn(`Invalid FILE_SCAN_TIMEOUT_MS="${raw}"; falling back to ${DEFAULT_SCAN_TIMEOUT_MS}ms.`)
  }
  return DEFAULT_SCAN_TIMEOUT_MS
}

export function parseFileScanCommand(command: string, filePath: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let currentStarted = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      currentStarted = true
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      currentStarted = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      currentStarted = true
      continue
    }
    if (quote === char) {
      quote = null
      currentStarted = true
      continue
    }
    if (!quote && /\s/.test(char)) {
      if (currentStarted) {
        tokens.push(current)
        current = ''
        currentStarted = false
      }
      continue
    }
    current += char
    currentStarted = true
  }

  if (escaped) current += '\\'
  if (quote) return null
  if (currentStarted) tokens.push(current)
  if (tokens.length === 0) return null

  const replaced = tokens.map((token) => token.replace('{file}', filePath))
  if (!tokens.some((token) => token.includes('{file}'))) replaced.push(filePath)
  return replaced
}

export function parseFileScanCommandArgv(commandArgv: string, filePath: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(commandArgv)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== 'string')) return null

  const tokens = parsed as string[]
  const replaced = tokens.map((token) => token.replace('{file}', filePath))
  if (!tokens.some((token) => token.includes('{file}'))) replaced.push(filePath)
  return replaced
}

function scannerIdentifier(env: Record<string, string | undefined>): string | undefined {
  const configuredName = env.FILE_SCAN_NAME?.trim()
  if (configuredName) return configuredName

  const argv = env.FILE_SCAN_COMMAND_ARGV?.trim()
  const command = env.FILE_SCAN_COMMAND?.trim()
  const source = argv || command
  if (!source) return undefined
  return `sha256:${createHash('sha256').update(source).digest('hex').slice(0, 12)}`
}

function resolveFileScanCommand(env: Record<string, string | undefined>, filePath: string): string[] | null {
  const configuredArgv = env.FILE_SCAN_COMMAND_ARGV?.trim()
  if (configuredArgv) return parseFileScanCommandArgv(configuredArgv, filePath)

  const configuredCommand = env.FILE_SCAN_COMMAND?.trim()
  if (!configuredCommand) return null
  return parseFileScanCommand(configuredCommand, filePath)
}

function buildScannerEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const allowlist = (env.FILE_SCAN_ENV_ALLOWLIST ?? DEFAULT_SCAN_ENV_ALLOWLIST.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

  const scannerEnv: NodeJS.ProcessEnv = {
    NODE_ENV: normalizedNodeEnv(env.NODE_ENV ?? process.env.NODE_ENV),
  }
  for (const name of allowlist) {
    const value = env[name]
    if (value !== undefined) scannerEnv[name] = value
  }
  return scannerEnv
}

function normalizedNodeEnv(value: string | undefined): NodeJS.ProcessEnv['NODE_ENV'] {
  if (value === 'development' || value === 'production' || value === 'test') return value
  return 'production'
}

function killScannerProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to killing the direct child if process-group termination fails.
    }
  }
  child.kill('SIGKILL')
}

export async function scanFile(filePath: string, options: FileScanOptions = {}): Promise<FileScanResult> {
  const env = { ...process.env, ...options.env }
  const scannerId = scannerIdentifier(env)
  const mode = fileScanMode(env)
  if (mode === 'disabled') return { mode: 'disabled', status: 'skipped', reason: 'disabled' }
  if (mode === 'invalid') return { mode: 'command', status: 'error', reason: 'invalid-command', scannerId }

  const hasConfiguredCommand = Boolean(env.FILE_SCAN_COMMAND?.trim() || env.FILE_SCAN_COMMAND_ARGV?.trim())
  if (!hasConfiguredCommand) return { mode: 'command', status: 'error', reason: 'missing-command', scannerId }

  const parsed = resolveFileScanCommand(env, filePath)
  if (!parsed) return { mode: 'command', status: 'error', reason: 'invalid-command', scannerId }
  const [command, ...args] = parsed
  if (!command) return { mode: 'command', status: 'error', reason: 'invalid-command', scannerId }

  return new Promise<FileScanResult>((resolve) => {
    const child = spawn(command, args, {
      env: buildScannerEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
    })

    let settled = false
    const settle = (result: FileScanResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      killScannerProcess(child)
      settle({ mode: 'command', status: 'error', reason: 'timeout', scannerId })
    }, scanTimeoutMs(env, options.timeoutMs))

    // Drain scanner output so verbose scanners cannot block on a full pipe.
    // Output is intentionally discarded; audit metadata must not contain file
    // paths, signatures, or scanner-specific payloads.
    child.stdout?.resume()
    child.stderr?.resume()
    child.on('error', () => {
      settle({ mode: 'command', status: 'error', reason: 'spawn-error', scannerId })
    })
    child.on('close', (exitCode, signal) => {
      if (exitCode === 0) {
        settle({ mode: 'command', status: 'clean', exitCode, signal, scannerId })
        return
      }
      settle({ mode: 'command', status: 'infected', exitCode, signal, reason: 'nonzero-exit', scannerId })
    })
  })
}

export async function checkFileScanHealth(options: FileScanOptions = {}): Promise<FileScanResult> {
  const env = { ...process.env, ...options.env }
  const mode = fileScanMode(env)
  if (mode === 'disabled') return { mode: 'disabled', status: 'skipped', reason: 'disabled' }

  const dir = await mkdtemp(path.join(tmpdir(), 'ims-file-scan-health-'))
  try {
    const filePath = path.join(dir, 'health-check.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n% IMS file scan health check\n'))
    return await scanFile(filePath, {
      env,
      timeoutMs: Math.min(scanTimeoutMs(env, options.timeoutMs), FILE_SCAN_HEALTH_TIMEOUT_MS),
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function fileScanAuditMetadata(result: FileScanResult): Record<string, unknown> {
  return {
    scanMode: result.mode,
    scanStatus: result.status,
    scanExitCode: result.exitCode ?? null,
    scanSignal: result.signal ?? null,
    scanReason: result.reason ?? null,
    scanScannerId: result.scannerId ?? null,
  }
}
