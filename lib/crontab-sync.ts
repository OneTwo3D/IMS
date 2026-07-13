/**
 * Pure crontab-block generation and inspection for the managed scheduler
 * (onetwo3d-ims-ryxy). Extracted from app/actions/cron.ts so the block format
 * and drift detection are unit-testable.
 *
 * Root cause of ryxy: syncCrontab embedded the CRON_SECRET literal in the
 * crontab, so an env rotation silently 401'd every managed job until the next
 * manual sync. The installer never had this class of failure because its cron
 * lines read the secret from .env AT RUNTIME (scripts/install.sh) — the block
 * builder now emits that pattern whenever the app has a readable .env, and
 * falls back to the embedded literal only when it doesn't (e.g. env supplied
 * purely by the service manager).
 */

export const OTI_CRON_START_MARKER = '# --- OTI CRON START ---'
export const OTI_CRON_END_MARKER = '# --- OTI CRON END ---'

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

export type BuildOtiCrontabBlockResult =
  | { ok: true; lines: string[] }
  | { ok: false; error: string }

/**
 * Runtime secret read for a cron job line: greps the CRON_SECRET line out of
 * the app's .env when the job FIRES, so a secret rotation (env edit + service
 * restart) needs no crontab re-sync. tr strips optional double quotes — the
 * installer writes the value unquoted but hand-maintained .env files often
 * quote it.
 */
function runtimeSecretPrefix(envFilePath: string): string {
  return `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${envFilePath}' | cut -d= -f2- | tr -d '"') && `
}

export function buildOtiCrontabBlock(params: {
  jobs: CrontabJobDef[]
  settings: Map<string, string>
  secretRef: CrontabSecretRef
  baseUrl: string
}): BuildOtiCrontabBlockResult {
  const { jobs, settings, secretRef, baseUrl } = params

  if (secretRef.kind === 'env-file' && secretRef.envFilePath.includes("'")) {
    return { ok: false, error: 'App .env path contains a single quote; cannot build safe cron lines.' }
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
      `${schedule}  ${commandPrefix}curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${job.slug}" >> /var/log/oti-cron.log 2>&1`,
      '',
    )
  }

  lines.push(OTI_CRON_END_MARKER)
  return { ok: true, lines }
}

/** Replace (or append) the OTI block, preserving everything outside the markers. */
export function spliceOtiBlock(existingCrontab: string, blockLines: string[]): string {
  const startIdx = existingCrontab.indexOf(OTI_CRON_START_MARKER)
  const endIdx = existingCrontab.indexOf(OTI_CRON_END_MARKER)

  let before = ''
  let after = ''

  if (startIdx !== -1 && endIdx !== -1) {
    before = existingCrontab.slice(0, startIdx)
    after = existingCrontab.slice(endIdx + OTI_CRON_END_MARKER.length)
  } else {
    before = existingCrontab
    if (before && !before.endsWith('\n')) before += '\n'
  }

  return before + blockLines.join('\n') + '\n' + after.replace(/^\n+/, '')
}

export type OtiCrontabStatus = {
  blockPresent: boolean
  /** How the block sources its secret; 'none' when no block exists. */
  secretMode: 'runtime-env' | 'embedded' | 'none'
  /** Embedded mode only: does the literal match the CURRENT env secret? null otherwise. */
  embeddedSecretMatches: boolean | null
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

  const isJobLine = (line: string) => /\/api\/cron\//.test(line) && !line.trim().startsWith('#')
  const managedJobCount = block.split('\n').filter(isJobLine).length
  const unmanagedCronApiLines = outside.split('\n').filter(isJobLine).length

  let secretMode: OtiCrontabStatus['secretMode'] = 'none'
  let embeddedSecretMatches: boolean | null = null
  if (blockPresent) {
    const embedded = block.match(/^CRON_SECRET="(.*)"$/m)
    if (embedded) {
      secretMode = 'embedded'
      embeddedSecretMatches = currentSecret !== null && embedded[1] === currentSecret
    } else {
      secretMode = 'runtime-env'
    }
  }

  return { blockPresent, secretMode, embeddedSecretMatches, managedJobCount, unmanagedCronApiLines }
}
