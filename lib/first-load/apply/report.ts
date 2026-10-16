/**
 * The apply report: JSON for machines, Markdown for people. Pure and deterministic: everything in it comes from its arguments (the
 * caller supplies the window times), steps follow load order and rows are sorted by key.
 */
import { APPLY_EXIT_CODES, APPLY_REPORT_FORMAT_VERSION, exitOperatorText, type ApplyMode } from './constants'
import type { ApplyResult, StepResult } from './orchestrate'
import type { PreparedRun } from './prepared'

export interface PreconditionResult {
  id: string
  result: 'pass' | 'refused' | 'not-applicable'
  detail: string
}

export interface ApplyReport {
  tool: 'first-load-apply'
  formatVersion: typeof APPLY_REPORT_FORMAT_VERSION
  runId: string
  manifestDigest: string
  mode: ApplyMode
  exit: { code: number; name: string; operatorText: string }
  prepared: {
    reportSha256: string
    outputs: Array<{ name: string; sha256: string }>
    notSelected: string[]
    variantParents: { csvSha256: string; snapshotPayloadSha256: string } | null
    zeroCostAccepted: string[]
    warehouses: string[]
  }
  preconditions: PreconditionResult[]
  steps: Array<Omit<StepResult, 'rows'> & { rows: StepResult['rows'] }>
  /** The accounting identity per step, restated: emitted = created + updated + skippedExisting + failed. */
  accountingBalanced: boolean
  verification: ApplyResult['verification']
  problems: string[]
  window: { start: string; end: string } | null
}

export function buildApplyReport(args: { prepared: PreparedRun; result: ApplyResult; preconditions?: PreconditionResult[]; window?: { start: string; end: string } | null }): ApplyReport {
  const { prepared, result } = args
  const exitName = result.exit
  return {
    tool: 'first-load-apply',
    formatVersion: APPLY_REPORT_FORMAT_VERSION,
    runId: prepared.manifest.runId,
    manifestDigest: prepared.manifestDigest,
    mode: result.mode,
    exit: { code: APPLY_EXIT_CODES[exitName], name: exitName, operatorText: exitOperatorText(exitName) },
    prepared: {
      reportSha256: prepared.reportSha256,
      outputs: prepared.outputs,
      notSelected: prepared.notSelected,
      variantParents: prepared.variantParents,
      zeroCostAccepted: prepared.manifest.acceptZeroCost,
      warehouses: prepared.warehouseCodes,
    },
    preconditions: args.preconditions ?? [],
    steps: result.steps,
    accountingBalanced: result.steps.every((s) => s.emitted === s.created + s.updated + s.skippedExisting + s.failed),
    verification: result.verification,
    problems: result.problems,
    window: args.window ?? null,
  }
}

export function renderApplyJson(report: ApplyReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function table(header: string[], rows: Array<Array<string | number>>): string[] {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)]
}

const MAX_LISTED = 100

export function renderApplyMarkdown(report: ApplyReport): string {
  const out: string[] = ['# First-load apply report', '']
  out.push(`- Run id: ${report.runId}`, `- Mode: ${report.mode}`, `- Load digest: ${report.manifestDigest}`)
  out.push(`- Result: **${report.exit.name}** (exit ${report.exit.code})`)
  if (report.exit.operatorText !== '') out.push(`- ${report.exit.operatorText}`)
  out.push('')
  if (report.problems.length > 0) out.push('## Problems', '', ...report.problems.map((p) => `- ${p}`), '')
  out.push('## Prepared run', '', `- Prepared report SHA-256: ${report.prepared.reportSha256}`, `- Steps not selected: ${report.prepared.notSelected.join(', ') || 'none'}`)
  out.push(`- Variant parents bound to a verified WooCommerce snapshot: ${report.prepared.variantParents ? 'yes' : 'not used'}`, `- Zero-cost pairs accepted by the operator: ${report.prepared.zeroCostAccepted.length}`, '')
  out.push(...table(['File', 'SHA-256'], report.prepared.outputs.map((o) => [o.name, o.sha256])), '')
  out.push('## Steps', '')
  out.push(...table(['Step', 'Status', 'Emitted', 'Created', 'Updated', 'Skipped (existing)', 'Failed', 'To load'], report.steps.map((s) => [s.step, s.status, s.emitted, s.created, s.updated, s.skippedExisting, s.failed, s.toLoad])), '')
  out.push(report.accountingBalanced ? 'The identity emitted = created + updated + skipped (existing) + failed holds for every step.' : '**The row-accounting identity FAILED.** This is a defect in the runner.', '')
  for (const step of report.steps) {
    if (step.conflicts.length > 0) out.push(`### Conflicts in ${step.step}`, '', ...table(['Key', 'Code', 'Detail'], step.conflicts.slice(0, MAX_LISTED).map((c) => [c.key, c.code, c.detail])), '', ...(step.conflicts.length > MAX_LISTED ? [`${step.conflicts.length - MAX_LISTED} more: see the JSON report.`, ''] : []))
    if (step.counterFindings.length > 0) out.push(`### Counter cross-check in ${step.step}`, '', ...step.counterFindings.map((f) => `- ${f}`), '')
    const errors = step.importer.flatMap((i) => i.errors.map((e) => `${i.file}: ${e}`))
    if (errors.length > 0) out.push(`### Importer messages in ${step.step} (verbatim)`, '', ...errors.slice(0, MAX_LISTED).map((e) => `- ${e}`), '', ...(errors.length > MAX_LISTED ? [`${errors.length - MAX_LISTED} more: see the JSON report.`, ''] : []))
  }
  if (report.verification.length > 0) out.push('## Verification', '', ...table(['Check', 'Result', 'Expected', 'Actual'], report.verification.map((v) => [v.id, v.result, v.expected, v.actual])), '')
  if (report.preconditions.length > 0) out.push('## Preconditions', '', ...table(['Id', 'Result', 'Detail'], report.preconditions.map((p) => [p.id, p.result, p.detail])), '')
  return `${out.join('\n')}\n`
}
