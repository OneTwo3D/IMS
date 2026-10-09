/**
 * THE PURE HALF OF THE READINESS GATE: typed check results in, one verdict out.
 *
 * `npm run readiness:gate` (scripts/readiness-gate.ts) collects the checks (lib/ops/readiness-gate-collect.ts
 * does the I/O) and hands their RESULTS to `decideVerdict`. Nothing in this file touches a database, a
 * process, the file system or the clock (the caller passes `now`), so every rule below can be exercised,
 * and mutated, without any of them. The words, names and numbers it uses are in
 * lib/ops/readiness-gate-constants.ts and nowhere else.
 *
 * THE RULES, each of them proven able to fail by a named mutation (see the PR and the tests):
 *
 *  1. A check is only as good as its result. The result vocabulary is closed: pass, fail, unreadable,
 *     not-available. There is no "skipped" and no "unknown": an unreadable result is a NO-GO, and so is a
 *     result nobody collected (MISSING). The only way a check can be absent without blocking is an explicit
 *     `not-available` for a check the catalogue marks optional-until-present (or listed-only in this phase).
 *  2. A warning is neither a pass nor a failure. It is NO-GO unless a current written acceptance names it.
 *     Acceptances never apply to failures.
 *  3. The verdict is a pure function of (phase, results, acceptances, now).
 */

import {
  ACCEPTANCE_CLOCK_SKEW_MS,
  ACCEPTANCE_MAX_DAYS,
  ACCEPTANCE_REASON_MIN_LENGTH,
  ACCEPTANCE_SCHEMA_VERSION,
  CHECK_CATALOGUE,
  BUILD_SCOPE_TEXT,
  SCHEMA_CHECKS_RAN_TEXT,
  READINESS_GATE_EXIT_CODES,
  READINESS_PHASES,
  READ_SYNC_SCHEMA_VERSION,
  REQUIRED_READ_SYNC_STREAMS,
  REHEARSAL_CLOCK_SKEW_MS,
  REHEARSAL_MAX_AGE_DAYS,
  readinessGateExitCode,
  type CheckDefinition,
  type ReadinessPhase,
  type ReadinessVerdict,
  type Requirement,
} from '@/lib/ops/readiness-gate-constants'
import { BUILD_IDENTITY_TEXT, compareBuildIdentity, type BuildIdentity } from '@/lib/ops/build-identity'
import { STEP_CATALOGUE, teardownIncomplete, type RehearsalReport } from '@/lib/ops/first-install-rehearsal'
import { OUTBOUND_CONNECTORS } from '@/lib/security/outbound-write-hold-constants'

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------------------------

export type GateWarning = { id: string; message: string }

export type CheckResult =
  | { kind: 'pass'; summary: string; detail?: Record<string, unknown>; warnings?: GateWarning[] }
  | { kind: 'fail'; reasons: string[]; detail?: Record<string, unknown>; warnings?: GateWarning[] }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'not-available'; reason: string }

/** What the collector hands the verdict: one entry per check it ran. An absent key is MISSING, not skipped. */
export type CollectedResults = Readonly<Record<string, CheckResult | undefined>>

const pass = (summary: string, detail?: Record<string, unknown>, warnings?: GateWarning[]): CheckResult => ({ kind: 'pass', summary, ...(detail ? { detail } : {}), ...(warnings && warnings.length > 0 ? { warnings } : {}) })
const fail = (reasons: string[], detail?: Record<string, unknown>, warnings?: GateWarning[]): CheckResult => ({ kind: 'fail', reasons, ...(detail ? { detail } : {}), ...(warnings && warnings.length > 0 ? { warnings } : {}) })
const unreadable = (reason: string): CheckResult => ({ kind: 'unreadable', reason })

// ---------------------------------------------------------------------------------------------
// Written warning acceptances.
// ---------------------------------------------------------------------------------------------

export type AcceptanceEntry = {
  warningId: string
  acceptedBy: string
  acceptedAt: string
  reason: string
  expiresAt: string
  phases: ReadinessPhase[]
}

export type AcceptanceFile =
  | { status: 'absent'; problems: string[]; entries: [] }
  | { status: 'rejected'; problems: string[]; entries: [] }
  | { status: 'ok'; problems: string[]; entries: AcceptanceEntry[] }

const ENTRY_KEYS = ['warningId', 'acceptedBy', 'acceptedAt', 'reason', 'expiresAt', 'phases'] as const
const FILE_KEYS = ['schemaVersion', 'acceptances'] as const
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Read the acceptance file's text. `null` means the file does not exist (no acceptances, which is a normal
 * state); anything else that cannot be read strictly rejects the WHOLE file, so a typo can never half-accept.
 */
export function parseAcceptanceFile(text: string | null): AcceptanceFile {
  if (text === null) return { status: 'absent', problems: [], entries: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: 'rejected', problems: ['the acceptance file is not valid JSON'], entries: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'rejected', problems: ['the acceptance file must be a JSON object'], entries: [] }
  }
  const file = parsed as Record<string, unknown>
  const unknownFileKeys = Object.keys(file).filter((key) => !(FILE_KEYS as readonly string[]).includes(key))
  if (unknownFileKeys.length > 0) return { status: 'rejected', problems: [`unknown field(s) in the acceptance file: ${unknownFileKeys.join(', ')}`], entries: [] }
  if (file.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) return { status: 'rejected', problems: [`schemaVersion must be ${ACCEPTANCE_SCHEMA_VERSION}`], entries: [] }
  if (!Array.isArray(file.acceptances)) return { status: 'rejected', problems: ['acceptances must be a list'], entries: [] }

  const problems: string[] = []
  const entries: AcceptanceEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of file.acceptances.entries()) {
    const label = `acceptances[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label} is not an object`)
      continue
    }
    const entry = raw as Record<string, unknown>
    const unknownKeys = Object.keys(entry).filter((key) => !(ENTRY_KEYS as readonly string[]).includes(key))
    if (unknownKeys.length > 0) return { status: 'rejected', problems: [`${label} has unknown field(s): ${unknownKeys.join(', ')}`], entries: [] }
    const warningId = entry.warningId
    if (typeof warningId === 'string' && warningId !== '') {
      if (seen.has(warningId)) return { status: 'rejected', problems: [`the warning ${warningId} is accepted more than once; which acceptance applies would be ambiguous`], entries: [] }
      seen.add(warningId)
    }
    const entryProblems: string[] = []
    if (typeof warningId !== 'string' || warningId.trim() === '' || warningId !== warningId.trim()) entryProblems.push('warningId must be one exact, non-empty warning id')
    if (typeof entry.acceptedBy !== 'string' || entry.acceptedBy.trim() === '') entryProblems.push('acceptedBy (who) must be non-empty')
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < ACCEPTANCE_REASON_MIN_LENGTH) entryProblems.push(`reason (why) must be at least ${ACCEPTANCE_REASON_MIN_LENGTH} characters`)
    const acceptedAt = parseIso(entry.acceptedAt)
    const expiresAt = parseIso(entry.expiresAt)
    if (acceptedAt === null) entryProblems.push('acceptedAt must be an ISO time with a zone, for example 2026-10-08T09:30:00Z')
    if (expiresAt === null) entryProblems.push('expiresAt must be an ISO time with a zone, for example 2026-11-08T09:30:00Z')
    if (acceptedAt !== null && expiresAt !== null) {
      if (expiresAt <= acceptedAt) entryProblems.push('expiresAt must be after acceptedAt')
      else if (expiresAt - acceptedAt > ACCEPTANCE_MAX_DAYS * DAY_MS) entryProblems.push(`expiresAt may be at most ${ACCEPTANCE_MAX_DAYS} days after acceptedAt`)
    }
    const phases = entry.phases
    if (!Array.isArray(phases) || phases.length === 0 || !phases.every((phase) => (READINESS_PHASES as readonly unknown[]).includes(phase))) {
      entryProblems.push(`phases must be a non-empty list drawn from ${READINESS_PHASES.join(', ')}`)
    }
    if (entryProblems.length > 0) {
      problems.push(`${label}${typeof warningId === 'string' ? ` (${warningId})` : ''}: ${entryProblems.join('; ')}; it accepts nothing`)
      continue
    }
    entries.push({
      warningId: warningId as string,
      acceptedBy: (entry.acceptedBy as string).trim(),
      acceptedAt: entry.acceptedAt as string,
      reason: (entry.reason as string).trim(),
      expiresAt: entry.expiresAt as string,
      phases: [...new Set(phases as ReadinessPhase[])],
    })
  }
  return { status: 'ok', problems, entries }
}

export type WarningDisposition =
  | { accepted: true; by: string; at: string; expiresAt: string; reason: string }
  | { accepted: false; why: string }

/** Is THIS warning, in THIS phase, at THIS time, covered by a current written acceptance? Exact id match only. */
export function dispositionOf(warning: GateWarning, acceptances: AcceptanceFile, phase: ReadinessPhase, now: Date): WarningDisposition {
  const entry = acceptances.entries.find((candidate) => candidate.warningId === warning.id)
  if (!entry) {
    return { accepted: false, why: acceptances.status === 'rejected' ? 'the acceptance file was rejected, so nothing is accepted' : 'no written acceptance names this warning' }
  }
  const acceptedAt = Date.parse(entry.acceptedAt)
  const expiresAt = Date.parse(entry.expiresAt)
  if (acceptedAt > now.getTime() + ACCEPTANCE_CLOCK_SKEW_MS) return { accepted: false, why: `the acceptance by ${entry.acceptedBy} is dated in the future (${entry.acceptedAt})` }
  if (expiresAt <= now.getTime()) return { accepted: false, why: `the acceptance by ${entry.acceptedBy} expired at ${entry.expiresAt}` }
  if (!entry.phases.includes(phase)) return { accepted: false, why: `the acceptance by ${entry.acceptedBy} does not cover phase ${phase} (it covers ${entry.phases.join(', ')})` }
  return { accepted: true, by: entry.acceptedBy, at: entry.acceptedAt, expiresAt: entry.expiresAt, reason: entry.reason }
}

// ---------------------------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------------------------

export type RowStatus = 'PASS' | 'FAIL' | 'UNREADABLE' | 'MISSING' | 'NOT YET AVAILABLE' | 'NOT AVAILABLE (REQUIRED)' | 'UNKNOWN CHECK'

export type CheckRow = {
  id: string
  title: string
  requirement: Requirement | null
  status: RowStatus
  /** True when this row alone forces NO-GO. */
  blocking: boolean
  /** One line of what was observed (a pass) or why not. */
  summary: string
  reasons: string[]
  detail: Record<string, unknown>
}

export type WarningRow = GateWarning & { checkId: string; disposition: WarningDisposition }

export type VerdictInput = {
  phase: ReadinessPhase
  results: CollectedResults
  acceptances: AcceptanceFile
  now: Date
  /** Defaults to the catalogue; tests pass a different one to prove a rule is carried by the catalogue's data. */
  catalogue?: readonly CheckDefinition[]
}

export type Verdict = {
  verdict: ReadinessVerdict
  exitCode: number
  rows: CheckRow[]
  warnings: WarningRow[]
  /** Acceptances that name no warning raised in this run. Informational. */
  unusedAcceptances: string[]
  blockingReasons: string[]
  notYetAvailable: string[]
}

function rowFor(definition: CheckDefinition, phase: ReadinessPhase, result: CheckResult | undefined): CheckRow {
  const requirement = definition.requirement[phase]
  const base = { id: definition.id, title: definition.title, requirement }
  if (result === undefined) {
    return { ...base, status: 'MISSING', blocking: true, summary: 'no result was collected for this check', reasons: ['no result was collected for this check, so it is neither passed nor skipped'], detail: {} }
  }
  switch (result.kind) {
    case 'pass':
      return { ...base, status: 'PASS', blocking: false, summary: result.summary, reasons: [], detail: result.detail ?? {} }
    case 'fail':
      // A failing check blocks in every phase except where the catalogue lists it for information only.
      return { ...base, status: 'FAIL', blocking: requirement !== 'listed-only', summary: result.reasons[0] ?? 'failed', reasons: result.reasons, detail: result.detail ?? {} }
    case 'unreadable':
      // Unreadable ALWAYS blocks, whatever the requirement: a check that could not be read is not a check that passed.
      return { ...base, status: 'UNREADABLE', blocking: true, summary: result.reason, reasons: [result.reason], detail: {} }
    case 'not-available':
      if (requirement === 'required') {
        return { ...base, status: 'NOT AVAILABLE (REQUIRED)', blocking: true, summary: result.reason, reasons: [`this check is required for ${phase} and is not available: ${result.reason}`], detail: {} }
      }
      return { ...base, status: 'NOT YET AVAILABLE', blocking: false, summary: result.reason, reasons: [], detail: {} }
    default: {
      const never: never = result
      return never
    }
  }
}

export function decideVerdict(input: VerdictInput): Verdict {
  const catalogue = input.catalogue ?? CHECK_CATALOGUE
  const rows: CheckRow[] = []
  const warnings: WarningRow[] = []
  const known = new Set(catalogue.map((definition) => definition.id as string))

  for (const definition of catalogue) {
    const result = input.results[definition.id]
    rows.push(rowFor(definition, input.phase, result))
    if (result !== undefined && (result.kind === 'pass' || result.kind === 'fail')) {
      for (const warning of result.warnings ?? []) {
        if (warnings.some((existing) => existing.id === warning.id)) continue
        warnings.push({ ...warning, checkId: definition.id, disposition: dispositionOf(warning, input.acceptances, input.phase, input.now) })
      }
    }
  }
  // A result for a check this gate does not know is not ignored: something collected evidence the verdict
  // cannot weigh, which is itself the thing to stop on.
  for (const key of Object.keys(input.results)) {
    if (!known.has(key) && input.results[key] !== undefined) {
      rows.push({ id: key, title: key, requirement: null, status: 'UNKNOWN CHECK', blocking: true, summary: 'a result was collected for a check this gate does not define', reasons: ['a result was collected for a check this gate does not define'], detail: {} })
    }
  }

  const blockingReasons: string[] = []
  for (const row of rows) {
    if (row.blocking) blockingReasons.push(`${row.id}: ${row.status}${row.reasons.length > 0 ? ` - ${row.reasons.join(' | ')}` : ''}`)
  }
  const unaccepted = warnings.filter((warning) => !warning.disposition.accepted)
  for (const warning of unaccepted) {
    blockingReasons.push(`${warning.id}: warning not accepted - ${(warning.disposition as { why: string }).why}`)
  }

  const raised = new Set(warnings.map((warning) => warning.id))
  const unusedAcceptances = input.acceptances.entries.filter((entry) => !raised.has(entry.warningId)).map((entry) => entry.warningId)
  const notYetAvailable = rows.filter((row) => row.status === 'NOT YET AVAILABLE').map((row) => row.id)

  const verdict: ReadinessVerdict = blockingReasons.length > 0 ? 'NO-GO' : warnings.length > 0 ? 'GO-WITH-ACCEPTED-WARNINGS' : 'GO'
  return { verdict, exitCode: exitCodeFor(verdict), rows, warnings, unusedAcceptances, blockingReasons, notYetAvailable }
}

export function exitCodeFor(verdict: ReadinessVerdict): number {
  return readinessGateExitCode(verdict === 'GO' ? 'go' : verdict === 'NO-GO' ? 'no-go' : 'go-with-accepted-warnings')
}

// ---------------------------------------------------------------------------------------------
// Check assessors (pure): evidence in, a CheckResult out.
// ---------------------------------------------------------------------------------------------

/** The slice of OutboundStatusReport the assessor reads. Structural, so tests need no database. */
export type OutboundEvidence = {
  connectors: Array<{ connector: string; state: string }>
  anyGranted: boolean
  anyUnreadable: boolean
  countsAvailable: boolean
}

export function assessOutboundStatus(evidence: OutboundEvidence, phase: ReadinessPhase, expectGranted: readonly string[] | null): CheckResult {
  const failures: string[] = []
  const states = new Map<string, string>()
  for (const connector of OUTBOUND_CONNECTORS) {
    const mine = evidence.connectors.filter((entry) => entry.connector === connector)
    if (mine.length !== 1) failures.push(`outbound status lists ${connector} ${mine.length} times, expected exactly once`)
    else states.set(connector, mine[0]!.state)
  }
  for (const entry of evidence.connectors) {
    if (!(OUTBOUND_CONNECTORS as readonly string[]).includes(entry.connector)) failures.push(`outbound status lists an unknown connector ${String(entry.connector)}`)
  }
  for (const [connector, state] of states) {
    if (state !== 'held' && state !== 'granted') failures.push(`${connector} is in state ${JSON.stringify(state)}, which is neither held nor granted`)
    if (state === 'unreadable') failures.push(`the ${connector} grant variable is set but unreadable`)
  }
  if (evidence.anyUnreadable) failures.push('a grant variable is unreadable')
  if (!evidence.countsAvailable) return unreadable('the refusal counts could not be read from the activity log, so the outbound status is incomplete')

  const granted = [...states].filter(([, state]) => state === 'granted').map(([connector]) => connector).sort()
  if (phase === 'P2') {
    if (expectGranted === null) failures.push('P2 needs the declared writers (--expect-granted), and none were declared')
    else {
      const declared = [...new Set(expectGranted)].sort()
      const unknown = declared.filter((connector) => !(OUTBOUND_CONNECTORS as readonly string[]).includes(connector))
      if (unknown.length > 0) failures.push(`declared writer(s) that are not connectors: ${unknown.join(', ')}`)
      const missing = declared.filter((connector) => !granted.includes(connector))
      const extra = granted.filter((connector) => !declared.includes(connector))
      if (missing.length > 0) failures.push(`declared as writers but not granted: ${missing.join(', ')}`)
      if (extra.length > 0) failures.push(`granted but not declared as writers: ${extra.join(', ')}`)
    }
  } else if (granted.length > 0) {
    failures.push(`${phase} expects every connector held, but a write grant is set for: ${granted.join(', ')}`)
  }
  const detail = { granted, states: Object.fromEntries(states), expectGranted }
  return failures.length === 0
    ? pass(phase === 'P2' ? `exactly the declared writers are granted (${granted.join(', ') || 'none'})` : 'every connector is held', detail)
    : fail(failures, detail)
}

// ---- invariant report ------------------------------------------------------------------------

type InvariantFindingLike = { severity: string; code: string; productId?: string; warehouseId?: string; orderId?: string; shipmentId?: string; refundId?: string; syncLogId?: string; message?: string }
type InvariantReportLike = { findings: InvariantFindingLike[]; truncated?: boolean; summary: { total: number; info: number; warning: number; critical: number } } | null

/** The slice of InvariantCheckPreflightResult the assessor reads. */
export type InvariantEvidence = {
  ok: boolean
  result: {
    status: string
    errors: unknown[]
    criticalFindings: unknown[]
    summary: { total: { critical: number; warning: number } }
    reports: { inventory: InvariantReportLike; accounting: InvariantReportLike; sales: InvariantReportLike }
  }
}

export const INVARIANT_TRUNCATED_CODE = 'invariant_report_truncated'
export const R3_CODE = 'stock_cost_layer_quantity_mismatch'
export const R4_CODE = 'stock_reserved_source_mismatch'

function findingSubject(finding: InvariantFindingLike): string {
  const parts = [
    finding.productId ? `product=${finding.productId}` : null,
    finding.warehouseId ? `warehouse=${finding.warehouseId}` : null,
    finding.orderId ? `order=${finding.orderId}` : null,
    finding.shipmentId ? `shipment=${finding.shipmentId}` : null,
    finding.refundId ? `refund=${finding.refundId}` : null,
    finding.syncLogId ? `syncLog=${finding.syncLogId}` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(',') : '-'
}

export function invariantWarningId(domain: string, finding: InvariantFindingLike): string {
  return `invariant:${domain}:${finding.code}:${findingSubject(finding)}`
}

export function assessInvariantReport(evidence: InvariantEvidence): CheckResult {
  const failures: string[] = []
  const { result } = evidence
  if (result.status !== 'completed') failures.push(`the invariant check status is ${JSON.stringify(result.status)}, not completed`)
  if (result.errors.length > 0) failures.push(`${result.errors.length} invariant report(s) errored`)
  if (!evidence.ok) failures.push('the invariant preflight itself did not pass')
  if (result.summary.total.critical > 0 || result.criticalFindings.length > 0) failures.push(`${Math.max(result.summary.total.critical, result.criticalFindings.length)} critical finding(s)`)

  const warnings: GateWarning[] = []
  let warningFindings = 0
  const domains = ['inventory', 'accounting', 'sales'] as const
  for (const domain of domains) {
    const report = result.reports[domain]
    if (report === null || report === undefined) {
      failures.push(`the ${domain} invariant report is absent, so it did not run to completion`)
      continue
    }
    if (report.truncated === true) failures.push(`the ${domain} invariant report is truncated`)
    for (const finding of report.findings) {
      if (finding.code === INVARIANT_TRUNCATED_CODE) failures.push(`the ${domain} report carries ${INVARIANT_TRUNCATED_CODE}: it did not finish`)
      if (finding.severity === 'critical') continue
      if (finding.severity === 'info') continue
      if (finding.severity === 'warning') {
        warningFindings += 1
        const id = invariantWarningId(domain, finding)
        if (!warnings.some((existing) => existing.id === id)) warnings.push({ id, message: finding.message ?? `${domain} warning ${finding.code}` })
        continue
      }
      failures.push(`the ${domain} report has a finding with unknown severity ${JSON.stringify(finding.severity)} (${finding.code})`)
    }
  }
  // Every warning must be ENUMERATED to be accepted one by one. A summary that counts more warnings than
  // the findings listed means some are not visible, so they could not have been individually read.
  if (result.summary.total.warning !== warningFindings) {
    failures.push(`the summary counts ${result.summary.total.warning} warning(s) but ${warningFindings} were listed, so the warnings are not fully enumerated`)
  }
  const detail = { status: result.status, critical: result.summary.total.critical, warningFindings, distinctWarnings: warnings.length }
  return failures.length === 0
    ? pass(`all three invariant reports completed; no critical findings; ${warnings.length} warning(s) to accept`, detail, warnings)
    : fail(failures, detail, warnings)
}

/** Pack items R3, R4 and R15 are read from the invariant report this gate already holds. */
export function derivePackItemFromInvariant(item: 'R3' | 'R4' | 'R15', evidence: InvariantEvidence | null, invariantResult: CheckResult): CheckResult {
  if (item === 'R15') {
    if (invariantResult.kind === 'pass') return pass('the invariant report has zero critical findings and every warning is listed for acceptance')
    if (invariantResult.kind === 'unreadable') return unreadable(`the invariant report could not be read: ${invariantResult.reason}`)
    if (invariantResult.kind === 'not-available') return unreadable('the invariant report was not available')
    return fail(['the invariant check did not pass'])
  }
  if (evidence === null) return unreadable('the invariant report could not be read, so this item cannot be established')
  const code = item === 'R3' ? R3_CODE : R4_CODE
  const domains = ['inventory', 'accounting', 'sales'] as const
  let reportsRead = 0
  const hits: string[] = []
  for (const domain of domains) {
    const report = evidence.result.reports[domain]
    if (!report) return unreadable(`the ${domain} invariant report is absent, so this item cannot be established`)
    reportsRead += 1
    for (const finding of report.findings) if (finding.code === code) hits.push(`${domain}:${findingSubject(finding)}`)
  }
  if (evidence.result.reports.inventory?.truncated === true) return unreadable('the inventory invariant report is truncated, so this item cannot be established')
  return hits.length === 0
    ? pass(`no ${code} finding in ${reportsRead} reports`, { code, reportsRead })
    : fail([`${hits.length} ${code} finding(s); this item must be exact`], { code, subjects: hits.slice(0, 20) })
}

// ---- first-install rehearsal -----------------------------------------------------------------

/** A rehearsal report as found on disk. `digest` is the outcome of verifyPublishedReport. */
export type RehearsalEvidence = { digest: { ok: true } | { ok: false; reason: string }; parsed: unknown; location: string }

export function assessRehearsalReport(evidence: RehearsalEvidence, now: Date, gateBuild: BuildIdentity | { unreadable: string }): CheckResult {
  if ('unreadable' in gateBuild) return unreadable(`${BUILD_IDENTITY_TEXT.gateUnreadable}: ${gateBuild.unreadable}`)
  if (!evidence.digest.ok) return fail([`the newest rehearsal report ${evidence.location} does not verify: ${evidence.digest.reason}`], { location: evidence.location })
  const failures: string[] = []
  const report = evidence.parsed as Partial<RehearsalReport> | null
  if (report === null || typeof report !== 'object') return unreadable(`the newest rehearsal report ${evidence.location} is not a JSON object`)
  if (report.tool !== 'rehearse-first-install') failures.push(`the report's tool is ${JSON.stringify(report.tool)}, not rehearse-first-install`)
  const buildWarnings: GateWarning[] = []
  const version = report.schemaVersion as unknown
  if (version === 1) failures.push(BUILD_IDENTITY_TEXT.absent)
  else if (version !== 2) failures.push(`the report's schemaVersion is ${JSON.stringify(version)}, not 2`)
  // THE REPORT MUST BE ABOUT THIS BUILD. A GREEN rehearsal of another commit says nothing about this one.
  if (version === 2) {
    const build = compareBuildIdentity((report as { build?: unknown }).build, gateBuild)
    if (!build.ok) failures.push(build.message)
    else buildWarnings.push(...build.warnings)
  }
  if (report.verdict !== 'GREEN') failures.push(`the rehearsal verdict is ${JSON.stringify(report.verdict)}, not GREEN`)
  if (report.exitCode !== 0) failures.push(`the rehearsal exit code is ${JSON.stringify(report.exitCode)}, not 0`)
  if (report.interrupted !== null && report.interrupted !== undefined) failures.push(`the rehearsal was interrupted (${String(report.interrupted)})`)

  // Do not trust the verdict field alone: judge the steps and the teardown themselves. Every catalogue step must be
  // present exactly once, required AND passed, which is strictly stronger than the rehearsal's own isRed(steps).
  const steps = Array.isArray(report.steps) ? report.steps : null
  if (steps === null) failures.push('the report has no steps list')
  else {
    for (const definition of STEP_CATALOGUE) {
      const mine = steps.filter((step) => step?.id === definition.id)
      if (mine.length !== 1) failures.push(`step ${definition.id} appears ${mine.length} times, expected exactly once`)
      else if (mine[0]!.status !== 'passed') failures.push(`step ${definition.id} is ${JSON.stringify(mine[0]!.status)}, not passed`)
      else if (mine[0]!.required !== true) failures.push(`step ${definition.id} passed but was not a required step (a rehearsal that skipped it before it existed does not cover it)`)
    }
    for (const step of steps) {
      if (!STEP_CATALOGUE.some((definition) => definition.id === step?.id)) failures.push(`the report has an unknown step ${String(step?.id)}`)
    }
  }
  if (!report.teardown || typeof report.teardown !== 'object') failures.push('the report has no teardown record')
  else if (teardownIncomplete(report.teardown)) failures.push('the rehearsal teardown was incomplete')

  const finishedAt = typeof report.finishedAt === 'string' ? Date.parse(report.finishedAt) : Number.NaN
  let ageDays: number | null = null
  if (!Number.isFinite(finishedAt)) failures.push('the report has no readable finishedAt')
  else {
    const ageMs = now.getTime() - finishedAt
    ageDays = Math.round((ageMs / DAY_MS) * 10) / 10
    if (ageMs < -REHEARSAL_CLOCK_SKEW_MS) failures.push(`the report claims to have finished in the future (${report.finishedAt})`)
    else if (ageMs > REHEARSAL_MAX_AGE_DAYS * DAY_MS) failures.push(`the newest rehearsal finished ${ageDays} days ago, which is older than the ${REHEARSAL_MAX_AGE_DAYS} days allowed`)
  }
  const detail = { location: evidence.location, runId: report.runId ?? null, finishedAt: report.finishedAt ?? null, ageDays, steps: steps?.length ?? null }
  return failures.length === 0
    ? pass(`GREEN, all ${STEP_CATALOGUE.length} steps required and passed, finished ${ageDays} days ago. ${BUILD_SCOPE_TEXT}`, detail, buildWarnings)
    : fail(failures, detail, buildWarnings)
}

// ---- read-sync liveness ------------------------------------------------------------------------

/**
 * Every field the verdict depends on must be PRESENT with the right type. A producer that drops or renames one is a
 * contract change this gate was not written against, so the output is unreadable (NO-GO), never "fresh by default".
 * Returns the first problem, or null.
 */
export function readSyncShapeProblem(parsed: unknown): string | null {
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string')
  if (!isObject(parsed)) return 'not a JSON object'
  if (parsed.schemaVersion !== READ_SYNC_SCHEMA_VERSION) return `schemaVersion is not ${READ_SYNC_SCHEMA_VERSION}, so the meaning of its fields is not the one this gate was written against`
  if (typeof parsed.generatedAt !== 'string' || !ISO_RE.test(parsed.generatedAt) || !Number.isFinite(Date.parse(parsed.generatedAt))) return 'generatedAt is missing or not an ISO time'
  const counts = parsed.counts
  if (!isObject(counts) || !['fresh', 'stale', 'never', 'off'].every((state) => Number.isInteger(counts[state]) && (counts[state] as number) >= 0)) return 'counts is missing or does not carry fresh, stale, never and off as whole numbers'
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return 'entries is missing or empty (an empty list proves nothing is fresh)'
  for (const [index, raw] of parsed.entries.entries()) {
    if (!isObject(raw)) return `entries[${index}] is not an object`
    if (typeof raw.stream !== 'string' || raw.stream === '') return `entries[${index}] has no stream name`
    if (!('instance' in raw) || (raw.instance !== null && typeof raw.instance !== 'string')) return `entries[${index}] (${raw.stream}) has no instance (null or a string)`
    if (typeof raw.state !== 'string' || !['fresh', 'stale', 'never', 'off'].includes(raw.state)) return `entries[${index}] (${raw.stream}) has an unrecognised state ${JSON.stringify(raw.state)}`
    if (!('lastSuccessAt' in raw) || (raw.lastSuccessAt !== null && typeof raw.lastSuccessAt !== 'string')) return `entries[${index}] (${raw.stream}) has no lastSuccessAt (null or a string)`
    if (!('ageMs' in raw) || (raw.ageMs !== null && typeof raw.ageMs !== 'number')) return `entries[${index}] (${raw.stream}) has no ageMs (null or a number)`
    if (!('maxAgeMs' in raw) || (raw.maxAgeMs !== null && typeof raw.maxAgeMs !== 'number')) return `entries[${index}] (${raw.stream}) has no maxAgeMs (null or a number)`
    if (typeof raw.futureTimestamp !== 'boolean') return `entries[${index}] (${raw.stream}) has no futureTimestamp flag`
  }
  const scheduler = parsed.scheduler
  if (!isObject(scheduler)) return 'scheduler is missing'
  if (typeof scheduler.examined !== 'boolean') return 'scheduler.examined is missing'
  if (!('unreadable' in scheduler) || (scheduler.unreadable !== null && typeof scheduler.unreadable !== 'string')) return 'scheduler.unreadable is missing (null or a string)'
  if (!('blockProblem' in scheduler) || (scheduler.blockProblem !== null && typeof scheduler.blockProblem !== 'string')) return 'scheduler.blockProblem is missing (null or a string)'
  if (!stringArray(scheduler.unscheduled)) return 'scheduler.unscheduled is missing (a list)'
  if (!stringArray(scheduler.disabled)) return 'scheduler.disabled is missing (a list)'
  return null
}

/** How far ahead of the gate's clock a recorded success may be before it is not believed (clock skew). */
export const READ_SYNC_FUTURE_TOLERANCE_MS = 5 * 60_000
export const READ_SYNC_GENERATED_TOLERANCE_MS = 10 * 60_000
export const READ_SYNC_AGE_TOLERANCE_MS = 1_000

/**
 * Strict reading of `npm run --silent read-sync:status` under READ_SYNC_CONTRACT_VERSION. A stream passes only
 * with a valid, parseable, not-future `lastSuccessAt`, state `fresh`, and an age inside the `maxAgeMs` it
 * reports; every stream of the REQUIRED catalogue must appear (a stream missing from the output is
 * not "fine", it is unproven); an unknown stream name, a duplicate instance, a scheduler that was not
 * examined or has unscheduled jobs, or any other state ("stale", "never", "off") fails.
 */
export function assessReadSyncStatus(run: { exitCode: number | null; stdout: string }, now: Date): CheckResult {
  if (run.exitCode !== 0) return unreadable(`the read-sync status command exited ${run.exitCode}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return unreadable('the read-sync status output is not one JSON object')
  }
  const shape = readSyncShapeProblem(parsed)
  if (shape !== null) return unreadable(`the read-sync status output does not have the shape this gate was written against: ${shape}`)
  const root = parsed as {
    generatedAt: string
    counts: Record<string, number>
    entries: Array<{ stream: string; instance: string | null; state: string; lastSuccessAt: string | null; ageMs: number | null; maxAgeMs: number | null; futureTimestamp: boolean }>
    scheduler: { examined: boolean; unreadable: string | null; blockProblem: string | null; unscheduled: string[]; disabled: string[] }
  }
  const generated = Date.parse(root.generatedAt)
  const problems: string[] = []
  if (Math.abs(now.getTime() - generated) > READ_SYNC_GENERATED_TOLERANCE_MS) problems.push(`the read-sync status says it was generated at ${root.generatedAt}, which is not now`)
  const seen = new Set<string>()
  const streams = new Set<string>()
  const tally: Record<string, number> = { fresh: 0, stale: 0, never: 0, off: 0 }
  for (const entry of root.entries) {
    const name = entry.stream
    tally[entry.state] = (tally[entry.state] ?? 0) + 1
    if (!(REQUIRED_READ_SYNC_STREAMS as readonly string[]).includes(name)) { problems.push(`read-sync reports a stream ${name} that is not in the required catalogue`); continue }
    const key = `${name}/${entry.instance ?? ''}`
    if (seen.has(key)) return unreadable(`read-sync entry ${key} is listed twice`)
    seen.add(key)
    streams.add(name)
    if (entry.state !== 'fresh') { problems.push(`stream ${key} is ${JSON.stringify(entry.state)}, not fresh`); continue }
    const at = entry.lastSuccessAt !== null && ISO_RE.test(entry.lastSuccessAt) ? Date.parse(entry.lastSuccessAt) : Number.NaN
    if (!Number.isFinite(at)) { problems.push(`stream ${key} is marked fresh but has no valid lastSuccessAt`); continue }
    const future = at > generated + READ_SYNC_FUTURE_TOLERANCE_MS
    if (future || entry.futureTimestamp) { problems.push(`stream ${key} has a lastSuccessAt later than the clock (${entry.lastSuccessAt})`); continue }
    if (entry.ageMs === null || Math.abs(entry.ageMs - (generated - at)) > READ_SYNC_AGE_TOLERANCE_MS) { problems.push(`stream ${key} reports an age that does not match its lastSuccessAt and the report time`); continue }
    if (entry.maxAgeMs === null || !(entry.maxAgeMs > 0)) { problems.push(`stream ${key} reports no age limit`); continue }
    if (generated - at >= entry.maxAgeMs) problems.push(`stream ${key} last succeeded at ${entry.lastSuccessAt}, older than its limit`)
  }
  if (Object.keys(tally).some((state) => root.counts[state] !== tally[state])) problems.push('the read-sync counts do not match the entries they summarise')
  for (const required of REQUIRED_READ_SYNC_STREAMS) {
    if (!streams.has(required)) problems.push(`required stream ${required} is missing from the read-sync status output`)
  }
  const scheduler = root.scheduler
  if (!scheduler.examined) problems.push('the read-sync status did not examine the scheduler')
  if (scheduler.unreadable !== null) problems.push('the read-sync scheduler check could not read the crontab')
  if (scheduler.blockProblem !== null) problems.push('the managed crontab block has a problem, so the scheduled jobs may not run')
  if (scheduler.unscheduled.length > 0) problems.push('a job behind a read-sync stream has no managed crontab entry')
  if (scheduler.disabled.length > 0) problems.push('a job behind a read-sync stream is disabled in the crontab')
  const detail = { streams: [...streams].sort(), entries: seen.size }
  return problems.length === 0 ? pass(`${seen.size} entries across ${streams.size} required streams, each fresh with a valid last success`, detail) : fail(problems, detail)
}

// ---------------------------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------------------------

export type GateReport = {
  schemaVersion: 1
  tool: 'readiness-gate'
  runId: string
  generatedAt: string
  phase: ReadinessPhase
  expectGranted: string[] | null
  verdict: ReadinessVerdict
  exitCode: number
  checks: CheckRow[]
  warnings: Array<{ id: string; checkId: string; message: string; accepted: boolean; acceptance?: { by: string; at: string; expiresAt: string; reason: string }; why?: string }>
  unusedAcceptances: string[]
  acceptanceFile: { path: string | null; status: AcceptanceFile['status']; problems: string[] }
  blockingReasons: string[]
  notYetAvailable: string[]
  notes: string[]
}

export function buildGateReport(params: {
  runId: string
  now: Date
  phase: ReadinessPhase
  expectGranted: string[] | null
  verdict: Verdict
  acceptances: AcceptanceFile
  acceptancePath: string | null
  notes?: string[]
}): GateReport {
  const { verdict } = params
  return {
    schemaVersion: 1,
    tool: 'readiness-gate',
    runId: params.runId,
    generatedAt: params.now.toISOString(),
    phase: params.phase,
    expectGranted: params.expectGranted,
    verdict: verdict.verdict,
    exitCode: verdict.exitCode,
    checks: verdict.rows,
    warnings: verdict.warnings.map((warning) => ({
      id: warning.id,
      checkId: warning.checkId,
      message: warning.message,
      accepted: warning.disposition.accepted,
      ...(warning.disposition.accepted
        ? { acceptance: { by: warning.disposition.by, at: warning.disposition.at, expiresAt: warning.disposition.expiresAt, reason: warning.disposition.reason } }
        : { why: warning.disposition.why }),
    })),
    unusedAcceptances: verdict.unusedAcceptances,
    acceptanceFile: { path: params.acceptancePath, status: params.acceptances.status, problems: params.acceptances.problems },
    blockingReasons: verdict.blockingReasons,
    notYetAvailable: verdict.notYetAvailable,
    notes: params.notes ?? [],
  }
}

function cell(value: unknown): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

const MARKDOWN_WARNING_LIMIT = 50

/** What a GO does and does not establish, said once and carried by every report. */
export function verdictStatement(report: Pick<GateReport, 'verdict' | 'phase' | 'notYetAvailable'>): string {
  const unavailable = report.notYetAvailable.length > 0
    ? ` ${report.notYetAvailable.length} item(s) listed as NOT YET AVAILABLE were not checked at all: ${report.notYetAvailable.join(', ')}.`
    : ''
  switch (report.verdict) {
    case 'NO-GO':
      return `NO-GO for ${report.phase}: at least one reason below stops it. ${SCHEMA_CHECKS_RAN_TEXT}${unavailable}`
    case 'GO':
      return `GO for ${report.phase}: every check this gate defines as required for ${report.phase} passed against the database and environment it was run with, at the time stated. It says nothing about checks that are not listed as passed. ${BUILD_SCOPE_TEXT}${unavailable}`
    case 'GO-WITH-ACCEPTED-WARNINGS':
      return `GO-WITH-ACCEPTED-WARNINGS for ${report.phase}: every required check passed and each warning below is covered by a current written acceptance, which is a person's decision recorded in the acceptance file, not a finding that the warning is harmless. ${BUILD_SCOPE_TEXT}${unavailable}`
    default: {
      const never: never = report.verdict
      return never
    }
  }
}

export function renderGateMarkdown(report: GateReport): string {
  const lines: string[] = []
  lines.push(`# Readiness gate: ${report.verdict} (${report.phase})`)
  lines.push('')
  lines.push(verdictStatement(report))
  lines.push('')
  lines.push(`- Run: \`${report.runId}\`; generated ${report.generatedAt}`)
  lines.push(`- Exit code: ${report.exitCode} (${READINESS_GATE_EXIT_CODES.find((row) => row.code === report.exitCode)?.name ?? 'unknown'})`)
  lines.push(`- Declared P2 writers: ${report.expectGranted === null ? 'not applicable' : report.expectGranted.join(', ') || 'none'}`)
  lines.push(`- Acceptance file: ${report.acceptanceFile.path ?? 'none'} (${report.acceptanceFile.status})`)
  for (const problem of report.acceptanceFile.problems) lines.push(`  - ${problem}`)
  lines.push('')
  if (report.blockingReasons.length > 0) {
    lines.push('## Why NO-GO')
    lines.push('')
    for (const reason of report.blockingReasons) lines.push(`- ${cell(reason)}`)
    lines.push('')
  }
  lines.push('## Checks')
  lines.push('')
  lines.push('| Check | Requirement | Result | Detail |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of report.checks) {
    lines.push(`| ${cell(row.title)} | ${row.requirement ?? '-'} | ${row.status}${row.blocking ? ' (blocks)' : ''} | ${cell(row.summary)} |`)
  }
  lines.push('')
  if (report.warnings.length > 0) {
    lines.push(`## Warnings (${report.warnings.length})`)
    lines.push('')
    lines.push('| Warning id | Accepted | By / until, or why not |')
    lines.push('| --- | --- | --- |')
    for (const warning of report.warnings.slice(0, MARKDOWN_WARNING_LIMIT)) {
      lines.push(`| ${cell(warning.id)} | ${warning.accepted ? 'yes' : 'NO'} | ${warning.accepted ? cell(`${warning.acceptance!.by} until ${warning.acceptance!.expiresAt}: ${warning.acceptance!.reason}`) : cell(warning.why ?? '')} |`)
    }
    if (report.warnings.length > MARKDOWN_WARNING_LIMIT) lines.push(`| ... | | ${report.warnings.length - MARKDOWN_WARNING_LIMIT} more warning(s); the JSON report lists all of them |`)
    lines.push('')
  }
  if (report.unusedAcceptances.length > 0) {
    lines.push('## Acceptances that name no warning raised in this run')
    lines.push('')
    for (const id of report.unusedAcceptances) lines.push(`- ${cell(id)}`)
    lines.push('')
  }
  if (report.notes.length > 0) {
    lines.push('## Notes')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${cell(note)}`)
    lines.push('')
  }
  return lines.join('\n')
}

