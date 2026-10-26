import { buildOtiCrontabBlock, type CrontabJobDef } from '@/lib/crontab-sync'
import { SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV } from './scheduler-crontab-file'
import { parseManagedBlock } from './read-sync-scheduler'
import { HOST_CRON_PENDING_MESSAGE } from './host-cron-constants'

/**
 * CONTAINER MODE: CRON RUNS ON THE HOST, AND THE APP CANNOT WRITE IT.
 *
 * The container image has no `crontab` binary; host cron reads /etc/cron.d/onetwo3d-ims, which the app only ever reads (mounted
 * read-only, IMS_SCHEDULER_CRONTAB_FILE with IMS_SCHEDULER_CRONTAB_FORMAT=cron.d). So there, saving scheduler settings records them
 * and nothing more: the host must re-render and install the file. This is the ONE place that decides whether the process is in that
 * mode; `reconcileCrontab`, the warning text and the drift indicator all use it.
 */
export function isContainerSchedulerMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()) && env[SCHEDULER_CRONTAB_FORMAT_ENV]?.trim() === 'cron.d'
}

export type HostCronDrift = {
  inSync: boolean
  /** Job slugs (or `unknown job (block line N)` for an installed job this release does not know) that differ in any way, sorted. */
  differing: string[]
  blockProblem: string | null
  /** Expected from the saved settings but not installed. */
  missing: string[]
  /** Installed but not expected: a disabled job, or one of an integration that is switched off. */
  extra: string[]
  /** Installed more than once (it would fire more than once). */
  duplicate: string[]
  /** Installed with a different schedule or command than the saved settings render. */
  changed: string[]
  /** Same entries but the block is not byte-identical (order or stray lines). The renderer is deterministic, so this is drift. */
  otherDifference: boolean
}

type BlockEntry = { label: string; command: string; line: number }

/** The `# label` + job line pairs of a block, after its header. Pure. */
function blockEntries(lines: readonly string[], from: number): BlockEntry[] {
  const out: BlockEntry[] = []
  for (let i = from; i < lines.length - 1; i += 1) {
    const line = lines[i]!
    const next = lines[i + 1]!
    if (line.startsWith('# ') && !line.includes('OTI CRON') && next !== '' && !next.startsWith('#')) {
      out.push({ label: line.slice(2), command: next, line: i + 1 })
      i += 1
    }
  }
  return out
}

const normalise = (lines: readonly string[]): string[] => lines.map((line) => line.replace(/\s+$/, ''))

/**
 * Is the installed host file EXACTLY what the SAVED settings would render? The expected managed block is built with the same pure
 * generator the renderer uses, from the registry jobs and the saved settings, using the BASE_URL, secret source and log path the
 * installed block itself names (they are the host's choice, not a setting). The installed block is taken between its markers as the
 * status reader takes it (`parseManagedBlock`: user field already removed by the reader, CRLF normalised, one region only) and both
 * are compared line for line with trailing whitespace ignored, so an extra job (disabled since, or of an integration switched off
 * since, whose jobs are no longer even in `jobs`), a duplicated line, a changed schedule and a reordered block are all drift. Lines
 * outside the markers (the renderer's own `# Source:` comment) are not part of the block. `allJobs` names extra jobs by slug when the
 * registry knows them; otherwise by block line number. No diagnostic here ever quotes installed text. Pure.
 */
export function hostCronDrift(input: {
  jobs: readonly CrontabJobDef[]
  settings: ReadonlyMap<string, string>
  hostText: string
  allJobs?: readonly CrontabJobDef[]
}): HostCronDrift {
  const empty = { differing: [], missing: [], extra: [], duplicate: [], changed: [], otherDifference: false }
  // Trailing whitespace and CRLF are not drift: normalise the installed text before it is read as a block.
  const parsed = parseManagedBlock(input.hostText.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n'))
  if (!parsed.ok) return { inSync: false, blockProblem: parsed.problem, ...empty }
  const built = buildOtiCrontabBlock({
    jobs: [...input.jobs], settings: new Map(input.settings), secretRef: parsed.secretRef, baseUrl: parsed.baseUrl, logPath: parsed.logPath,
  })
  if (!built.ok) return { inSync: false, blockProblem: built.error, ...empty }

  const expected = normalise(built.lines)
  const installed = normalise(parsed.block)
  if (expected.length === installed.length && expected.every((line, i) => line === installed[i])) {
    return { inSync: true, blockProblem: null, ...empty }
  }

  const names = new Map((input.allJobs ?? input.jobs).map((job) => [job.label, job.slug] as const))
  for (const job of input.jobs) names.set(job.label, job.slug)
  // A label read from the host file is free text, so a job this release does not know is named by its position, never by that text.
  const firstLine = new Map<string, number>()
  const want = blockEntries(expected, parsed.headerLength)
  const have = blockEntries(installed, parsed.headerLength)
  const wantByLabel = new Map(want.map((entry) => [entry.label, entry.command] as const))
  const haveByLabel = new Map<string, string[]>()
  for (const entry of have) {
    haveByLabel.set(entry.label, [...(haveByLabel.get(entry.label) ?? []), entry.command])
    if (!firstLine.has(entry.label)) firstLine.set(entry.label, entry.line)
  }
  const nameOf = (label: string): string => names.get(label) ?? `unknown job (block line ${firstLine.get(label) ?? '?'})`

  const missing = want.filter((entry) => !haveByLabel.has(entry.label)).map((entry) => nameOf(entry.label))
  const extra = [...haveByLabel.keys()].filter((label) => !wantByLabel.has(label)).map(nameOf)
  const duplicate = [...haveByLabel].filter(([, commands]) => commands.length > 1).map(([label]) => nameOf(label))
  const changed = want
    .filter((entry) => haveByLabel.has(entry.label) && !haveByLabel.get(entry.label)!.every((command) => command === entry.command))
    .map((entry) => nameOf(entry.label))
  const sorted = (list: string[]) => [...new Set(list)].sort()
  const differing = sorted([...missing, ...extra, ...duplicate, ...changed])
  return {
    inSync: false,
    blockProblem: null,
    differing,
    missing: sorted(missing),
    extra: sorted(extra),
    duplicate: sorted(duplicate),
    changed: sorted(changed),
    otherDifference: differing.length === 0,
  }
}

export function describeHostCronDrift(drift: HostCronDrift): string {
  if (drift.inSync) return 'Host cron is in sync with the saved scheduler settings.'
  if (drift.blockProblem) return `Host cron is out of date: ${drift.blockProblem}.`
  const parts = [
    drift.missing.length ? `missing: ${drift.missing.join(', ')}` : '',
    drift.extra.length ? `extra: ${drift.extra.join(', ')}` : '',
    drift.duplicate.length ? `duplicate: ${drift.duplicate.join(', ')}` : '',
    drift.changed.length ? `changed: ${drift.changed.join(', ')}` : '',
    drift.otherDifference ? 'the managed block differs from the rendered one (order or stray lines)' : '',
  ].filter(Boolean)
  const count = drift.otherDifference ? 'block differs' : `${drift.differing.length} job${drift.differing.length === 1 ? '' : 's'} differ: ${drift.differing.join(', ')}`
  return `Host cron is out of date (${count}) [${parts.join('; ')}]. ${HOST_CRON_PENDING_MESSAGE}`
}
