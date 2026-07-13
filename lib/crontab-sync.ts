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
 * The exact substring EVERY job line this builder generates contains — a curl
 * sending `Authorization: Bearer $CRON_SECRET` to `$BASE_URL/<slug>` (both
 * runtime and embedded modes; the runtime prefix differs but this tail is
 * identical). The installer's awk uses the IDENTICAL literal via index(), so
 * the two agree exactly (Codex r7). It references our own shell variables, so
 * a coincidental operator match is implausible — but the sweep below is still
 * BOUNDED to a malformed block's region, never global (Codex r7).
 */
export const MANAGED_JOB_LINE_SIGNATURE = '-H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/'
/** Lines the builder emits inside a block besides job lines (header/BASE_URL) — swept in a malformed tail. */
const MANAGED_META_RE = /^(?:# CRON_SECRET is read from .* at runtime|# Managed by One Two Inventory|BASE_URL=")/

/** The runtime-mode header comment the builder emits, capturing the .env path. */
const RUNTIME_HEADER_RE = /^# CRON_SECRET is read from (.+?) at runtime/m

function isManagedRemnant(line: string): boolean {
  return line.includes(MANAGED_JOB_LINE_SIGNATURE) || MANAGED_META_RE.test(line)
}

/**
 * Strip EVERY complete OTI block (START…END pair) and any stray marker,
 * preserving all other lines verbatim (Codex r5/r6/r7). Handles multiple
 * blocks, END-before-START, and an unclosed START: its OWN generated remnants
 * (job lines / header / BASE_URL) are swept so they don't survive as
 * duplicates, but the sweep is BOUNDED to the malformed region [START ..
 * next START / EOF) — a genuine operator line, even one matching our signature,
 * OUTSIDE any block is always preserved. Shared shape + identical job signature
 * with the installer's awk so both are consistent.
 */
/**
 * Compute which lines to drop when removing OTI content, plus the index of the
 * FIRST managed marker (where a replacement block should be re-inserted so it
 * keeps its original position — Codex r8: crontab env assignments like PATH /
 * SHELL / CRON_TZ apply to the jobs BELOW them, so relocating the block to EOF
 * could move it past a restrictive operator assignment and silently break every
 * managed job).
 */
function computeOtiDrops(lines: string[]): { drop: boolean[]; firstMarkerLine: number } {
  const drop = new Array<boolean>(lines.length).fill(false)
  let firstMarkerLine = -1
  let i = 0
  while (i < lines.length) {
    if (START_MARKER_RE.test(lines[i])) {
      if (firstMarkerLine === -1) firstMarkerLine = i
      // Scan for this block's END, stopping at the next START (which opens a
      // new block). END found → complete block, drop the whole range.
      let j = i + 1
      while (j < lines.length && !END_MARKER_RE.test(lines[j]) && !START_MARKER_RE.test(lines[j])) j += 1
      if (j < lines.length && END_MARKER_RE.test(lines[j])) {
        for (let k = i; k <= j; k += 1) drop[k] = true
        i = j + 1
        continue
      }
      // Unclosed START: drop the marker and, within the malformed tail up to
      // the next START (or EOF), drop only OUR remnants — keep operator lines.
      drop[i] = true
      for (let k = i + 1; k < j; k += 1) {
        if (END_MARKER_RE.test(lines[k]) || isManagedRemnant(lines[k])) drop[k] = true
      }
      i = j
      continue
    }
    if (END_MARKER_RE.test(lines[i])) {
      if (firstMarkerLine === -1) firstMarkerLine = i
      drop[i] = true // stray END outside a block
    }
    i += 1
  }
  return { drop, firstMarkerLine }
}

/**
 * Strip EVERY complete OTI block (START…END pair) and any stray marker,
 * preserving all other lines verbatim (Codex r5/r6/r7). Handles multiple
 * blocks, END-before-START, and an unclosed START: its OWN generated remnants
 * (job lines / header / BASE_URL) are swept so they don't survive as
 * duplicates, but the sweep is BOUNDED to the malformed region [START ..
 * next START / EOF) — a genuine operator line, even one matching our signature,
 * OUTSIDE any block is always preserved. Shared shape + identical job signature
 * with the installer's awk so both are consistent.
 */
export function stripOtiBlocks(crontabText: string): string {
  const lines = crontabText.split('\n')
  const { drop } = computeOtiDrops(lines)
  return lines.filter((_, idx) => !drop[idx]).join('\n')
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
 * Replace the OTI block, preserving every non-OTI line AND the block's original
 * POSITION among them (Codex r5/r8): all existing blocks + stray markers are
 * stripped (handles END-before-START, multiple blocks, whitespace/CRLF markers,
 * and orphaned remnants), and the fresh block is inserted where the first
 * managed marker was — so it doesn't jump past an operator PATH/SHELL/CRON_TZ
 * assignment. If there was no prior block, it's appended at the end. Idempotent.
 */
export function spliceOtiBlock(existingCrontab: string, blockLines: string[]): string {
  const lines = existingCrontab.split('\n')
  const { drop, firstMarkerLine } = computeOtiDrops(lines)
  const out: string[] = []
  let inserted = false
  for (let i = 0; i < lines.length; i += 1) {
    if (i === firstMarkerLine) { out.push(...blockLines); inserted = true }
    if (drop[i]) continue
    out.push(lines[i])
  }
  if (!inserted) {
    // No prior block — append after the operator lines, with a clean separator.
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    out.push(...blockLines)
  }
  // Collapse any trailing blank lines the removal left, end with a single \n.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
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
    const runtimeHeader = block.match(RUNTIME_HEADER_RE)
    if (blockJobLines.length === 0) {
      // No jobs to run or drift (all disabled) — benign ONLY when it's a real
      // managed block (Codex r5/r6: an embedded literal, or the runtime header
      // whose .env path we can still verify). A marker-only or arbitrary block
      // is malformed → 'unknown', so the banner surfaces it.
      if (embedded) {
        secretMode = 'embedded'
        embeddedSecretMatches = currentSecret !== null && embedded[1] === currentSecret
      } else if (runtimeHeader && isCronSafePath(runtimeHeader[1])) {
        // Require a cron-SAFE path (Codex r7): the builder only ever emits one,
        // so a header whose path isn't cron-safe is hand-mangled → unknown.
        secretMode = 'runtime-env'
        runtimeEnvPath = runtimeHeader[1]
      } else {
        secretMode = 'unknown'
      }
    } else if (allRuntime && runtimePaths.size === 1 && isCronSafePath([...runtimePaths][0])) {
      // Every job line reads the same .env at runtime (an embedded literal, if
      // any, is stale leftover and ignored). The path must be cron-safe (Codex
      // r8: a %-path would be split by cron), consistent with the zero-job case.
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
