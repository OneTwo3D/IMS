/**
 * Pure crontab-block generation and inspection for the managed scheduler
 * (onetwo3d-ims-ryxy). Extracted from app/actions/cron.ts so the block format
 * and drift detection are unit-testable.
 *
 * Root cause of ryxy: syncCrontab embedded the CRON_SECRET literal in the
 * crontab, so an env rotation silently 401'd every managed job until the next
 * manual sync. The installer never had this class of failure because its cron
 * lines read the secret from .env AT RUNTIME (scripts/install.sh) — the block
 * builder now emits that pattern, but ONLY when a Node-side emulation of the
 * exact shell pipeline proves the .env yields the ACTIVE process secret
 * byte-for-byte; every other case (no .env, exotic formats, service-manager
 * override) falls back to embedding the current literal.
 */

export const OTI_CRON_START_MARKER = '# --- OTI CRON START ---'
export const OTI_CRON_END_MARKER = '# --- OTI CRON END ---'

// Marker detection tolerant of trailing whitespace / CR (Codex r5: exact
// equality left whitespace- or CRLF-suffixed markers unmatched, so old blocks
// survived as live duplicates).
const START_MARKER_RE = /^# --- OTI CRON START ---[ \t\r]*$/
const END_MARKER_RE = /^# --- OTI CRON END ---[ \t\r]*$/

/**
 * Strip EVERY complete OTI block (START…END pair) and any stray unpaired marker
 * line from a crontab, preserving all other lines verbatim (Codex r5). Handles
 * multiple blocks, END-before-START, and an unclosed START (which drops only
 * the stray marker, never the lines after it — no data loss). Shared shape with
 * the installer's awk reconciliation so both are consistent.
 */
export function stripOtiBlocks(crontabText: string): string {
  const lines = crontabText.split('\n')
  const drop = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i += 1) {
    if (!START_MARKER_RE.test(lines[i])) continue
    // find the next END after this START
    let j = i + 1
    while (j < lines.length && !END_MARKER_RE.test(lines[j])) j += 1
    if (j < lines.length) {
      for (let k = i; k <= j; k += 1) drop[k] = true
      i = j
    }
    // unclosed START: leave the range; the stray marker is dropped below
  }
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (drop[i]) continue
    if (START_MARKER_RE.test(lines[i]) || END_MARKER_RE.test(lines[i])) continue
    kept.push(lines[i])
  }
  return kept.join('\n')
}

// Strict cron expression validation: 5 fields, only digits / * / , / - / /
const CRON_RE = /^(\*|(\*\/)?[0-9]+([,-][0-9]+)*)( (\*|(\*\/)?[0-9]+([,-][0-9]+)*)){4}$/

export type CrontabJobDef = {
  slug: string
  settingKey: string
  label: string
  defaultSchedule: string
  defaultEnabled: boolean
  legacyEnabledKey?: string
}

export type CrontabSecretRef =
  | { kind: 'env-file'; envFilePath: string }
  | { kind: 'literal'; secret: string }

/**
 * Default cron log path — the installer creates and chowns `/var/log/
 * one-two-inventory` to the app user and logrotates `*.log` there (Codex r2:
 * the old `/var/log/oti-cron.log` sat in root-owned /var/log, so the append
 * redirect failed BEFORE curl ran on a clean install). Overridable via
 * OTI_CRON_LOG_PATH for non-standard deployments.
 */
export const DEFAULT_CRON_LOG_PATH = '/var/log/one-two-inventory/cron.log'

export type BuildOtiCrontabBlockResult =
  | { ok: true; lines: string[] }
  | { ok: false; error: string }

/**
 * Node-side emulation of the EXACT shell pipeline the cron lines run
 * (`grep -m1 '^CRON_SECRET=' file | cut -d= -f2- | tr -d '"'`). Runtime mode
 * is only chosen when this emulation yields a value byte-equal to the ACTIVE
 * process secret (Codex: line-presence alone selected runtime mode even when
 * the .env value was stale, single-quoted, commented, CRLF, or shadowed by a
 * service-manager override — every managed job would then send a wrong or
 * corrupted bearer). Returns null when no line matches.
 */
export function emulateRuntimeSecretExtraction(envFileContent: string): string | null {
  // GNU grep treats input containing a NUL as binary and prints only "Binary
  // file … matches" instead of the line — the pipeline then yields the wrong
  // value (Codex r2). Refuse to match binary content so runtime mode is never
  // chosen when the real shell pipeline would diverge; literal mode is used.
  if (envFileContent.includes('\u0000')) return null
  // grep '^CRON_SECRET=' matches per \n-separated line; a CRLF file keeps its \r
  // (so equality with the clean process value fails → literal fallback).
  const line = envFileContent.split('\n').find((entry) => entry.startsWith('CRON_SECRET='))
  if (line === undefined) return null
  // cut -d= -f2- : everything after the first '='; tr -d '"' : drop ALL double quotes.
  // $(...) strips trailing newlines only — split already consumed them.
  return line.slice('CRON_SECRET='.length).replaceAll('"', '')
}

/**
 * Characters cron or the crontab format treat specially in command text:
 * % (cron splits the line and feeds the rest to stdin, even inside quotes),
 * CR/LF and other control characters (structurally corrupt the crontab), and
 * the single quote our shell quoting relies on.
 */
export function isCronSafePath(filePath: string): boolean {
  return !/['%\u0000-\u001f\u007f]/.test(filePath)
}

/**
 * A secret is safe to embed as `CRON_SECRET="…"` only if it can't break out of
 * that double-quoted crontab env-assignment (Codex r4): a `"` closes the quote,
 * a backslash/backtick/`$` can inject, and CR/LF splits the crontab into new
 * lines. Installer secrets are hex (openssl rand) so this never trips in
 * practice; it guards a hand-set secret from corrupting the whole crontab.
 */
export function isCrontabEmbeddableSecret(secret: string): boolean {
  return !/["\\`$\r\n]/.test(secret)
}

/**
 * Runtime secret read for a cron job line: greps the CRON_SECRET line out of
 * the app's .env when the job FIRES, so a secret rotation (env edit + service
 * restart) needs no crontab re-sync. tr strips optional double quotes — the
 * installer writes the value unquoted but hand-maintained .env files often
 * quote it. The [ -n ] guard stops the job when extraction yields nothing
 * (Codex: the pipeline exits 0 even when the file or line is missing, so an
 * empty bearer would otherwise still be sent).
 */
function runtimeSecretPrefix(envFilePath: string): string {
  return `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${envFilePath}' | cut -d= -f2- | tr -d '"') && [ -n "$CRON_SECRET" ] && `
}

export function buildOtiCrontabBlock(params: {
  jobs: CrontabJobDef[]
  settings: Map<string, string>
  secretRef: CrontabSecretRef
  baseUrl: string
  logPath?: string
}): BuildOtiCrontabBlockResult {
  const { jobs, settings, secretRef, baseUrl } = params
  const logPath = params.logPath ?? DEFAULT_CRON_LOG_PATH

  if (secretRef.kind === 'env-file' && !isCronSafePath(secretRef.envFilePath)) {
    return { ok: false, error: 'App .env path contains characters cron cannot carry safely (quote, %, or control characters).' }
  }
  if (!isCronSafePath(logPath)) {
    return { ok: false, error: 'Cron log path contains characters cron cannot carry safely (quote, %, or control characters).' }
  }
  if (secretRef.kind === 'literal' && !isCrontabEmbeddableSecret(secretRef.secret)) {
    return { ok: false, error: 'Cron secret contains characters that cannot be safely embedded in the crontab (quote, backslash, backtick, $, or newline); rotate to a hex/base64 secret.' }
  }

  const lines: string[] = [
    OTI_CRON_START_MARKER,
    '# Managed by One Two Inventory — do not edit manually',
  ]
  if (secretRef.kind === 'literal') {
    lines.push(`CRON_SECRET="${secretRef.secret}"`)
  } else {
    lines.push(`# CRON_SECRET is read from ${secretRef.envFilePath} at runtime — rotating it needs no crontab re-sync.`)
  }
  lines.push(`BASE_URL="${baseUrl}/api/cron"`, '')

  const commandPrefix = secretRef.kind === 'env-file' ? runtimeSecretPrefix(secretRef.envFilePath) : ''

  for (const job of jobs) {
    const cronEnabled = settings.get(`cron_${job.settingKey}_enabled`)
    let enabled: boolean
    if (cronEnabled !== undefined) {
      enabled = cronEnabled === 'true'
    } else if (job.legacyEnabledKey) {
      enabled = settings.get(job.legacyEnabledKey) === 'true'
    } else {
      enabled = job.defaultEnabled
    }
    if (!enabled) continue

    const schedule = settings.get(`cron_${job.settingKey}_schedule`) ?? job.defaultSchedule
    if (!CRON_RE.test(schedule)) {
      return { ok: false, error: `Invalid cron schedule for ${job.label}: "${schedule}"` }
    }

    lines.push(
      `# ${job.label}`,
      // logPath is single-quoted (Codex r3: unquoted, a log path with a space
      // or shell operator ran arbitrary commands via the redirect); the ' and
      // % and control chars it can't survive are already rejected above.
      `${schedule}  ${commandPrefix}curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${job.slug}" >> '${logPath}' 2>&1`,
      '',
    )
  }

  lines.push(OTI_CRON_END_MARKER)
  return { ok: true, lines }
}

/**
 * Replace the OTI block, preserving every non-OTI line. Strips ALL existing
 * complete blocks + stray markers first (Codex r5: the old indexOf approach
 * mishandled END-before-START, multiple blocks, and whitespace/CRLF markers —
 * duplicating or corrupting operator lines across repeated saves), then appends
 * the fresh block. Idempotent.
 */
export function spliceOtiBlock(existingCrontab: string, blockLines: string[]): string {
  const preserved = stripOtiBlocks(existingCrontab).replace(/\n+$/, '')
  const prefix = preserved.length > 0 ? preserved + '\n' : ''
  return prefix + blockLines.join('\n') + '\n'
}

export type OtiCrontabStatus = {
  blockPresent: boolean
  /**
   * How the block sources its secret. 'none' = no block; 'unknown' = a block
   * exists but has neither an embedded literal nor a runtime extraction
   * command (malformed/hand-edited — Codex r2).
   */
  secretMode: 'runtime-env' | 'embedded' | 'unknown' | 'none'
  /** Embedded mode only: does the literal match the CURRENT env secret? null otherwise. */
  embeddedSecretMatches: boolean | null
  /** Runtime-env mode only: the .env path the cron command actually reads (so the caller checks the RIGHT file, not an assumed cwd). null otherwise. */
  runtimeEnvPath: string | null
  /** Managed job lines inside the block. */
  managedJobCount: number
  /** Cron-API job lines OUTSIDE the markers — a legacy/hand-written block that will drift (ryxy). */
  unmanagedCronApiLines: number
}

/** Inspect a crontab text for the managed block and the drift conditions of ryxy. */
export function parseOtiCrontabStatus(crontabText: string, currentSecret: string | null): OtiCrontabStatus {
  const startIdx = crontabText.indexOf(OTI_CRON_START_MARKER)
  const endIdx = crontabText.indexOf(OTI_CRON_END_MARKER)
  const blockPresent = startIdx !== -1 && endIdx !== -1 && endIdx > startIdx

  const block = blockPresent ? crontabText.slice(startIdx, endIdx) : ''
  const outside = blockPresent
    ? crontabText.slice(0, startIdx) + crontabText.slice(endIdx + OTI_CRON_END_MARKER.length)
    : crontabText

  const isJobLine = (line: string) => (/\/api\/cron\//.test(line) || /\$BASE_URL\//.test(line)) && !line.trim().startsWith('#')
  // The FULL extraction pipeline, ANCHORED as the command's first token —
  // right after the 5-field cron schedule (Codex r3/r4/r5): matching only the
  // grep fragment, an empty '' path, or the pipeline buried inside an
  // `echo "…"` all misclassified as healthy runtime. \S+ and \s+ don't overlap
  // so the {5} quantifier can't backtrack catastrophically.
  const RUNTIME_CMD = /^\s*\S+(?:\s+\S+){4}\s+CRON_SECRET=\$\(grep -m1 '\^CRON_SECRET=' '([^']+)' \| cut -d= -f2- \| tr -d '"'\)/
  const blockJobLines = block.split('\n').filter(isJobLine)
  const managedJobCount = blockJobLines.length
  const unmanagedCronApiLines = outside.split('\n').filter(isJobLine).length

  let secretMode: OtiCrontabStatus['secretMode'] = 'none'
  let embeddedSecretMatches: boolean | null = null
  let runtimeEnvPath: string | null = null
  if (blockPresent) {
    // Classify the JOB LINES' secret source first, so a hybrid block (a
    // top-level embedded literal AND job lines that read the .env at runtime)
    // is 'unknown', not falsely healthy (Codex r4).
    const runtimePaths = new Set<string>()
    let allRuntime = blockJobLines.length > 0
    let anyRuntime = false
    for (const line of blockJobLines) {
      const m = line.match(RUNTIME_CMD)
      if (m) { runtimePaths.add(m[1]); anyRuntime = true }
      else allRuntime = false
    }

    const embedded = block.match(/^CRON_SECRET="(.*)"$/m)
    if (blockJobLines.length === 0) {
      // No jobs to run or drift (all disabled) — benign (Codex r5: this valid
      // state was mis-flagged 'unknown'). Reflect whichever secret line exists.
      if (embedded) {
        secretMode = 'embedded'
        embeddedSecretMatches = currentSecret !== null && embedded[1] === currentSecret
      } else {
        secretMode = 'runtime-env'
      }
    } else if (allRuntime && runtimePaths.size === 1) {
      // Every job line reads the same .env at runtime (an embedded literal, if
      // any, is stale leftover and ignored).
      secretMode = 'runtime-env'
      runtimeEnvPath = [...runtimePaths][0]
    } else if (embedded && !anyRuntime) {
      // Top-level literal AND every job line uses $CRON_SECRET from it.
      secretMode = 'embedded'
      embeddedSecretMatches = currentSecret !== null && embedded[1] === currentSecret
    } else {
      // Mixed, partial, or otherwise unrecognizable — malformed.
      secretMode = 'unknown'
    }
  }

  return { blockPresent, secretMode, embeddedSecretMatches, runtimeEnvPath, managedJobCount, unmanagedCronApiLines }
}
