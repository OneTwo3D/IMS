/**
 * "IS THIS JOB REALLY IN THE CRONTAB?" - answered with the generator, not with a regex.
 *
 * A line that merely mentions `$BASE_URL/<slug>` does not run the job: it can be commented, malformed,
 * carry a schedule cron rejects, sit in a block whose BASE_URL or secret assignment is missing, or be
 * a leftover outside the managed block. So a job counts as scheduled only if the EXACT lines the
 * crontab generator (`buildOtiCrontabBlock`, the renderer the in-app scheduler sync writes with) would
 * emit for it are present in a COMPLETE managed block:
 *
 *   1. the block has both markers and a header (secret source, BASE_URL assignment) equal to the one
 *      the generator renders from the block's own BASE_URL, secret source and log path;
 *   2. the job's `# <label>` line is directly followed by the rendered, ACTIVE schedule-and-curl line
 *      for the job's stored (or default) schedule.
 *
 * A block that cannot be reconstructed (no BASE_URL, an unrecognisable secret source, a schedule the
 * generator refuses) is a malformed or partial block: every wanted job is reported missing and the
 * reason is returned. Pure.
 */

import {
  buildOtiCrontabBlock,
  DEFAULT_CRON_LOG_PATH,
  extractOtiBlock,
  OTI_CRON_END_MARKER,
  OTI_CRON_START_MARKER,
  parseOtiCrontabStatus,
  type CrontabJobDef,
  type CrontabSecretRef,
} from '@/lib/crontab-sync'

export type SchedulerVerdict = {
  /** Why the block as a whole cannot be trusted; null when it is complete. */
  blockProblem: string | null
  /** Wanted slugs with no active, generator-equal entry. */
  missing: string[]
}

export function verifyJobsScheduled(
  rawCrontabText: string,
  wanted: readonly CrontabJobDef[],
  storedSchedules: Readonly<Record<string, string | undefined>>,
): SchedulerVerdict {
  // CRLF and lone CR are line endings too: normalise ONCE, before marker detection, extraction and header comparison.
  const crontabText = rawCrontabText.replace(/\r\n?/g, '\n')
  const allMissing = (blockProblem: string): SchedulerVerdict => ({ blockProblem, missing: wanted.map((job) => job.slug) })

  // EXACTLY ONE managed region. extractOtiBlock concatenates every region it finds, so a valid block plus a
  // second complete or malformed one (or a stray, nested or extra marker) would otherwise be read as one
  // block and could vouch for a job the real schedule does not carry.
  const markerLines = crontabText.split('\n').map((line, index) => ({ line: line.trim(), index })).filter((entry) => /OTI CRON (START|END)/i.test(entry.line))
  const starts = markerLines.filter((entry) => entry.line === OTI_CRON_START_MARKER)
  const ends = markerLines.filter((entry) => entry.line === OTI_CRON_END_MARKER)
  if (markerLines.length !== 2 || starts.length !== 1 || ends.length !== 1 || starts[0]!.index >= ends[0]!.index) {
    return allMissing(`the crontab must hold exactly one managed region, but it has ${markerLines.length} marker line(s) (${starts.length} start, ${ends.length} end, in the order ${markerLines.map((entry) => (entry.line === OTI_CRON_START_MARKER ? 'start' : entry.line === OTI_CRON_END_MARKER ? 'end' : 'malformed')).join(', ') || 'none'})`)
  }

  const status = parseOtiCrontabStatus(crontabText, null)
  if (!status.blockPresent) return allMissing('there is no complete managed block (both markers) in the crontab')
  const block = extractOtiBlock(crontabText)

  const baseLine = block.find((line) => /^BASE_URL=".+\/api\/cron"$/.test(line))
  if (!baseLine) return allMissing('the managed block has no BASE_URL assignment')
  const baseUrl = baseLine.slice('BASE_URL="'.length, -'/api/cron"'.length)

  let secretRef: CrontabSecretRef
  if (status.secretMode === 'runtime-env' && status.runtimeEnvPath) {
    secretRef = { kind: 'env-file', envFilePath: status.runtimeEnvPath }
  } else if (status.secretMode === 'embedded') {
    const literal = block.find((line) => /^CRON_SECRET=".*"$/.test(line))
    if (!literal) return allMissing('the managed block names no cron secret')
    secretRef = { kind: 'literal', secret: literal.slice('CRON_SECRET="'.length, -1) }
  } else {
    return allMissing('the managed block\'s secret source is not one the scheduler writes')
  }

  const firstJobLine = block.find((line) => line.includes('$BASE_URL/') && !line.trim().startsWith('#'))
  const logPath = firstJobLine?.match(/ >> '(.+)' 2>&1$/)?.[1] ?? DEFAULT_CRON_LOG_PATH

  const render = (jobs: CrontabJobDef[], settings: Map<string, string>) =>
    buildOtiCrontabBlock({ jobs, settings, secretRef, baseUrl, logPath })

  // The header the generator writes for this block's own BASE_URL, secret source and log path.
  const header = render([], new Map())
  if (!header.ok) return allMissing(header.error)
  const headerEnd = header.lines.length - 1 // everything before the END marker
  const installedHeader = block.slice(0, headerEnd)
  if (installedHeader.join('\n') !== header.lines.slice(0, headerEnd).join('\n')) {
    return allMissing('the managed block\'s header is not what the scheduler writes (an edited or partial block)')
  }

  const missing: string[] = []
  for (const job of wanted) {
    const settings = new Map<string, string>([[`cron_${job.settingKey}_enabled`, 'true']])
    const schedule = storedSchedules[job.slug]
    if (schedule !== undefined) settings.set(`cron_${job.settingKey}_schedule`, schedule)
    const rendered = render([job], settings)
    if (!rendered.ok) { missing.push(job.slug); continue }
    const labelAt = rendered.lines.findIndex((line) => line === `# ${job.label}`)
    const expected = [rendered.lines[labelAt]!, rendered.lines[labelAt + 1]!]
    const present = block.some((line, index) => line === expected[0] && block[index + 1] === expected[1])
    if (!present) missing.push(job.slug)
  }
  return { blockProblem: null, missing }
}
