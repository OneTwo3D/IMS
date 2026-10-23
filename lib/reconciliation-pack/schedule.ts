/**
 * THE SCHEDULED RECONCILIATION PACK, WITHOUT ITS SIDE EFFECTS: reading the job's settings, building the command's arguments,
 * reading what the command printed, and turning how it ended into ONE closed record. Pure functions; the runner that starts
 * the command and writes the record is lib/ops/reconciliation-pack-schedule.ts.
 *
 * What the command printed is a CLAIM, and only closed things are taken from it: a code is accepted only if it is a key of one
 * of the pack's own code tables, a report path only if it is exactly the default report directory, a run id of the pack's
 * grammar and the report file name. Nothing else the command printed (and nothing a file or a vendor said) is kept.
 */

import {
  DEFAULT_PACK_REPORT_DIR, PACK_CHAIN_CODES, PACK_CLI_CODES, PACK_EXIT_CODES, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN,
} from '@/lib/reconciliation-pack/constants'
import {
  PACK_SCHEDULE_NOT_A_FAULT_CODES, PACK_SCHEDULE_FAILURES, PACK_SCHEDULE_PHASES, PACK_SCHEDULE_RECORD_VERSION, PACK_SCHEDULE_REFUSALS,
  PACK_SCHEDULE_RUN_ID_RE, type PackScheduleFailure, type PackScheduleOutcome, type PackSchedulePhase, type PackScheduleRefusal,
} from '@/lib/reconciliation-pack/schedule-constants'

export type ScheduleSettings =
  | { ok: true; phase: PackSchedulePhase; vendorReads: boolean }
  | { ok: false; refusal: 'PHASE_NOT_SET' | 'PHASE_INVALID'; vendorReads: boolean }

/** `true` only for the exact stored word `true`; anything else, absent included, is off. */
export function parseVendorReadsSetting(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/** There is no default phase: absent (or empty) is PHASE_NOT_SET, present and not P0/P1/P2 is PHASE_INVALID. */
export function parseScheduleSettings(input: { phase: string | null | undefined; vendorReads: string | null | undefined }): ScheduleSettings {
  const vendorReads = parseVendorReadsSetting(input.vendorReads)
  if (input.phase === null || input.phase === undefined || input.phase === '') return { ok: false, refusal: 'PHASE_NOT_SET', vendorReads }
  if (!(PACK_SCHEDULE_PHASES as readonly string[]).includes(input.phase)) return { ok: false, refusal: 'PHASE_INVALID', vendorReads }
  return { ok: true, phase: input.phase as PackSchedulePhase, vendorReads }
}

/** The arguments after `--`. Fixed words and the phase: no path, no date (the command defaults them), nothing from a file. */
export function scheduledPackArgs(phase: PackSchedulePhase, vendorReads: boolean): string[] {
  return ['--phase', phase, ...(vendorReads ? ['--vendor-reads-only'] : [])]
}

const CLOSED_COMMAND_CODES: ReadonlySet<string> = new Set([...Object.keys(PACK_CLI_CODES), ...Object.keys(PACK_CHAIN_CODES)])
const CODE_LINE_RE = /^(?:Refused|Stopped|Not published): ([A-Z][A-Z_]{1,63})$/m
const INTERNAL_LINE_RE = /\(treat as inconclusive\): INTERNAL$/m
const REPORT_LINE_RE = /^Report: (\S+)$/gm

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const REPORT_PATH_RE = new RegExp(`^${escapeRe(DEFAULT_PACK_REPORT_DIR)}/([0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})/(${escapeRe(PACK_REPORT_JSON)}|${escapeRe(PACK_REPORT_MARKDOWN)})$`)

export type ParsedPackOutput = {
  /** A code from the pack's own tables, or null. */
  code: string | null
  runId: string | null
  reportJson: string | null
  reportMarkdown: string | null
}

export function parsePackOutput(stderr: string): ParsedPackOutput {
  const out: ParsedPackOutput = { code: null, runId: null, reportJson: null, reportMarkdown: null }
  const codeLine = CODE_LINE_RE.exec(stderr)
  if (codeLine && CLOSED_COMMAND_CODES.has(codeLine[1]!)) out.code = codeLine[1]!
  else if (INTERNAL_LINE_RE.test(stderr)) out.code = 'INTERNAL'
  for (const match of stderr.matchAll(REPORT_LINE_RE)) {
    const parsed = REPORT_PATH_RE.exec(match[1]!)
    if (!parsed) continue
    if (out.runId !== null && out.runId !== parsed[1]) { out.runId = null; out.reportJson = null; out.reportMarkdown = null; return out }
    out.runId = parsed[1]!
    if (parsed[2] === PACK_REPORT_JSON) out.reportJson = match[1]!
    else out.reportMarkdown = match[1]!
  }
  return out
}

/** The sequence a published report records, or null for anything that is not exactly a positive safe integer next to the right run id. */
export function sequenceOfReport(jsonText: string, runId: string): number | null {
  try {
    const parsed = JSON.parse(jsonText) as { runId?: unknown; sequence?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.runId !== runId || !PACK_SCHEDULE_RUN_ID_RE.test(runId)) return null
    return typeof parsed.sequence === 'number' && Number.isSafeInteger(parsed.sequence) && parsed.sequence >= 1 ? parsed.sequence : null
  } catch { return null }
}

/** The ONE record of a scheduled run or of a refused or failed start. Closed codes and counts only. */
export type ScheduledRunRecord = {
  schemaVersion: typeof PACK_SCHEDULE_RECORD_VERSION
  scheduleRunId: string
  outcome: PackScheduleOutcome
  code: string
  codeMeaning: string
  exitCode: number | null
  exitMeaning: string | null
  phase: PackSchedulePhase | null
  vendorReads: boolean
  runId: string | null
  sequence: number | null
  reportJson: string | null
  reportMarkdown: string | null
  durationMs: number
}

type RecordBase = { scheduleRunId: string; phase: PackSchedulePhase | null; vendorReads: boolean; durationMs: number }

export function refusalRecord(base: RecordBase, refusal: PackScheduleRefusal): ScheduledRunRecord {
  return {
    schemaVersion: PACK_SCHEDULE_RECORD_VERSION as 1, ...base, outcome: 'refused', code: refusal, codeMeaning: PACK_SCHEDULE_REFUSALS[refusal],
    exitCode: null, exitMeaning: null, runId: null, sequence: null, reportJson: null, reportMarkdown: null,
  }
}

export function meaningOfCommandCode(code: string): string | null {
  if (Object.prototype.hasOwnProperty.call(PACK_CLI_CODES, code)) return PACK_CLI_CODES[code as keyof typeof PACK_CLI_CODES]
  if (Object.prototype.hasOwnProperty.call(PACK_CHAIN_CODES, code)) return PACK_CHAIN_CODES[code as keyof typeof PACK_CHAIN_CODES]
  if (code === 'INTERNAL') return 'the pack itself failed unexpectedly before it could reach an outcome'
  return null
}

export type ChildEnd = { exitCode: number | null; timedOut: boolean; stderr: string }

/**
 * How a started command ended, as one record.
 *
 * Exit 0, 1 and 5 mean "a report was published" ONLY when the command also named that report in the report directory: a crash of
 * the runner before the pack starts (a missing module, say) exits 1 too, and must not be read as the pack's `fail`.
 * Exit 2 is a refusal (the code it printed), 3 a report that was not published, 4 an internal failure; those two print a code too.
 */
export function classifyChildEnd(base: RecordBase, end: ChildEnd, sequence: (parsed: ParsedPackOutput) => number | null): ScheduledRunRecord {
  const common = { schemaVersion: PACK_SCHEDULE_RECORD_VERSION as 1, ...base }
  const failed = (code: PackScheduleFailure, exitCode: number | null, parsed?: ParsedPackOutput): ScheduledRunRecord => ({
    ...common, outcome: 'failed', code, codeMeaning: PACK_SCHEDULE_FAILURES[code], exitCode, exitMeaning: exitMeaningOf(exitCode),
    runId: null, sequence: null, reportJson: parsed?.reportJson ?? null, reportMarkdown: parsed?.reportMarkdown ?? null,
  })
  if (end.timedOut) return failed('CHILD_TIMED_OUT', null)
  if (end.exitCode === null) return failed('CHILD_NOT_STARTED', null)
  const row = PACK_EXIT_CODES.find((candidate) => candidate.code === end.exitCode)
  if (!row) return failed('EXIT_CODE_UNKNOWN', end.exitCode)
  const parsed = parsePackOutput(end.stderr)
  if (row.name === 'all-pass' || row.name === 'fail' || row.name === 'inconclusive') {
    if (parsed.runId === null || parsed.reportJson === null || parsed.reportMarkdown === null) return failed('EXIT_WITHOUT_REPORT', end.exitCode, parsed)
    return {
      ...common, outcome: 'published', code: row.name, codeMeaning: row.meaning, exitCode: row.code, exitMeaning: row.meaning,
      runId: parsed.runId, sequence: sequence(parsed), reportJson: parsed.reportJson, reportMarkdown: parsed.reportMarkdown,
    }
  }
  // refused (2), report-not-published (3), internal (4)
  if (parsed.code === null) return failed('NO_CODE_PRINTED', end.exitCode, parsed)
  return {
    ...common, outcome: row.name === 'refused' ? 'refused' : 'failed', code: parsed.code, codeMeaning: meaningOfCommandCode(parsed.code) ?? row.meaning,
    exitCode: row.code, exitMeaning: row.meaning, runId: null, sequence: null, reportJson: null, reportMarkdown: null,
  }
}

function exitMeaningOf(exitCode: number | null): string | null {
  return PACK_EXIT_CODES.find((row) => row.code === exitCode)?.meaning ?? null
}

/** A refusal that is not a fault (see PACK_SCHEDULE_NOT_A_FAULT_CODES): the framework run is `skipped`, not `failed`. */
export function isNotAFault(record: ScheduledRunRecord): boolean {
  return record.outcome === 'refused' && PACK_SCHEDULE_NOT_A_FAULT_CODES.includes(record.code)
}
